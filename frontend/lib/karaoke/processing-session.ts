import type { AdminKaraokeService } from "@/lib/api/admin-karaoke-service";
import { isServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";
import type { KaraokeDraftSaveQueue } from "@/lib/karaoke/draft-save-queue";
import type { AdminKaraokeDetail } from "@/types/karaoke";
import type {
  ProcessingJob,
  ProcessingMode,
  ProcessingStart,
  ProcessingRetry,
} from "@/types/karaoke-processing";

export type ProcessingView = {
  job: ProcessingJob | null;
  loading: boolean;
  action: boolean;
  error: unknown;
};
const running = (job: ProcessingJob) =>
  job.status === "QUEUED" || job.status === "RUNNING";
/** GET polling is separate from the user-started continuation that may apply READY. */
export class KaraokeProcessingSession {
  private view: ProcessingView = {
    job: null,
    loading: false,
    action: false,
    error: null,
  };
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | null = null;
  private active = false;
  private readInFlight = false;
  private refreshPending = false;
  private epoch = 0;
  private target: { id: string; draftId: string } | null = null;
  private failures = 0;
  private authStopped = false;
  private owned: {
    jobId: string;
    generation: number;
    fingerprint: string;
  } | null = null;
  private applyingJob: string | null = null;
  private startIntent: { body: ProcessingStart; generation: number } | null =
    null;
  private retryIntent: {
    jobId: string;
    body: ProcessingRetry;
    generation: number;
  } | null = null;
  private applyFlight: Promise<AdminKaraokeDetail> | null = null;
  constructor(
    private service: AdminKaraokeService,
    private queue: KaraokeDraftSaveQueue,
  ) {}
  getSnapshot = () => this.view;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private set(patch: Partial<ProcessingView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private clearTimer() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private schedule(delay?: number) {
    this.clearTimer();
    if (!this.active || !this.target || this.authStopped) return;
    this.timer = setTimeout(
      this.refresh,
      delay ??
        (document.hidden ? 15000 : Math.min(15000, 2500 * 2 ** this.failures)),
    );
  }
  private visibility = () => {
    if (!document.hidden) this.refresh();
    else if (!this.readInFlight) this.schedule(15000);
  };
  activate = () => {
    if (this.active) return;
    this.active = true;
    document.addEventListener("visibilitychange", this.visibility);
    if (this.target && (!this.view.job || running(this.view.job)))
      this.refresh();
  };
  suspend = () => {
    this.active = false;
    this.epoch++;
    this.owned = null;
    this.clearTimer();
    this.controller?.abort();
    document.removeEventListener("visibilitychange", this.visibility);
  };
  /** Resume has GET-only semantics, even when a result is already READY. */
  resume = (jobId: string, draftId: string) => {
    if (this.target?.id === jobId && this.target.draftId === draftId) return;
    this.epoch++;
    this.owned = null;
    this.applyingJob = null;
    this.authStopped = false;
    this.controller?.abort();
    this.target = { id: jobId, draftId };
    this.set({ job: null, error: null });
    this.refresh();
  };
  refresh = () => {
    if (!this.active || this.authStopped || !this.target) return;
    this.clearTimer();
    if (this.readInFlight) {
      this.refreshPending = true;
      return;
    }
    void this.read();
  };
  private async read() {
    if (!this.active || this.authStopped || !this.target || this.readInFlight)
      return;
    this.readInFlight = true;
    this.refreshPending = false;
    const epoch = this.epoch;
    const target = this.target;
    const controller = new AbortController();
    this.controller = controller;
    this.set({ loading: true });
    try {
      const detail = this.queue.getSnapshot().detail;
      const job = await this.service.getProcessing(
        detail.song_id,
        target.id,
        target.draftId,
        controller.signal,
      );
      if (!this.active || epoch !== this.epoch || controller.signal.aborted)
        return;
      this.failures = 0;
      this.set({ job, error: null });
      // Only a continuation armed by start/retry in this live view can write.
      await this.applyOwnedReady(job, epoch);
    } catch (error) {
      if (!this.active || epoch !== this.epoch || controller.signal.aborted)
        return;
      if (isServiceError(error) && [401, 403].includes(error.status))
        this.authStopped = true;
      this.failures = Math.min(this.failures + 1, 3);
      this.set({ error });
    } finally {
      this.readInFlight = false;
      if (this.controller === controller) this.controller = null;
      if (this.active) {
        this.set({ loading: false });
        if (this.refreshPending) this.schedule(0);
        else if (
          epoch === this.epoch &&
          (!this.view.job || running(this.view.job) || this.view.error)
        )
          this.schedule();
      }
    }
  }
  private arm(job: ProcessingJob, generation: number) {
    this.epoch++;
    this.controller?.abort();
    this.authStopped = false;
    this.applyingJob = null;
    this.target = { id: job.id, draftId: job.draft_version_id };
    this.owned = {
      jobId: job.id,
      generation,
      fingerprint: job.input_fingerprint,
    };
    this.startIntent = null;
    this.set({ job, error: null });
  }
  private async applyOwnedReady(job: ProcessingJob, epoch: number) {
    const owned = this.owned;
    const local = this.queue.getSnapshot();
    if (
      !owned ||
      job.status !== "READY" ||
      !job.can_apply ||
      owned.jobId !== job.id ||
      owned.fingerprint !== job.input_fingerprint ||
      owned.generation !== local.generation ||
      local.dirty ||
      local.detail.revision !== job.base_revision ||
      local.detail.draft?.id !== job.draft_version_id ||
      this.applyingJob === job.id ||
      epoch !== this.epoch
    )
      return;
    this.applyingJob = job.id;
    await this.apply(job);
  }
  start = async (
    mode: ProcessingMode,
    sourceKind: ProcessingStart["source_kind"] = "DRAFT_AUDIO",
  ) => {
    if (this.view.action || !this.active) return null;
    this.set({ action: true, error: null });
    const epoch = this.epoch;
    try {
      const job = await this.queue.enqueueMutation(async (detail, signal) => {
        if (!detail.draft)
          throw new Error(
            translateRuntime(
              "admin.karaoke.wizardRuntime.needDraftBeforeProcessing",
            ),
          );
        const generation = this.queue.getSnapshot().generation;
        if (!this.startIntent)
          this.startIntent = {
            generation,
            body: {
              expected_revision: detail.revision,
              draft_version_id: detail.draft.id,
              idempotency_key: crypto.randomUUID(),
              mode,
              source_kind: sourceKind,
            },
          };
        const intent = this.startIntent;
        if (
          intent.generation !== generation ||
          intent.body.mode !== mode ||
          intent.body.source_kind !== sourceKind
        )
          throw new Error(
            translateRuntime(
              "admin.karaoke.wizardRuntime.previousStartUncertain",
            ),
          );
        return {
          value: await this.service.startProcessing(
            detail.song_id,
            intent.body,
            signal,
          ),
        };
      });
      if (!this.active || epoch !== this.epoch) return job;
      this.arm(
        job,
        this.startIntent?.generation ?? this.queue.getSnapshot().generation,
      );
      await this.applyOwnedReady(job, this.epoch);
      if (running(job)) this.schedule();
      return job;
    } catch (error) {
      if (this.active) this.set({ error });
      throw error;
    } finally {
      if (this.active) this.set({ action: false });
    }
  };
  cancel = async () => {
    const job = this.view.job;
    if (!job || !this.active || this.view.action) return;
    this.owned = null;
    this.epoch++;
    this.controller?.abort();
    this.clearTimer();
    this.set({ action: true, error: null });
    try {
      const result = await this.queue.enqueueMutation(
        async (detail, signal) => ({
          value: await this.service.cancelProcessing(
            detail.song_id,
            job.id,
            job.draft_version_id,
            signal,
          ),
        }),
      );
      if (this.active) this.set({ job: result });
    } catch (error) {
      if (this.active) this.set({ error });
      throw error;
    } finally {
      if (this.active) this.set({ action: false });
    }
  };
  retry = async (acknowledgePossibleCharge = false) => {
    const previous = this.view.job;
    if (!previous || !this.active || this.view.action) return null;
    if (
      !["FAILED", "CANCELLED", "STALE"].includes(previous.status) ||
      previous.retry_policy === "NEEDS_INPUT_CHANGE"
    )
      throw new Error(
        translateRuntime("admin.karaoke.wizardRuntime.editInputBeforeRetry"),
      );
    if (
      previous.retry_policy === "EXPLICIT_COST_ACK" &&
      !acknowledgePossibleCharge
    )
      throw new Error(
        translateRuntime(
          "admin.karaoke.wizardRuntime.ackPossibleChargeRequired",
        ),
      );
    this.set({ action: true, error: null });
    const epoch = this.epoch;
    try {
      const job = await this.queue.enqueueMutation(async (detail, signal) => {
        if (!detail.draft)
          throw new Error(
            translateRuntime(
              "admin.karaoke.wizardRuntime.needDraftBeforeRetry",
            ),
          );
        const generation = this.queue.getSnapshot().generation;
        if (!this.retryIntent)
          this.retryIntent = {
            jobId: previous.id,
            generation,
            body: {
              expected_revision: detail.revision,
              draft_version_id: detail.draft.id,
              idempotency_key: crypto.randomUUID(),
              acknowledge_possible_charge: acknowledgePossibleCharge,
            },
          };
        const intent = this.retryIntent;
        if (
          intent.jobId !== previous.id ||
          intent.generation !== generation ||
          intent.body.acknowledge_possible_charge !== acknowledgePossibleCharge
        )
          throw new Error(
            translateRuntime(
              "admin.karaoke.wizardRuntime.previousRetryUncertain",
            ),
          );
        return {
          value: await this.service.retryProcessing(
            detail.song_id,
            previous.id,
            intent.body,
            signal,
          ),
        };
      });
      if (!this.active || epoch !== this.epoch) return job;
      this.arm(
        job,
        this.retryIntent?.generation ?? this.queue.getSnapshot().generation,
      );
      this.retryIntent = null;
      await this.applyOwnedReady(job, this.epoch);
      if (running(job)) this.schedule();
      return job;
    } catch (error) {
      if (this.active) this.set({ error });
      throw error;
    } finally {
      if (this.active) this.set({ action: false });
    }
  };
  apply = (job = this.view.job): Promise<AdminKaraokeDetail> => {
    if (this.applyFlight) return this.applyFlight;
    const previousAction = this.view.action;
    this.set({ action: true });
    const flight = this.performApply(job)
      .catch((error: unknown) => {
        if (this.active) this.set({ error });
        throw error;
      })
      .finally(() => {
        this.applyFlight = null;
        if (this.active) this.set({ action: previousAction });
      });
    this.applyFlight = flight;
    return flight;
  };
  private async performApply(job: ProcessingJob | null) {
    if (!job || !this.active || !job.can_apply)
      throw new Error(
        translateRuntime(
          "admin.karaoke.wizardRuntime.resultNoLongerApplicable",
        ),
      );
    this.owned = null;
    const detail = await this.queue.enqueueMutation(async (current, signal) => {
      if (
        current.revision !== job.base_revision ||
        current.draft?.id !== job.draft_version_id
      )
        throw new Error(
          translateRuntime(
            "admin.karaoke.wizardRuntime.draftChangedReconcileApply",
          ),
        );
      const detail = await this.service.applyProcessing(
        current.song_id,
        job.id,
        {
          expected_revision: job.base_revision,
          draft_version_id: job.draft_version_id,
        },
        signal,
      );
      return { value: detail, detail };
    });
    if (this.active)
      this.set({
        job: {
          ...job,
          status: "APPLIED",
          can_apply: false,
          applied_revision: detail.revision,
        },
        error: null,
      });
    return detail;
  }
  confirmReview = async (
    acknowledgedFlagIds: string[],
    confirmedListened: boolean,
  ) => {
    if (!this.active || this.view.action) return null;
    if (!confirmedListened)
      throw new Error(
        translateRuntime("admin.karaoke.wizardRuntime.listenDraftFirst"),
      );
    this.set({ action: true, error: null });
    try {
      return await this.queue.enqueueMutation(async (current, signal) => {
        const review = current.processing_review;
        if (
          !current.draft ||
          !review?.required ||
          !review.current_content_fingerprint
        )
          throw new Error(
            translateRuntime(
              "admin.karaoke.wizardRuntime.draftMissingReviewContent",
            ),
          );
        const detail = await this.service.confirmReview(
          current.song_id,
          {
            expected_revision: current.revision,
            draft_version_id: current.draft.id,
            content_fingerprint: review.current_content_fingerprint,
            confirmed_listened: confirmedListened,
            acknowledged_flag_ids: acknowledgedFlagIds,
          },
          signal,
        );
        return { value: detail, detail };
      });
    } catch (error) {
      if (this.active) this.set({ error });
      throw error;
    } finally {
      if (this.active) this.set({ action: false });
    }
  };
  getPreview = (signal?: AbortSignal) => {
    if (!this.view.job)
      throw new Error(
        translateRuntime("admin.karaoke.wizardRuntime.noResultToPreview"),
      );
    return this.service.getProcessingPreview(this.view.job, signal);
  };
}
