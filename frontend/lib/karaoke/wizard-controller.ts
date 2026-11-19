import {
  karaokeErrorMessage,
  type AdminKaraokeService,
} from "@/lib/api/admin-karaoke-service";
import { isServiceError } from "@/lib/api/service-error";
import {
  KaraokeDraftSaveQueue,
  type AutosaveView,
} from "@/lib/karaoke/draft-save-queue";
import {
  KaraokeProcessingSession,
  type ProcessingView,
} from "@/lib/karaoke/processing-session";
import { prepareWizardLyrics } from "@/lib/karaoke/wizard-lyrics";
import {
  emptyKaraokeMetadata,
  karaokeMetadataSchema,
  type AdminKaraokeDetail,
  type KaraokeLyrics,
  type KaraokeMetadata,
  type KaraokePreview,
  type KaraokeSongCreate,
  type KaraokeValidation,
} from "@/types/karaoke";
import type {
  DraftReferencePreview,
  ProcessingCapabilities,
  ProcessingMode,
  ProcessingPreview,
} from "@/types/karaoke-processing";

export type WizardPreview =
  | { kind: "staging"; source: ProcessingPreview }
  | { kind: "draft"; source: KaraokePreview };
export type WizardView = {
  detail: AdminKaraokeDetail | null;
  metadata: KaraokeMetadata;
  lyrics: KaraokeLyrics;
  rawLyrics: string;
  file: File | null;
  reference: File | null;
  cover: File | null;
  mode: ProcessingMode;
  save: AutosaveView | null;
  processing: ProcessingView | null;
  busy: string;
  error: string;
  lyricsError: string;
  notice: string;
  preview: WizardPreview | null;
  referencePreview: DraftReferencePreview | null;
  referenceError: string;
  validation: KaraokeValidation | null;
  nowMs: number;
  edited: boolean;
  manualReviewed: boolean;
};
const metadataOf = (value: KaraokeMetadata): KaraokeMetadata =>
  karaokeMetadataSchema.parse(value);
const outstanding = (status?: string) =>
  !!status && ["QUEUED", "RUNNING", "READY", "NEEDS_REVIEW"].includes(status);
const emptyLyrics: KaraokeLyrics = { format_version: 2, lines: [] };

