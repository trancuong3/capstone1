import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminKaraokeService } from "@/lib/api/admin-karaoke-service";
import { ServiceError } from "@/lib/api/service-error";
import { KaraokeDraftSaveQueue } from "@/lib/karaoke/draft-save-queue";
import { KaraokeProcessingSession } from "@/lib/karaoke/processing-session";
import { useKaraokeProcessing } from "@/hooks/use-karaoke-processing";
import { songDetail, versionId, lineId } from "@/test/karaoke-fixtures";
import {
  jobId,
  inputHash,
  processingJob,
  processingPreview,
} from "@/test/karaoke-processing-fixtures";
import type { ProcessingJob } from "@/types/karaoke-processing";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const resources: {
  session: KaraokeProcessingSession;
  queue: KaraokeDraftSaveQueue;
}[] = [];
function setup() {
  const service = {
    ...createAdminKaraokeService(),
    getProcessing: vi.fn().mockResolvedValue(processingJob()),
    startProcessing: vi.fn().mockResolvedValue(processingJob()),
    cancelProcessing: vi
      .fn()
      .mockResolvedValue(processingJob({ status: "CANCELLED" })),
    retryProcessing: vi.fn().mockResolvedValue(processingJob({ id: lineId })),
    applyProcessing: vi
      .fn()
      .mockResolvedValue({ ...songDetail(), revision: 2 }),
    getProcessingPreview: vi.fn().mockResolvedValue(processingPreview()),
    confirmReview: vi.fn(),
    publish: vi.fn(),
    save: vi.fn(),
  };
  const queue = new KaraokeDraftSaveQueue(songDetail(), service);
  const session = new KaraokeProcessingSession(service, queue);
  resources.push({ session, queue });
  session.activate();
  return { service, queue, session };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  resources.forEach(({ session, queue }) => {
    session.suspend();
    queue.dispose();
  });
  resources.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("karaoke processing lifecycle", () => {
  it("resumes READY with GET only, never auto applies/publishes/enqueues after reload", async () => {
    const { session, service } = setup();
    service.getProcessing.mockResolvedValue(
      processingJob({ status: "READY", can_apply: true }),
    );
    session.resume(jobId, versionId);
    await vi.advanceTimersByTimeAsync(20000);
    expect(service.getProcessing).toHaveBeenCalledTimes(1);
    expect(service.startProcessing).not.toHaveBeenCalled();
    expect(service.applyProcessing).not.toHaveBeenCalled();
    expect(service.publish).not.toHaveBeenCalled();
  });
  it("auto applies READY exactly once as continuation of explicit start in this view", async () => {
    const { session, service, queue } = setup();
    service.getProcessing.mockResolvedValue(
      processingJob({ status: "READY", can_apply: true }),
    );
    await session.start("VOCAL_TRACK");
    await vi.advanceTimersByTimeAsync(2500);
    expect(service.applyProcessing).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().detail.revision).toBe(2);
    expect(session.getSnapshot().job?.status).toBe("APPLIED");
    await vi.advanceTimersByTimeAsync(20000);
    expect(service.applyProcessing).toHaveBeenCalledTimes(1);
  });
  it("keeps NEEDS_REVIEW staging separate until explicit apply and coalesces double apply", async () => {
    const { session, service } = setup();
    service.getProcessing.mockResolvedValue(
      processingJob({ status: "NEEDS_REVIEW", can_apply: true }),
    );
    await session.start("VOCAL_TRACK");
    await vi.advanceTimersByTimeAsync(2500);
    expect(service.applyProcessing).not.toHaveBeenCalled();
    await session.getPreview();
    expect(service.getProcessingPreview).toHaveBeenCalledTimes(1);
    const a = session.apply();
    const b = session.apply();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(service.applyProcessing).toHaveBeenCalledTimes(1);
    expect(service.confirmReview).not.toHaveBeenCalled();
    expect(service.publish).not.toHaveBeenCalled();
  });
  it("guards double start before any await", async () => {
    const { session, service } = setup();
    await Promise.all([
      session.start("VOCAL_TRACK"),
      session.start("VOCAL_TRACK"),
    ]);
    expect(service.startProcessing).toHaveBeenCalledTimes(1);
  });
  it("does not apply after input changes while start was in flight", async () => {
    const { session, service, queue } = setup();
    const request = deferred<ProcessingJob>();
    service.startProcessing.mockImplementation(() => request.promise);
    const pending = session.start("VOCAL_TRACK");
    await vi.advanceTimersByTimeAsync(0);
    queue.updateSnapshot({ ...songDetail().draft!, title: "Changed" });
    request.resolve(processingJob({ status: "READY", can_apply: true }));
    await pending;
    expect(service.applyProcessing).not.toHaveBeenCalled();
  });
  it("aborts GET on close without cancelling the server job and ignores late result", async () => {
    const { session, service } = setup();
    const pending = deferred<ProcessingJob>();
    service.getProcessing.mockImplementation(() => pending.promise);
    session.resume(jobId, versionId);
    const signal = service.getProcessing.mock.calls[0][3];
    session.suspend();
    expect(signal.aborted).toBe(true);
    pending.resolve(processingJob({ status: "READY", can_apply: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().job).toBeNull();
    expect(service.cancelProcessing).not.toHaveBeenCalled();
  });
  it("never overlaps GETs, including visibility refresh and a changed target", async () => {
    const { session, service } = setup();
    const pending = deferred<ProcessingJob>();
    service.getProcessing.mockImplementationOnce(() => pending.promise);
    session.resume(jobId, versionId);
    session.refresh();
    session.resume(lineId, versionId);
    session.refresh();
    expect(service.getProcessing).toHaveBeenCalledTimes(1);
    service.getProcessing.mockResolvedValue(
      processingJob({ id: lineId, status: "FAILED" }),
    );
    pending.resolve(processingJob());
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getProcessing).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().job?.id).toBe(lineId);
  });
  it("backs off when hidden and immediately refreshes when visible", async () => {
    const { session, service } = setup();
    session.resume(jobId, versionId);
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(14999);
    expect(service.getProcessing).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getProcessing).toHaveBeenCalledTimes(2);
  });
  it("stops on auth failure rather than polling/retrying writes indefinitely", async () => {
    const { session, service } = setup();
    service.getProcessing.mockRejectedValue(
      new ServiceError({
        status: 403,
        code: "FORBIDDEN",
        message: "test",
        request_id: "",
        retryable: false,
      }),
    );
    session.resume(jobId, versionId);
    await vi.advanceTimersByTimeAsync(60000);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(service.getProcessing).toHaveBeenCalledTimes(1);
    expect(service.retryProcessing).not.toHaveBeenCalled();
  });
  it("cancel revokes the local continuation and a late GET cannot resurrect it", async () => {
    const { session, service } = setup();
    const pending = deferred<ProcessingJob>();
    service.getProcessing.mockImplementation(() => pending.promise);
    await session.start("VOCAL_TRACK");
    session.refresh();
    await session.cancel();
    pending.resolve(processingJob({ status: "READY", can_apply: true }));
    await vi.advanceTimersByTimeAsync(20000);
    expect(session.getSnapshot().job?.status).toBe("CANCELLED");
    expect(service.applyProcessing).not.toHaveBeenCalled();
    expect(service.cancelProcessing).toHaveBeenCalledTimes(1);
  });
  it("requires possible-charge acknowledgment for retry after unknown/cancel", async () => {
    const { session, service } = setup();
    service.getProcessing.mockResolvedValue(
      processingJob({ status: "CANCELLED", retry_policy: "EXPLICIT_COST_ACK" }),
    );
    session.resume(jobId, versionId);
    await vi.advanceTimersByTimeAsync(0);
    await expect(session.retry()).rejects.toThrow("phí");
    expect(service.retryProcessing).not.toHaveBeenCalled();
    await session.retry(true);
    expect(service.retryProcessing.mock.calls[0][2]).toMatchObject({
      acknowledge_possible_charge: true,
      expected_revision: 1,
    });
  });
  it("does not turn preview/play into review and rejects unchecked explicit confirmation", async () => {
    const { session, service } = setup();
    await expect(session.confirmReview([], false)).rejects.toThrow("nghe");
    expect(service.confirmReview).not.toHaveBeenCalled();
  });
  it("StrictMode mounts do not cause writes, and unmount aborts the read", async () => {
    const { queue, service } = setup();
    const pending = deferred<ProcessingJob>();
    service.getProcessing.mockImplementation(() => pending.promise);
    const { result, unmount } = renderHook(
      () => useKaraokeProcessing(service, queue),
      { wrapper: StrictMode },
    );
    act(() => result.current.resume(jobId, versionId));
    expect(service.startProcessing).not.toHaveBeenCalled();
    const signal = service.getProcessing.mock.calls[0][3];
    unmount();
    expect(signal.aborted).toBe(true);
    expect(service.cancelProcessing).not.toHaveBeenCalled();
    pending.resolve(processingJob());
    await vi.advanceTimersByTimeAsync(0);
  });
  it("does not infer worker failure or call retry from a long queue wait", async () => {
    const { session, service } = setup();
    session.resume(jobId, versionId);
    await vi.advanceTimersByTimeAsync(125000);
    expect(session.getSnapshot().job).toMatchObject({
      status: "QUEUED",
      input_fingerprint: inputHash,
    });
    expect(service.retryProcessing).not.toHaveBeenCalled();
  });
});
