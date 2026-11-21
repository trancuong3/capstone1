import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useReadingPresence } from "@/hooks/use-reading-presence";
import type {
  PresenceAlertDTO,
  ReadingPresenceService,
} from "@/lib/api/reading-presence-service";
import { announcePresenceOptIn } from "@/lib/reading/presence-opt-in";
import type { PresenceSampleSource } from "@/lib/reading/presence-camera";
import type {
  PresenceSample,
  SessionPhase,
} from "@/lib/reading/presence-monitor";

const SESSION = "11111111-1111-4111-8111-111111111111";
let now = 0;

function alertFor(episode: string): PresenceAlertDTO {
  return {
    id: `alert-${episode}`,
    session_id: SESSION,
    episode_id: episode,
    status: "PENDING",
    due_at: "2026-11-22T03:01:00Z",
    expires_at: "2026-11-22T03:06:00Z",
  } as PresenceAlertDTO;
}

function harness(
  options: { optedIn?: boolean; startResult?: "started" | "denied" } = {},
) {
  let emit: (sample: PresenceSample) => void = () => undefined;
  const source: PresenceSampleSource = {
    start: vi.fn(async (callback) => {
      emit = callback;
      return options.startResult ?? "started";
    }),
    stop: vi.fn(),
  };
  const service = {
    getSettings: vi.fn(async () => ({ emailEnabled: options.optedIn ?? true })),
    setEmailEnabled: vi.fn(),
    armAlert: vi.fn(async (_session: string, episode: string) =>
      alertFor(episode),
    ),
    confirmAlert: vi.fn(async () => alertFor("x")),
    cancelAlert: vi.fn(async () => alertFor("x")),
  } as unknown as ReadingPresenceService & {
    armAlert: ReturnType<typeof vi.fn>;
    confirmAlert: ReturnType<typeof vi.fn>;
    cancelAlert: ReturnType<typeof vi.fn>;
    getSettings: ReturnType<typeof vi.fn>;
  };
  const onPauseRequested = vi.fn();
  const onNotice = vi.fn();
  let episodes = 0;
  const hook = renderHook(
    ({ phase }: { phase: SessionPhase }) =>
      useReadingPresence({
        sessionId: SESSION,
        sessionPhase: phase,
        service,
        onPauseRequested,
        onNotice,
        createSource: () => source,
        newEpisodeId: () => `ep-${(episodes += 1)}`,
      }),
    { initialProps: { phase: "reading" as SessionPhase } },
  );
  const feed = (sample: Omit<PresenceSample, "at">, seconds: number) => {
    for (let i = 0; i < seconds; i += 1) {
      now += 1000;
      act(() => emit({ ...sample, at: now }));
    }
  };
  return { hook, source, service, onPauseRequested, onNotice, feed };
}

