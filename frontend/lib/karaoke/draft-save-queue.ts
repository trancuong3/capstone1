import { isServiceError } from "@/lib/api/service-error";
import type { AdminKaraokeService } from "@/lib/api/admin-karaoke-service";
import {
  karaokeMetadataSchema,
  lyricsSchema,
  type AdminKaraokeDetail,
  type KaraokeMetadata,
  type KaraokeLyrics,
} from "@/types/karaoke";

export type DraftSnapshot = KaraokeMetadata & { lyrics: KaraokeLyrics };
export type AutosaveState =
  "idle" | "dirty" | "saving" | "saved" | "invalid" | "error" | "conflict";
export type AutosaveView = {
  state: AutosaveState;
  detail: AdminKaraokeDetail;
  generation: number;
  dirty: boolean;
  busy: boolean;
  lastSavedAt: number | null;
  error: unknown;
};
const snapshotSchema = karaokeMetadataSchema
  .extend({ lyrics: lyricsSchema })
  .refine((s) => s.min_grade <= s.max_grade);
function snapshotKey(snapshot: DraftSnapshot) {
  const parsed = snapshotSchema.parse(snapshot);
  return JSON.stringify({
    ...parsed,
    title: parsed.title.normalize("NFC").trim(),
    author: parsed.author.normalize("NFC").trim(),
    source_note: parsed.source_note.normalize("NFC").trim(),
    usage_note: parsed.usage_note.normalize("NFC").trim(),
  });
}
function detailKey(detail: AdminKaraokeDetail) {
  if (!detail.draft) throw new Error("Cần bản nháp để lưu.");
  return snapshotKey(detail.draft);
}

/** One view owns one queue. GET polling never adopts a mutable draft implicitly. */
export class KaraokeDraftSaveQueue {
  private view: AutosaveView;
  private listeners = new Set<() => void>();
  private pending: { generation: number; snapshot: DraftSnapshot } | null =
    null;
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller = new AbortController();
  private active = true;
  private disposed = false;
  private blocked = false;
  private queued = 0;
  constructor(
    initial: AdminKaraokeDetail,
    private service: Pick<AdminKaraokeService, "save">,
    private debounceMs = 800,
  ) {
    this.view = {
      state: "idle",
      detail: structuredClone(initial),
      generation: 0,
      dirty: false,
      busy: false,
      lastSavedAt: null,
      error: null,
    };
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<AutosaveView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private guard() {
    if (this.disposed || !this.active)
      throw new Error("Trang đã đóng; hãy đối chiếu bản đã lưu khi mở lại.");
    if (this.blocked) throw this.view.error;
  }
  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private fail(error: unknown) {
    this.clearTimer();
    const status = isServiceError(error) ? error.status : undefined;
    this.blocked = true;
    this.set({
      state: status === 409 ? "conflict" : status === 422 ? "invalid" : "error",
      error,
    });
  }
  updateSnapshot = (snapshot: DraftSnapshot) => {
    if (this.disposed || !this.active) return;
    this.clearTimer();
    const generation = this.view.generation + 1;
    // Snapshot is detached from React state. Later edits cannot mutate an in-flight body.
    this.pending = { generation, snapshot: structuredClone(snapshot) };
    this.set({ generation, dirty: true });
    if (this.blocked && this.view.state !== "invalid") return;
    this.blocked = false;
    try {
      snapshotKey(snapshot);
    } catch (error) {
      this.blocked = true;
      this.set({ state: "invalid", error });
      return;
    }
    this.set({ state: this.view.busy ? "saving" : "dirty", error: null });
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, this.debounceMs);
  };
  private serial<T>(task: () => Promise<T>): Promise<T> {
    this.queued++;
    this.set({ busy: true });
    const run = this.tail.then(async () => {
      this.guard();
      return task();
    });
    const result = run.finally(() => {
      this.queued--;
      this.set({ busy: this.queued > 0 });
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private checkIdentity(detail: AdminKaraokeDetail, allowPublished = false) {
    const draftId = this.view.detail.draft?.id;
    const sameVersion =
      detail.draft?.id === draftId ||
      (allowPublished &&
        !!draftId &&
        detail.draft === null &&
        detail.published?.id === draftId);
    if (
      detail.song_id !== this.view.detail.song_id ||
      !sameVersion ||
      detail.revision < this.view.detail.revision
    )
      throw new Error("Bản phản hồi không khớp bản nháp hiện tại.");
  }
  private async drain() {
    this.clearTimer();
    this.guard();
    while (this.pending) {
      const item = this.pending;
      const draft = this.view.detail.draft;
      if (!draft) throw new Error("Chưa có bản nháp.");
      this.set({ state: "saving" });
      try {
        const payload = snapshotSchema.parse(item.snapshot);
        const detail = await this.service.save(
          this.view.detail.song_id,
          {
            ...payload,
            expected_revision: this.view.detail.revision,
            draft_version_id: draft.id,
          },
          this.controller.signal,
        );
        this.guard();
        this.checkIdentity(detail);
        if (detailKey(detail) !== snapshotKey(payload))
          throw new Error("Chưa đối chiếu được nội dung đã lưu.");
        const latest = this.view.generation === item.generation;
        if (latest) this.pending = null;
        this.set({
          detail: structuredClone(detail),
          dirty: !latest,
          state: latest ? "saved" : "dirty",
          lastSavedAt: Date.now(),
          error: null,
        });
      } catch (error) {
        this.fail(error);
        throw error;
      }
    }
  }
  flush = () =>
    this.serial(async () => {
      await this.drain();
      return this.view.detail;
    });
  enqueueMutation = <T>(
    action: (
      detail: AdminKaraokeDetail,
      signal: AbortSignal,
    ) => Promise<{ value: T; detail?: AdminKaraokeDetail }>,
  ): Promise<T> =>
    this.serial(async () => {
      await this.drain();
      try {
        const result = await action(
          structuredClone(this.view.detail),
          this.controller.signal,
        );
        this.guard();
        if (result.detail) {
          this.checkIdentity(result.detail, true);
          this.set({ detail: structuredClone(result.detail) });
        }
        return result.value;
      } catch (error) {
        this.fail(error);
        throw error;
      }
    });
  /** Explicit recovery only. A new revision alone is never proof a lost write succeeded. */
  reconcile = (detail: AdminKaraokeDetail, discardLocal = false) => {
    if (this.queued || this.disposed || !this.active)
      throw new Error("Đợi yêu cầu đang chạy kết thúc trước khi đối chiếu.");
    this.checkIdentity(detail);
    if (
      this.pending &&
      !discardLocal &&
      detailKey(detail) !== snapshotKey(this.pending.snapshot)
    )
      throw new Error(
        "Nội dung máy chủ khác bản đang nhập. Hãy đối chiếu hoặc sao chép trước khi tải lại.",
      );
    this.clearTimer();
    this.pending = null;
    this.blocked = false;
    this.set({
      detail: structuredClone(detail),
      dirty: false,
      state: "saved",
      lastSavedAt: Date.now(),
      error: null,
    });
  };
  activate = () => {
    if (!this.disposed && !this.active) {
      this.active = true;
      this.controller = new AbortController();
    }
  };
  suspend = () => {
    this.active = false;
    this.clearTimer();
    this.controller.abort();
    if (this.queued)
      this.fail(
        new Error(
          "Yêu cầu đã dừng ở trình duyệt; chưa xác định trạng thái lưu trên máy chủ.",
        ),
      );
  };
  dispose = () => {
    this.suspend();
    this.disposed = true;
    this.listeners.clear();
  };
}
