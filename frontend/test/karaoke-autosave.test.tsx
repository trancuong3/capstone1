import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKaraokeDraftAutosave } from "@/hooks/use-karaoke-draft-autosave";
import {
  KaraokeDraftSaveQueue,
  type DraftSnapshot,
} from "@/lib/karaoke/draft-save-queue";
import { ServiceError } from "@/lib/api/service-error";
import { songDetail } from "@/test/karaoke-fixtures";
import type { AdminKaraokeDetail, KaraokeDraftWrite } from "@/types/karaoke";
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
function ack(body: KaraokeDraftWrite): AdminKaraokeDetail {
  const { expected_revision, draft_version_id: _id, ...values } = body;
  void _id;
  const data = songDetail();
  return {
    ...data,
    revision: expected_revision + 1,
    draft: { ...data.draft!, ...values },
  };
}
function snapshot(title = "Mới"): DraftSnapshot {
  return { ...songDetail().draft!, title };
}
function error(status: number) {
  return new ServiceError({
    status,
    code: "NETWORK_ERROR",
    message: "test-only",
    request_id: "",
    retryable: false,
  });
}
const queues: KaraokeDraftSaveQueue[] = [];
function setup() {
  const save = vi.fn().mockImplementation(async (_id, body) => ack(body));
  const queue = new KaraokeDraftSaveQueue(songDetail(), { save });
  queues.push(queue);
  return { queue, save };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  queues.forEach((q) => q.dispose());
  queues.length = 0;
  vi.useRealTimers();
});
describe("karaoke draft serial autosave", () => {
  it("does not write on construction/mount and debounces the latest snapshot", async () => {
    const { queue, save } = setup();
    expect(save).not.toHaveBeenCalled();
    queue.updateSnapshot(snapshot("A"));
    await vi.advanceTimersByTimeAsync(400);
    queue.updateSnapshot(snapshot("AB"));
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1].title).toBe("AB");
    expect(queue.getSnapshot()).toMatchObject({
      state: "saved",
      dirty: false,
      detail: { revision: 2 },
    });
  });
  it("never lets an old ACK overwrite new input, coalesces edits and uses the ACK revision", async () => {
    const { queue, save } = setup();
    const first = deferred<AdminKaraokeDetail>();
    save.mockImplementationOnce(() => first.promise);
    queue.updateSnapshot(snapshot("A"));
    const flushing = queue.flush();
    await Promise.resolve();
    queue.updateSnapshot(snapshot("AB"));
    queue.updateSnapshot(snapshot("ABC"));
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(ack(save.mock.calls[0][1]));
    await flushing;
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toMatchObject({
      title: "ABC",
      expected_revision: 2,
    });
    expect(queue.getSnapshot()).toMatchObject({
      generation: 3,
      detail: { revision: 3, draft: { title: "ABC" } },
    });
  });
  it("serializes concurrent flushes and action behind all pending saves", async () => {
    const { queue, save } = setup();
    const first = deferred<AdminKaraokeDetail>();
    save.mockImplementationOnce(() => first.promise);
    queue.updateSnapshot(snapshot());
    const f1 = queue.flush();
    const f2 = queue.flush();
    const action = vi.fn(async (detail: AdminKaraokeDetail) => ({
      value: detail.revision,
    }));
    const mutation = queue.enqueueMutation(action);
    await Promise.resolve();
    expect(action).not.toHaveBeenCalled();
    first.resolve(ack(save.mock.calls[0][1]));
    expect(await mutation).toBe(2);
    await Promise.all([f1, f2]);
    expect(save).toHaveBeenCalledTimes(1);
  });
  it.each([409, 401, 403, 0, 503])(
    "blocks automatic retries after %s, keeping local input for reconciliation",
    async (status) => {
      const { queue, save } = setup();
      save.mockRejectedValueOnce(error(status));
      queue.updateSnapshot(snapshot("A"));
      await expect(queue.flush()).rejects.toMatchObject({ status });
      queue.updateSnapshot(snapshot("AB"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(save).toHaveBeenCalledTimes(1);
      expect(queue.getSnapshot().dirty).toBe(true);
      await expect(queue.flush()).rejects.toMatchObject({ status });
      expect(() => queue.reconcile({ ...songDetail(), revision: 2 })).toThrow(
        "Nội dung máy chủ khác",
      );
    },
  );
  it("keeps 422 invalid until an edit and does not submit structurally invalid input", async () => {
    const { queue, save } = setup();
    save.mockRejectedValueOnce(error(422));
    queue.updateSnapshot(snapshot());
    await expect(queue.flush()).rejects.toMatchObject({ status: 422 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
    queue.updateSnapshot(snapshot("Đã sửa"));
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(2);
    queue.updateSnapshot({ ...snapshot(), min_grade: 5, max_grade: 1 });
    await expect(queue.flush()).rejects.toBeDefined();
    expect(save).toHaveBeenCalledTimes(2);
  });
  it("recovers a lost save response only when GET proves the exact local snapshot", async () => {
    const { queue, save } = setup();
    save.mockRejectedValueOnce(error(0));
    queue.updateSnapshot(snapshot());
    await expect(queue.flush()).rejects.toBeDefined();
    const detail = ack(save.mock.calls[0][1]);
    queue.reconcile(detail);
    await queue.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().dirty).toBe(false);
  });
  it("does not mutate IDs/timing when only metadata changes", async () => {
    const { queue, save } = setup();
    const input = snapshot();
    const previous = structuredClone(input.lyrics);
    queue.updateSnapshot(input);
    input.lyrics.lines[0].text = "Caller mutated afterwards";
    await queue.flush();
    expect(save.mock.calls[0][1].lyrics).toEqual(previous);
  });
  it("rejects wrong identity or a save ACK for different content without silently adopting it", async () => {
    const { queue, save } = setup();
    save.mockResolvedValueOnce({ ...songDetail(), revision: 2 });
    queue.updateSnapshot(snapshot("Not on server"));
    await expect(queue.flush()).rejects.toThrow("Chưa đối chiếu");
    expect(queue.getSnapshot().detail.revision).toBe(1);
  });
  it("updates baseline after a serialized action and keeps edits made during that action", async () => {
    const { queue, save } = setup();
    const mutation = deferred<{ value: string; detail: AdminKaraokeDetail }>();
    const action = queue.enqueueMutation(() => mutation.promise);
    await Promise.resolve();
    queue.updateSnapshot(snapshot("Typing during upload"));
    mutation.resolve({
      value: "uploaded",
      detail: { ...songDetail(), revision: 2 },
    });
    await action;
    await queue.flush();
    expect(save.mock.calls[0][1]).toMatchObject({
      title: "Typing during upload",
      expected_revision: 2,
    });
  });
  it("aborts in-flight client work and ignores late ACK after suspend/reactivation", async () => {
    const { queue, save } = setup();
    const pending = deferred<AdminKaraokeDetail>();
    save.mockImplementationOnce(() => pending.promise);
    queue.updateSnapshot(snapshot());
    const flushing = queue.flush();
    const rejection = expect(flushing).rejects.toBeDefined();
    await Promise.resolve();
    const signal = save.mock.calls[0][2];
    queue.suspend();
    queue.activate();
    expect(signal.aborted).toBe(true);
    pending.resolve(ack(save.mock.calls[0][1]));
    await rejection;
    expect(queue.getSnapshot().detail.revision).toBe(1);
  });
  it("adopts explicit publish ACK only for the same draft version, after flushing", async () => {
    const { queue, save } = setup();
    queue.updateSnapshot(snapshot("Ready to publish"));
    const published = await queue.enqueueMutation(async (current) => {
      expect(current.revision).toBe(2);
      const detail: AdminKaraokeDetail = {
        ...current,
        revision: 3,
        status: "PUBLISHED",
        draft: null,
        published: { ...current.draft!, state: "PUBLISHED" },
      };
      return { value: detail, detail };
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().detail).toEqual(published);
    expect(queue.getSnapshot().dirty).toBe(false);
  });
  it("still rejects a publish ACK for a different version", async () => {
    const { queue } = setup();
    const current = songDetail();
    const detail: AdminKaraokeDetail = {
      ...current,
      revision: 2,
      status: "PUBLISHED",
      draft: null,
      published: { ...current.draft!, id: current.song_id, state: "PUBLISHED" },
    };
    await expect(
      queue.enqueueMutation(async () => ({ value: detail, detail })),
    ).rejects.toThrow("không khớp");
    expect(queue.getSnapshot().detail.revision).toBe(1);
  });
  it("is StrictMode-safe, leaves editable input untouched and clears debounce on unmount", async () => {
    const service = {
      save: vi.fn().mockImplementation(async (_id, body) => ack(body)),
    };
    const { result, unmount } = renderHook(
      () => useKaraokeDraftAutosave(songDetail(), service),
      { wrapper: StrictMode },
    );
    expect(service.save).not.toHaveBeenCalled();
    act(() => result.current.updateSnapshot(snapshot()));
    await act(async () => {
      await result.current.flush();
    });
    expect(result.current.latestRevision).toBe(2);
    act(() => result.current.updateSnapshot(snapshot("Unsaved")));
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.save).toHaveBeenCalledTimes(1);
  });
});
