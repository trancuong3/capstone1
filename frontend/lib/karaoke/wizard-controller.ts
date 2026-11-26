import {
  karaokeErrorMessage,
  type AdminKaraokeService,
} from "@/lib/api/admin-karaoke-service";
import { isServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";
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
    if (this.queue)
      throw new Error(
        translateRuntime("admin.karaoke.wizardRuntime.queueAlreadyAttached"),
      );
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
          notice: translateRuntime("admin.karaoke.wizardRuntime.appliedNotice"),
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
          error instanceof Error
            ? error.message
            : translateRuntime("admin.karaoke.wizardRuntime.invalidLyrics"),
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
          ? translateRuntime("admin.karaoke.wizardRuntime.invalidAudioFile")
          : translateRuntime("admin.karaoke.wizardRuntime.invalidCoverFile"),
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
              : translateRuntime(
                  "admin.karaoke.wizardRuntime.requestIncomplete",
                ),
        });
    } finally {
      this.actionFlight = false;
      if (this.active) this.set({ busy: "" });
    }
  }
  private async upload(kind: "audio" | "reference" | "cover", file: File) {
    if (!this.queue)
      throw new Error(
        translateRuntime("admin.karaoke.wizardRuntime.draftNotCreated"),
      );
    await this.queue.enqueueMutation(async (before, signal) => {
      if (!before.draft)
        throw new Error(
          translateRuntime("admin.karaoke.wizardRuntime.draftNoLongerCurrent"),
        );
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
    this.run(
      translateRuntime("admin.karaoke.wizardRuntime.preparingSong"),
      async () => {
        if (!this.canProcess())
          throw new Error(
            translateRuntime("admin.karaoke.wizardRuntime.autoNotReady"),
          );
        if (this.view.lyricsError || !this.view.rawLyrics.trim())
          throw new Error(
            this.view.lyricsError ||
              translateRuntime(
                "admin.karaoke.wizardRuntime.pasteLyricsRequired",
              ),
          );
        if (!this.view.file && !this.view.detail?.draft?.has_audio)
          throw new Error(
            translateRuntime("admin.karaoke.wizardRuntime.selectVocalMp3"),
          );
        if (
          this.view.mode === "INSTRUMENTAL_WITH_REFERENCE" &&
          !this.view.reference &&
          !this.view.detail?.draft?.has_reference_audio
        )
          throw new Error(
            translateRuntime(
              "admin.karaoke.wizardRuntime.selectReferenceAudio",
            ),
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
          throw new Error(
            translateRuntime("admin.karaoke.wizardRuntime.draftNotReady"),
          );
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
            JSON.stringify(saved.draft) !==
              JSON.stringify(rejected.before.draft)
          )
            throw new Error(
              translateRuntime(
                "admin.karaoke.wizardRuntime.serverVersionChanged",
              ),
            );
          this.queue.reconcile(saved, true);
          // Editable metadata/lyrics remain in this view and are saved after the new upload ACK.
          this.rejectedUpload = null;
        }
        const uploadedNewAudio = !!this.view.file;
        if (this.view.file) {
          this.set({
            busy: translateRuntime(
              "admin.karaoke.wizardRuntime.uploadingAudio",
            ),
          });
          await this.upload("audio", this.view.file);
        }
        if (this.view.reference) {
          this.set({
            busy: translateRuntime(
              "admin.karaoke.wizardRuntime.uploadingReference",
            ),
          });
          await this.upload("reference", this.view.reference);
        }
        if (this.view.cover) {
          this.set({
            busy: translateRuntime(
              "admin.karaoke.wizardRuntime.uploadingCover",
            ),
          });
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
        this.set({
          lyrics,
          busy: translateRuntime(
            "admin.karaoke.wizardRuntime.savingLyricsAndProcessing",
          ),
        });
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
      },
    );
  flush = async () => {
    if (
      this.view.lyricsError ||
      this.view.file ||
      this.view.reference ||
      this.view.cover
    )
      throw new Error(
        translateRuntime("admin.karaoke.wizardRuntime.finishBeforeSwitchMode"),
      );
    if (this.queue) await this.queue.flush();
    else if (this.view.edited)
      throw new Error(
        translateRuntime("admin.karaoke.wizardRuntime.unsavedLeaveWarning"),
      );
  };
  cancel = () =>
    this.run(
      translateRuntime("admin.karaoke.wizardRuntime.cancellingProcessing"),
      async () => {
        try {
          await this.processing?.cancel();
        } catch (error) {
          if (
            isServiceError(error) &&
            error.status === 409 &&
            this.view.detail
          ) {
            const current = await this.service.get(
              this.view.detail.song_id,
              this.controller.signal,
            );
            if (current.processing_summary?.status === "APPLIED") {
              this.set({
                notice: translateRuntime(
                  "admin.karaoke.wizardRuntime.appliedElsewhereNotice",
                ),
              });
            }
          }
          throw error;
        }
      },
    );
  retry = (ack: boolean) =>
    this.run(
      translateRuntime("admin.karaoke.wizardRuntime.retryingProcessing"),
      async () => {
        this.acceptApplied = true;
        await this.processing?.retry(ack);
      },
    );
  apply = () =>
    this.run(
      translateRuntime("admin.karaoke.wizardRuntime.applyingResult"),
      async () => {
        this.acceptApplied = true;
        await this.processing?.apply();
      },
    );
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
    this.run(
      translateRuntime("admin.karaoke.wizardRuntime.loadingStagingPreview"),
      async () => {
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
      },
    );
  loadDraftPreview = async () => {
    if (!this.queue || !this.active) return;
    if (
      this.view.file ||
      this.view.reference ||
      this.view.cover ||
      this.view.lyricsError
    ) {
      this.set({
        error: translateRuntime(
          "admin.karaoke.wizardRuntime.finishBeforeDraftPreview",
        ),
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
    this.run(
      translateRuntime("admin.karaoke.wizardRuntime.loadingReference"),
      async () => {
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
                  ? translateRuntime(
                      "admin.karaoke.wizardRuntime.missingReferenceFallback",
                    )
                  : karaokeErrorMessage(error),
            });
        }
      },
    );
  confirmReview = (ids: string[], listened: boolean) =>
    this.run(
      translateRuntime("admin.karaoke.wizardRuntime.confirmingReview"),
      async () => {
        if (!listened)
          throw new Error(
            translateRuntime(
              "admin.karaoke.wizardRuntime.listenAndConfirmFirst",
            ),
          );
        if (this.view.detail?.processing_review?.required)
          await this.processing?.confirmReview(ids, listened);
        else this.set({ manualReviewed: true });
        await this.loadDraftPreview();
      },
    );
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
    this.run(
      translateRuntime("admin.karaoke.wizardRuntime.publishing"),
      async () => {
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
            translateRuntime(
              "admin.karaoke.wizardRuntime.completeReviewBeforePublish",
            ),
          );
        await this.queue.enqueueMutation(async (current, signal) => {
          if (!current.draft || current.revision !== before.revision)
            throw new Error(
              translateRuntime(
                "admin.karaoke.wizardRuntime.contentChangedRecheck",
              ),
            );
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
          notice: translateRuntime(
            "admin.karaoke.wizardRuntime.publishedNotice",
          ),
        });
      },
    );
  reloadSaved = () =>
    this.run(
      translateRuntime("admin.karaoke.wizardRuntime.reloadingSaved"),
      async () => {
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
          notice: translateRuntime(
            "admin.karaoke.wizardRuntime.reloadedSavedNotice",
          ),
        });
        this.processing?.refresh();
      },
    );
}