/** Owns /new through create ACK without replacing the route or losing File objects. */
export class KaraokeWizardController {
  private view: WizardView;
  private listeners = new Set<() => void>();
  private queue: KaraokeDraftSaveQueue | null = null;
  private processing: KaraokeProcessingSession | null = null;
  private active = false;
  private controller = new AbortController();
  private readController: AbortController | null = null;
  private readTicket = 0;
  private actionFlight = false;
  private creationIntent: KaraokeSongCreate | null = null;
  private rejectedUpload: {
    kind: "audio" | "reference" | "cover";
    file: File;
    before: AdminKaraokeDetail;
  } | null = null;
  private appliedSeen = "";
  private acceptApplied = false;
  private clock: ReturnType<typeof setInterval> | undefined;
  constructor(
    private service: AdminKaraokeService,
    readonly capabilities: ProcessingCapabilities | null,
    initial: AdminKaraokeDetail | null,
  ) {
    const version = initial?.draft ?? initial?.published;
    this.view = {
      detail: initial,
      metadata: version ? metadataOf(version) : { ...emptyKaraokeMetadata },
      lyrics: version?.lyrics ?? emptyLyrics,
      rawLyrics: version?.lyrics.lines.map((l) => l.text).join("\n") ?? "",
      file: null,
      reference: null,
      cover: null,
      mode: "VOCAL_TRACK",
      save: null,
      processing: null,
      busy: "",
      error: "",
      lyricsError: "",
      notice: "",
      preview: null,
      referencePreview: null,
      referenceError: "",
      validation: null,
      nowMs: Date.now(),
      edited: false,
      manualReviewed: false,
    };
    if (initial?.draft) this.attach(initial);
  }
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<WizardView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private attach(detail: AdminKaraokeDetail) {
    if (this.queue) throw new Error("Bản nháp đã có hàng đợi lưu.");
    const queue = new KaraokeDraftSaveQueue(detail, this.service);
    const processing = new KaraokeProcessingSession(this.service, queue);
    this.queue = queue;
    this.processing = processing;
    queue.subscribe(() => {
      const save = queue.getSnapshot();
      const changed = save.detail.revision !== this.view.detail?.revision;
      const sameAudio =
        !!save.detail.draft &&
        save.detail.draft.id === this.view.detail?.draft?.id &&
        save.detail.draft.audio_sha256 ===
          this.view.detail?.draft?.audio_sha256;
      this.set({
        save,
        detail: save.detail,
        ...(changed
          ? {
              preview:
                sameAudio && this.view.preview?.kind === "draft"
                  ? this.view.preview
                  : null,
              referencePreview: null,
              validation: null,
            }
          : {}),
      });
    });
    processing.subscribe(() => {
      const state = processing.getSnapshot();
      this.set({ processing: state });
      const applied =
        state.job?.status === "APPLIED"
          ? `${state.job.id}:${state.job.applied_revision}`
          : "";
      if (
        this.acceptApplied &&
        applied &&
        applied !== this.appliedSeen &&
        queue.getSnapshot().detail.draft
      ) {
        this.acceptApplied = false;
        this.appliedSeen = applied;
        this.acceptDraft(queue.getSnapshot().detail);
        this.set({
          notice:
            "Đã dùng kết quả trong bản nháp. Hãy nghe và kiểm tra trước khi xuất bản.",
        });
        void this.loadDraftPreview();
      }
    });
    this.set({
      detail,
      save: queue.getSnapshot(),
      processing: processing.getSnapshot(),
    });
    if (this.active) {
      queue.activate();
      processing.activate();
      this.resumeSavedJob();
    }
  }
  private resumeSavedJob() {
    const summary = this.view.detail?.processing_summary;
    if (summary && summary.draft_version_id === this.view.detail?.draft?.id)
      this.processing?.resume(summary.job_id, summary.draft_version_id);
  }
  activate = () => {
    this.active = true;
    this.controller = new AbortController();
    this.queue?.activate();
    this.processing?.activate();
    this.resumeSavedJob();
    this.clock = setInterval(() => {
      if (this.view.processing?.job?.status === "QUEUED")
        this.set({ nowMs: Date.now() });
    }, 5000);
  };
  suspend = () => {
    this.active = false;
    clearInterval(this.clock);
    this.controller.abort();
    this.readController?.abort();
    this.readTicket++;
    this.processing?.suspend();
    this.queue?.suspend();
  };
  isLocked = () =>
    !!this.view.busy ||
    !!this.view.processing?.action ||
    outstanding(
      this.view.processing?.job?.status ??
        this.view.detail?.processing_summary?.status,
    );
  hasUnsaved = () =>
    this.actionFlight ||
    !!this.view.file ||
    !!this.view.reference ||
    !!this.view.cover ||
    !!this.view.lyricsError ||
    !!this.view.save?.dirty ||
    (!this.view.detail && this.view.edited);
  canProcess = () =>
    !!this.capabilities?.enabled &&
    this.capabilities.configured &&
    this.capabilities.supported_modes.includes(this.view.mode);
  private changed(keepPreview = false) {
    this.readController?.abort();
    this.readTicket++;
    this.set({
      edited: true,
      error: "",
      preview: keepPreview ? this.view.preview : null,
      referencePreview: null,
      validation: null,
      notice: "",
      manualReviewed: false,
    });
  }
  private snapshot() {
    return { ...this.view.metadata, lyrics: this.view.lyrics };
  }
  private autosave() {
    if (!this.view.lyricsError) this.queue?.updateSnapshot(this.snapshot());
  }
  setMetadata = (metadata: KaraokeMetadata) => {
    if (this.isLocked()) return;
    this.changed();
    this.set({ metadata });
    this.autosave();
  };
  setMode = (mode: ProcessingMode) => {
    if (!this.isLocked()) {
      this.changed();
      this.set({ mode });
    }
  };
  setRawLyrics = (rawLyrics: string) => {
    if (this.isLocked()) return;
    this.changed();
    try {
      const lyrics = prepareWizardLyrics(
        rawLyrics,
        this.view.lyrics,
        this.view.detail?.draft?.duration_ms ?? null,
      );
      this.set({ rawLyrics, lyrics, lyricsError: "" });
      this.autosave();
    } catch (error) {
      this.set({
        rawLyrics,
        lyricsError:
          error instanceof Error ? error.message : "Lời chưa hợp lệ.",
      });
    }
  };
  setTimedLyrics = (lyrics: KaraokeLyrics) => {
    if (!this.isLocked()) {
      this.changed(true);
      this.set({
        lyrics,
        rawLyrics: lyrics.lines.map((l) => l.text).join("\n"),
        lyricsError: "",
      });
      this.autosave();
    }
  };
  chooseFile = (kind: "audio" | "reference" | "cover", file: File) => {
    if (this.isLocked()) return;
    const audio = kind !== "cover";
    const max = audio
      ? Math.min(
          this.capabilities?.limits.max_audio_bytes ?? 20971520,
          20971520,
        )
      : 2097152;
    if (
      !file.size ||
      file.size > max ||
      !(audio ? /\.mp3$/i : /\.(jpe?g|png|webp)$/i).test(file.name)
    ) {
      this.set({
        error: audio
          ? "Chọn MP3 không rỗng, tối đa 20 MiB và 5 phút."
          : "Chọn JPEG/PNG/WebP không rỗng, tối đa 2 MiB.",
      });
      return;
    }
    this.changed();
    this.set(
      kind === "audio"
        ? {
            file,
            metadata: this.view.metadata.title.trim()
              ? this.view.metadata
              : {
                  ...this.view.metadata,
                  title: file.name.replace(/\.mp3$/i, "").slice(0, 200),
                },
          }
        : kind === "reference"
          ? { reference: file }
          : { cover: file },
    );
  };
  private async run(label: string, action: () => Promise<void>) {
    if (this.actionFlight || !this.active) return;
    this.actionFlight = true;
    this.set({ busy: label, error: "", notice: "" });
    try {
      await action();
    } catch (error) {
      if (this.active)
        this.set({
          error: isServiceError(error)
            ? karaokeErrorMessage(error)
            : error instanceof Error
              ? error.message
              : "Chưa hoàn tất yêu cầu; nội dung được giữ lại.",
        });
    } finally {
      this.actionFlight = false;
      if (this.active) this.set({ busy: "" });
    }
  }
  private async upload(kind: "audio" | "reference" | "cover", file: File) {
    if (!this.queue) throw new Error("Chưa tạo bản nháp.");
    await this.queue.enqueueMutation(async (before, signal) => {
      if (!before.draft) throw new Error("Bản nháp không còn hiện hành.");
      let detail: AdminKaraokeDetail;
      try {
        detail =
          kind === "reference"
            ? await this.service.uploadReference(
                before.song_id,
                file,
                before.revision,
                before.draft.id,
                signal,
              )
            : await this.service.upload(
                before.song_id,
                kind,
                file,
                before.revision,
                before.draft.id,
                signal,
              );
      } catch (error) {
        if (isServiceError(error) && [413, 415, 422].includes(error.status))
          this.rejectedUpload = { kind, file, before };
        if (
          signal.aborted ||
          kind === "cover" ||
          !isServiceError(error) ||
          (error.status !== 0 && error.status < 500)
        )
          throw error;
        // A lost upload response may be recovered, never blindly retried.
        const hash = Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
          ),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        const recovered = await this.service.get(before.song_id, signal);
        const remoteHash =
          kind === "audio"
            ? recovered.draft?.audio_sha256
            : recovered.draft?.reference_audio_sha256;
        const previousHash =
          kind === "audio"
            ? before.draft.audio_sha256
            : before.draft.reference_audio_sha256;
        if (
          recovered.draft?.id !== before.draft.id ||
          recovered.revision !== before.revision + 1 ||
          remoteHash !== hash ||
          previousHash === hash ||
          JSON.stringify(metadataOf(recovered.draft)) !==
            JSON.stringify(metadataOf(before.draft))
        )
          throw error;
        detail = recovered;
      }
      return { value: detail, detail };
    });
    this.rejectedUpload = null;
    if (kind === "audio") {
      // Only after ACK/proven recovery: old marks cannot be rebound to a new recording.
      this.set({
        lyrics: {
          ...this.view.lyrics,
          lines: this.view.lyrics.lines.map((line) => ({
            ...line,
            start_ms: null,
            end_ms: null,
            ...(line.syllables
              ? {
                  syllables: line.syllables.map((unit) => ({
                    ...unit,
                    start_ms: null,
                    end_ms: null,
                  })),
                }
              : {}),
          })),
        },
      });
    }
    this.set(
      kind === "audio"
        ? { file: null }
        : kind === "reference"
          ? { reference: null }
          : { cover: null },
    );
  }
  createAndProcess = () =>
    this.run("Đang chuẩn bị bài hát…", async () => {
      if (!this.canProcess())
        throw new Error(
          "Tự động tạo karaoke chưa sẵn sàng. Bạn vẫn có thể dùng chỉnh sửa nâng cao.",
        );
      if (this.view.lyricsError || !this.view.rawLyrics.trim())
        throw new Error(
          this.view.lyricsError || "Hãy dán lời đúng với bản thu.",
        );
      if (!this.view.file && !this.view.detail?.draft?.has_audio)
        throw new Error("Hãy chọn bài MP3 có giọng hát.");
      if (
        this.view.mode === "INSTRUMENTAL_WITH_REFERENCE" &&
        !this.view.reference &&
        !this.view.detail?.draft?.has_reference_audio
      )
        throw new Error(
          "Hãy chọn bản hát đối chiếu cùng bản phối với nhạc nền.",
        );
      if (!this.view.detail) {
        this.creationIntent ??= {
          ...metadataOf(this.view.metadata),
          creation_request_id: crypto.randomUUID(),
        };
        const detail = await this.service.create(
          this.creationIntent,
          this.controller.signal,
        );
        if (!this.active) return;
        this.attach(detail);
      }
      if (!this.queue || !this.processing)
        throw new Error("Bản nháp chưa sẵn sàng.");
      const rejected = this.rejectedUpload;
      const replacement =
        rejected?.kind === "audio"
          ? this.view.file
          : rejected?.kind === "reference"
            ? this.view.reference
            : this.view.cover;
      const queueError = this.queue.getSnapshot().error;
      if (
        rejected &&
        replacement &&
        replacement !== rejected.file &&
        isServiceError(queueError) &&
        [413, 415, 422].includes(queueError.status)
      ) {
        // A new user-selected file after a definitive rejection, never an ambiguous timeout.
        const saved = await this.service.get(
          rejected.before.song_id,
          this.controller.signal,
        );
        if (
          saved.song_id !== rejected.before.song_id ||
          saved.revision !== rejected.before.revision ||
          JSON.stringify(saved.draft) !== JSON.stringify(rejected.before.draft)
        )
          throw new Error(
            "Bản trên máy chủ đã đổi. Nội dung đang nhập được giữ; hãy đối chiếu trước khi tiếp tục.",
          );
        this.queue.reconcile(saved, true);
        // Editable metadata/lyrics remain in this view and are saved after the new upload ACK.
        this.rejectedUpload = null;
      }
      const uploadedNewAudio = !!this.view.file;
      if (this.view.file) {
        this.set({ busy: "Đang tải nhạc lên…" });
        await this.upload("audio", this.view.file);
      }
      if (this.view.reference) {
        this.set({ busy: "Đang tải bản hát đối chiếu…" });
        await this.upload("reference", this.view.reference);
      }
      if (this.view.cover) {
        this.set({ busy: "Đang tải ảnh bìa…" });
        await this.upload("cover", this.view.cover);
      }
      if (!this.active) return;
      const lyrics =
        this.view.lyrics.format_version === 2
          ? this.view.lyrics
          : prepareWizardLyrics(
              this.view.rawLyrics,
              this.view.lyrics,
              this.view.detail?.draft?.duration_ms ?? null,
            );
      this.set({ lyrics, busy: "Đang lưu lời và gửi xử lý…" });
      this.queue.updateSnapshot(this.snapshot());
      await this.queue.flush();
      this.acceptApplied = true;
      await this.processing.start(
        this.view.mode,
        this.view.detail?.draft?.audio_sha256 &&
          this.view.detail.processing_review?.required &&
          this.view.mode === "VOCAL_TRACK" &&
          !uploadedNewAudio
          ? "ORIGINAL_RECORDING"
          : "DRAFT_AUDIO",
      );
    });
  flush = async () => {
    if (
      this.view.lyricsError ||
      this.view.file ||
      this.view.reference ||
      this.view.cover
    )
      throw new Error(
        "Còn lời chưa hợp lệ hoặc file chưa tải lên. Hãy hoàn tất hoặc bỏ lựa chọn file trước khi chuyển chế độ.",
      );
    if (this.queue) await this.queue.flush();
    else if (this.view.edited)
      throw new Error(
        "Bài chưa được lưu. Hãy tạo karaoke hoặc sao chép nội dung trước khi rời trang.",
      );
  };
  cancel = () =>
    this.run("Đang hủy xử lý…", async () => {
      try {
        await this.processing?.cancel();
      } catch (error) {
        if (isServiceError(error) && error.status === 409 && this.view.detail) {
          const current = await this.service.get(
            this.view.detail.song_id,
            this.controller.signal,
          );
          if (current.processing_summary?.status === "APPLIED") {
            this.set({
              notice:
                "Kết quả đã được áp dụng ở lượt khác. Hãy đối chiếu bản đã lưu, không có rollback tự động.",
            });
          }
        }
        throw error;
      }
    });
  retry = (ack: boolean) =>
    this.run("Đang gửi lượt thử lại…", async () => {
      this.acceptApplied = true;
      await this.processing?.retry(ack);
    });
  apply = () =>
    this.run("Đang dùng kết quả…", async () => {
      this.acceptApplied = true;
      await this.processing?.apply();
    });
  private acceptDraft(detail: AdminKaraokeDetail) {
    if (detail.draft)
      this.set({
        detail,
        metadata: metadataOf(detail.draft),
        lyrics: detail.draft.lyrics,
        rawLyrics: detail.draft.lyrics.lines.map((l) => l.text).join("\n"),
        lyricsError: "",
        edited: false,
      });
  }
  private readContext() {
    this.readController?.abort();
    this.readController = new AbortController();
    return { ticket: ++this.readTicket, signal: this.readController.signal };
  }
  loadStagingPreview = () =>
    this.run("Đang tải kết quả nghe thử…", async () => {
      const context = this.readContext();
      const job = this.view.processing?.job;
      if (!job || !this.processing) return;
      const source = await this.processing.getPreview(context.signal);
      if (
        this.active &&
        context.ticket === this.readTicket &&
        this.view.processing?.job?.id === job.id
      )
        this.set({
          preview: { kind: "staging", source },
          referencePreview: null,
          referenceError: "",
        });
    });
  loadDraftPreview = async () => {
    if (!this.queue || !this.active) return;
    if (
      this.view.file ||
      this.view.reference ||
      this.view.cover ||
      this.view.lyricsError
    ) {
      this.set({
        error:
          "Còn file chưa tải hoặc lời chưa hợp lệ. Hãy hoàn tất trước khi nghe bản nháp đã lưu.",
      });
      return;
    }
    const context = this.readContext();
    this.set({
      preview: null,
      referencePreview: null,
      validation: null,
      error: "",
    });
    try {
      const detail = await this.queue.flush();
      if (!detail.draft) return;
      const [source, validation] = await Promise.all([
        this.service.preview(
          detail.song_id,
          detail.revision,
          detail.draft.id,
          context.signal,
        ),
        this.service.validate(
          detail.song_id,
          detail.revision,
          detail.draft.id,
          context.signal,
        ),
      ]);
      if (
        this.active &&
        context.ticket === this.readTicket &&
        this.queue.getSnapshot().detail.revision === detail.revision &&
        !this.queue.getSnapshot().dirty
      )
        this.set({ preview: { kind: "draft", source }, validation });
    } catch (error) {
      if (
        this.active &&
        !context.signal.aborted &&
        context.ticket === this.readTicket
      )
        this.set({ error: karaokeErrorMessage(error) });
    }
  };
  loadReference = () =>
    this.run("Đang tải bản hát đối chiếu…", async () => {
      const detail = await this.queue?.flush();
      const fingerprint =
        detail?.processing_review?.current_content_fingerprint;
      if (!detail?.draft || !fingerprint) return;
      const context = this.readContext();
      this.set({ referenceError: "" });
      try {
        const referencePreview = await this.service.getDraftReferencePreview(
          detail.song_id,
          detail.revision,
          detail.draft.id,
          fingerprint,
          context.signal,
        );
        if (
          this.active &&
          context.ticket === this.readTicket &&
          this.queue?.getSnapshot().detail.revision === detail.revision
        )
          this.set({ referencePreview });
      } catch (error) {
        if (this.active && !context.signal.aborted)
          this.set({
            referenceError:
              isServiceError(error) && error.status === 422
                ? "Bản nháp chưa có bản hát đối chiếu. Bạn vẫn có thể nghe nhạc nền."
                : karaokeErrorMessage(error),
          });
      }
    });
  confirmReview = (ids: string[], listened: boolean) =>
    this.run("Đang xác nhận bản đã nghe…", async () => {
      if (!listened) throw new Error("Hãy nghe và xác nhận bản nháp hiện tại.");
      if (this.view.detail?.processing_review?.required)
        await this.processing?.confirmReview(ids, listened);
      else this.set({ manualReviewed: true });
      await this.loadDraftPreview();
    });
  canPublish = () =>
    !this.view.save?.dirty &&
    !this.view.lyricsError &&
    !this.isLocked() &&
    this.view.preview?.kind === "draft" &&
    this.view.preview.source.revision === this.view.detail?.revision &&
    this.view.validation?.valid === true &&
    (this.view.detail.processing_review?.required
      ? this.view.detail.processing_review.reviewed
      : this.view.manualReviewed);
  publish = () =>
    this.run("Đang xuất bản…", async () => {
      if (!this.queue) return;
      // The server independently enforces structural checks and the review stamp.
      const before = this.queue.getSnapshot().detail;
      if (
        !before.draft ||
        this.view.preview?.kind !== "draft" ||
        this.view.preview.source.revision !== before.revision ||
        (before.processing_review?.required &&
          !before.processing_review.reviewed) ||
        (!before.processing_review?.required && !this.view.manualReviewed) ||
        !this.view.validation?.valid
      )
        throw new Error(
          "Hãy hoàn tất kiểm tra và duyệt đúng bản nháp trước khi xuất bản.",
        );
      await this.queue.enqueueMutation(async (current, signal) => {
        if (!current.draft || current.revision !== before.revision)
          throw new Error("Nội dung đã thay đổi; hãy nghe và kiểm tra lại.");
        const detail = await this.service.publish(
          current.song_id,
          current.revision,
          current.draft.id,
          signal,
        );
        return { value: detail, detail };
      });
      this.set({
        preview: null,
        referencePreview: null,
        edited: false,
        notice: "Đã xuất bản bài hát. Trẻ chỉ thấy bản đã xuất bản này.",
      });
    });
  reloadSaved = () =>
    this.run("Đang đối chiếu bản đã lưu…", async () => {
      if (!this.view.detail || !this.queue) return;
      const detail = await this.service.get(
        this.view.detail.song_id,
        this.controller.signal,
      );
      this.queue.reconcile(detail, true);
      this.acceptDraft(detail);
      this.set({
        file: null,
        reference: null,
        cover: null,
        preview: null,
        referencePreview: null,
        validation: null,
        error: "",
        notice:
          "Đã nạp bản lưu trên máy chủ. File chưa được tải lên cần chọn lại.",
      });
      this.processing?.refresh();
    });
}