const PRESENT = { faceCount: 1, quality: "ok", motion: 0.2 } as const;
const ABSENT = { faceCount: 0, quality: "ok", motion: 0 } as const;

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("useReadingPresence (opt-in, on-device)", () => {
  it("does nothing at all when the parent has not opted in", async () => {
    const h = harness({ optedIn: false });
    await settle();
    expect(h.service.getSettings).toHaveBeenCalledTimes(1);
    expect(h.source.start).not.toHaveBeenCalled();
    expect(h.service.armAlert).not.toHaveBeenCalled();
    expect(h.hook.result.current.optedIn).toBe(false);
  });

  it("pauses once and arms one alert after sustained absence, then heartbeats and cancels on return", async () => {
    const h = harness();
    await waitFor(() => expect(h.source.start).toHaveBeenCalled());
    await settle();
    h.feed(PRESENT, 5);
    h.feed(ABSENT, 46);
    await settle();
    expect(h.onPauseRequested).toHaveBeenCalledTimes(1);
    expect(h.onNotice).toHaveBeenCalledTimes(1);
    expect(h.service.armAlert).toHaveBeenCalledTimes(1);
    expect(h.service.armAlert).toHaveBeenCalledWith(SESSION, "ep-1");

    h.hook.rerender({ phase: "paused-by-presence" });
    h.feed(ABSENT, 20);
    await settle();
    expect(h.service.confirmAlert).toHaveBeenCalledTimes(2);
    expect(h.service.confirmAlert).toHaveBeenCalledWith("alert-ep-1");

    h.feed(PRESENT, 3);
    await settle();
    expect(h.service.cancelAlert).toHaveBeenCalledTimes(1);
    expect(h.service.cancelAlert).toHaveBeenCalledWith(
      "alert-ep-1",
      "RETURNED",
    );
    expect(h.onPauseRequested).toHaveBeenCalledTimes(1);
  });

  it("never alerts for a reader who bends over the book or a covered camera", async () => {
    const h = harness();
    await waitFor(() => expect(h.source.start).toHaveBeenCalled());
    await settle();
    h.feed(PRESENT, 5);
    h.feed({ faceCount: 0, quality: "ok", motion: 0.4 }, 300);
    h.feed({ faceCount: 0, quality: "covered", motion: 0 }, 300);
    await settle();
    expect(h.onPauseRequested).not.toHaveBeenCalled();
    expect(h.service.armAlert).not.toHaveBeenCalled();
  });

  async function armed() {
    const h = harness();
    await waitFor(() => expect(h.source.start).toHaveBeenCalled());
    await settle();
    h.feed(PRESENT, 5);
    h.feed(ABSENT, 46);
    await settle();
    h.hook.rerender({ phase: "paused-by-presence" });
    expect(h.service.armAlert).toHaveBeenCalledTimes(1);
    return h;
  }

  it("cancels when the parent opts out", async () => {
    const h = await armed();
    act(() => announcePresenceOptIn(false));
    await settle();
    expect(h.service.cancelAlert).toHaveBeenCalledWith("alert-ep-1", "OPT_OUT");
    expect(h.source.stop).toHaveBeenCalled();
  });

  it("cancels when the app goes to the background", async () => {
    const h = await armed();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(h.service.cancelAlert).toHaveBeenCalledWith(
      "alert-ep-1",
      "APP_BACKGROUND",
    );
  });

  it("cancels when the session ends or the screen closes", async () => {
    const ended = await armed();
    ended.hook.rerender({ phase: "ended" });
    await settle();
    expect(ended.service.cancelAlert).toHaveBeenCalledWith(
      "alert-ep-1",
      "SESSION_ENDED",
    );

    const closed = await armed();
    closed.hook.unmount();
    await settle();
    expect(closed.service.cancelAlert).toHaveBeenCalledTimes(1);
    expect(closed.source.stop).toHaveBeenCalled();
  });

  it("a failed arm request is silent and never leads to confirm or cancel calls", async () => {
    const h = harness();
    h.service.armAlert.mockRejectedValue(new Error("offline"));
    await waitFor(() => expect(h.source.start).toHaveBeenCalled());
    await settle();
    h.feed(PRESENT, 5);
    h.feed(ABSENT, 46);
    await settle();
    h.hook.rerender({ phase: "paused-by-presence" });
    h.feed(ABSENT, 25);
    h.feed(PRESENT, 3);
    await settle();
    expect(h.service.confirmAlert).not.toHaveBeenCalled();
    expect(h.service.cancelAlert).not.toHaveBeenCalled();
  });

  it("without camera permission nothing is evaluated and nothing is sent", async () => {
    const h = harness({ startResult: "denied" });
    await waitFor(() => expect(h.source.start).toHaveBeenCalled());
    await settle();
    h.feed(PRESENT, 5);
    h.feed(ABSENT, 100);
    await settle();
    expect(h.onPauseRequested).not.toHaveBeenCalled();
    expect(h.service.armAlert).not.toHaveBeenCalled();
    expect(h.hook.result.current.watching).toBe(false);
  });
});
