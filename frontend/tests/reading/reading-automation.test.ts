import { describe, expect, it } from "vitest";
import {
  DEFAULT_AUTOMATION_CONFIG,
  ReadingAutomationRuntime,
  createAutomationState,
  nextWakeAt,
  reduce,
  type AutomationClock,
  type AutomationEffect,
  type AutomationEvent,
  type AutomationMessage,
  type AutomationPorts,
  type AutomationSettings,
  type AutomationState,
  type PageContext,
} from "@/lib/reading/reading-automation";

// ---------------------------------------------------------------------------
// Harness: fake clock + controllable ports.
// ---------------------------------------------------------------------------
class FakeClock implements AutomationClock {
  time = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; run: () => void }>();
  now() {
    return this.time;
  }
  setTimeout(callback: () => void, ms: number) {
    const id = (this.seq += 1);
    this.timers.set(id, { at: this.time + ms, run: callback });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  async advance(ms: number) {
    await flush();
    const target = this.time + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === -1 || nextAt > target) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.time = Math.max(this.time, timer.at);
      timer.run();
      await flush();
    }
    this.time = target;
    await flush();
  }
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const WORDS = ["Bé", "Lan", "đi", "học", "cùng", "mẹ"].map((text, index) => ({
  id: `w${index}`,
  punctAfter: index === 5,
  text,
}));

function page(id: string, isLastPage = false): PageContext {
  return { sessionId: "s1", pageId: id, revisionId: "r1", isLastPage };
}

function setup(settings?: Partial<AutomationSettings>) {
  const clock = new FakeClock();
  const calls: string[] = [];
  const models: Deferred<void>[] = [];
  const saves: { key: string; attempt: number; result: Deferred<boolean> }[] =
    [];
  const messages: AutomationMessage[] = [];
  let listenOutcome: { ok: boolean; reason?: "permission" | "unavailable" } = {
    ok: true,
  };
  const ports: AutomationPorts = {
    startListening: async (runId) => {
      calls.push(`listen:${runId}`);
      return listenOutcome;
    },
    stopListening: (reason) => calls.push(`stop-listen:${reason}`),
    playModel: (effect) => {
      calls.push(
        `model:${effect.kind}:${effect.wordIds.join("+")}@${effect.speed}`,
      );
      const d = deferred<void>();
      models.push(d);
      return d.promise;
    },
    stopAudio: () => calls.push("stop-audio"),
    savePage: (key, attempt) => {
      calls.push(`save:${key}#${attempt}`);
      const result = deferred<boolean>();
      saves.push({ key, attempt, result });
      return result.promise;
    },
    turnPage: (key) => calls.push(`turn:${key}`),
    finishSession: () => calls.push("finish"),
    giveUpWord: (id) => calls.push(`give-up:${id}`),
    needsPractice: (id) => calls.push(`practice:${id}`),
    show: (message) => {
      messages.push(message);
    },
  };
  const runtime = new ReadingAutomationRuntime(clock, ports, {
    assist: true,
    autoAdvance: true,
    ...settings,
  });
  return {
    clock,
    runtime,
    calls,
    models,
    saves,
    messages,
    setListen(outcome: typeof listenOutcome) {
      listenOutcome = outcome;
    },
    get state() {
      return runtime.getState();
    },
    async start(
      pageId = "p1",
      opts: { isLast?: boolean; startIndex?: number; auto?: boolean } = {},
    ) {
      runtime.dispatch({
        type: "START_PAGE",
        page: page(pageId, opts.isLast),
        words: WORDS,
        startIndex: opts.startIndex,
        auto: opts.auto,
      });
      await flush();
    },
    evidence(
      index: number,
      outcome: "correct" | "retry" | "skipped" = "correct",
      override: Partial<{
        runId: number;
        pageId: string;
        revisionId: string;
      }> = {},
    ) {
      const state = runtime.getState();
      runtime.dispatch({
        type: "WORD_EVIDENCE",
        runId: override.runId ?? state.runId,
        pageId: override.pageId ?? state.page!.pageId,
        revisionId: override.revisionId ?? state.page!.revisionId,
        wordId: `w${index}`,
        outcome,
      });
    },
    speech() {
      runtime.dispatch({
        type: "SPEECH_ACTIVITY",
        runId: runtime.getState().runId,
      });
    },
    count(prefix: string) {
      return calls.filter((call) => call.startsWith(prefix)).length;
    },
  };
}

async function readAllFluently(h: ReturnType<typeof setup>, gap = 700) {
  for (let i = 0; i < WORDS.length; i += 1) {
    await h.clock.advance(gap);
    h.speech();
    h.evidence(i);
  }
  await flush();
}

// ---------------------------------------------------------------------------
describe("fluent reading, automatic page turn (G5, G8)", () => {
  it("needs no click after Start: listen, save once, turn page by itself", async () => {
    const h = setup();
    await h.start("p1");
    expect(h.state.phase).toBe("listening");
    expect(h.count("listen:")).toBe(1);

    await readAllFluently(h);
    expect(h.count("save:")).toBe(1);
    expect(h.state.save.status).toBe("inflight");
    expect(h.count("turn:")).toBe(0); // never before the save is confirmed

    h.saves[0].result.resolve(true);
    await flush();
    expect(h.state.phase).toBe("page-turn");
    await h.clock.advance(DEFAULT_AUTOMATION_CONFIG.autoAdvanceDelayMs + 5);
    expect(h.count("turn:")).toBe(1);
    expect(h.state.wordStates).toEqual(
      Object.fromEntries(WORDS.map((w) => [w.id, "correct"])),
    );
    expect(h.state.needsPractice).toEqual([]);
    // No intervention happened on the way.
    expect(h.count("model:")).toBe(0);
  });

  it("walks through the named states in order", async () => {
    const h = setup();
    const seen: string[] = [];
    const remember = () => {
      if (seen.at(-1) !== h.state.phase) seen.push(h.state.phase);
    };
    await h.start();
    remember();
    h.clock.time += 500;
    h.evidence(0);
    remember();
    await h.clock.advance(700);
    remember();
    for (let i = 1; i < WORDS.length; i += 1) {
      await h.clock.advance(500);
      h.evidence(i);
    }
    remember();
    h.saves[0].result.resolve(true);
    await flush();
    remember();
    expect(seen).toEqual([
      "listening",
      "evidence",
      "listening",
      "evidence",
      "page-turn",
    ]);
  });

  it("finishes the session instead of turning on the last page", async () => {
    const h = setup();
    await h.start("last", { isLast: true });
    await readAllFluently(h);
    h.saves[0].result.resolve(true);
    await h.clock.advance(2000);
    expect(h.count("turn:")).toBe(0);
    expect(h.count("finish")).toBe(1);
    expect(h.state.phase).toBe("complete");
  });

  it("with auto-advance off, waits for the manual button and turns exactly once", async () => {
    const h = setup({ autoAdvance: false });
    await h.start();
    await readAllFluently(h);
    h.saves[0].result.resolve(true);
    await h.clock.advance(60_000);
    expect(h.count("turn:")).toBe(0);
    expect(h.messages).toContain("page-ready");
    h.runtime.dispatch({ type: "MANUAL_NEXT" });
    h.runtime.dispatch({ type: "MANUAL_NEXT" });
    expect(h.count("turn:")).toBe(1);
  });

  it("does not complete or save a page twice when the last word is reported again", async () => {
    const h = setup();
    await h.start();
    await readAllFluently(h);
    h.evidence(5);
    h.evidence(5);
    expect(h.count("save:")).toBe(1);
    h.saves[0].result.resolve(true);
    await flush();
    h.evidence(5);
    await h.clock.advance(5000);
    expect(h.count("save:")).toBe(1);
    expect(h.count("turn:")).toBe(1);
  });

  it("re-reading a persisted page is practice: no second save, first result kept", async () => {
    const h = setup();
    await h.start("p1");
    await readAllFluently(h);
    h.saves[0].result.resolve(true);
    await h.clock.advance(2000);
    await h.start("p1");
    await readAllFluently(h);
    expect(h.count("save:")).toBe(1);
    expect(h.state.save.status).toBe("saved");
  });

  it("resumes from the saved position and finishes a fully-read saved page without listening", async () => {
    const h = setup();
    await h.start("p1", { startIndex: 3 });
    expect(h.state.cursor).toBe(3);
    expect(h.state.wordStates.w2).toBe("correct");
    expect(h.state.wordStates.w3).toBe("pending");
    await h.start("p2", { startIndex: 6 });
    expect(h.count("save:")).toBe(1);
    expect(h.count("listen:")).toBe(1);
  });
});

describe("hesitation and help (G6, G7, G9)", () => {
  it("never interrupts a child who is speaking, however long the page takes", async () => {
    const h = setup();
    await h.start();
    for (let i = 0; i < 40; i += 1) {
      await h.clock.advance(500);
      h.speech();
    }
    expect(h.count("model:")).toBe(0);
    expect(h.messages).not.toContain("gentle-prompt");
  });

  it("prompts gently once, then models the word, not before the adaptive threshold", async () => {
    const h = setup();
    await h.start();
    await h.clock.advance(3900);
    expect(h.count("model:")).toBe(0);
    await h.clock.advance(150);
    expect(h.calls.filter((c) => c.startsWith("model:"))).toEqual([
      "model:prompt:@1",
    ]);
    expect(h.messages.filter((m) => m === "gentle-prompt")).toHaveLength(1);
    expect(h.state.phase).toBe("modeling");

    h.models[0].resolve();
    await flush();
    expect(h.state.phase).toBe("awaiting-retry");
    await h.clock.advance(2500);
    expect(h.count("model:")).toBe(1); // still within promptToHelp
    await h.clock.advance(800);
    expect(h.calls.filter((c) => c.startsWith("model:"))[1]).toBe(
      "model:word:w0@1",
    );
    expect(h.state.helped).toContain("w0");
  });

  it("walks the ladder word → slow → phrase → encourage and skips without ever marking it correct", async () => {
    const h = setup();
    await h.start();
    const kinds: string[] = [];
    for (let round = 0; round < 6 && h.state.cursor === 0; round += 1) {
      await h.clock.advance(60_000);
      const modelCalls = h.calls.filter((c) => c.startsWith("model:"));
      if (modelCalls.length > kinds.length) {
        kinds.push(...modelCalls.slice(kinds.length));
        h.models.at(-1)!.resolve();
        await flush();
      }
    }
    expect(kinds.map((k) => k.split(":")[1])).toEqual([
      "prompt",
      "word",
      "slow-word",
      "phrase",
      "encourage",
    ]);
    expect(kinds[2]).toContain("@0.75");
    expect(kinds[3]).toContain("w0+w1+w2");
    expect(h.calls).toContain("give-up:w0");
    expect(h.calls).toContain("practice:w0");
    expect(h.state.wordStates.w0).toBe("skipped");
    expect(h.state.needsPractice).toContain("w0");
    expect(h.state.cursor).toBe(1);
    expect(h.messages).toContain("encourage");
  });

  it("limits gentle prompts per page and never spams within the cooldown", async () => {
    const h = setup();
    await h.start();
    let prompts = 0;
    for (let round = 0; round < 40; round += 1) {
      await h.clock.advance(15_000);
      while (h.models.length) {
        h.models.shift()!.resolve();
        await flush();
      }
      prompts = h.messages.filter((m) => m === "gentle-prompt").length;
      // The child answers each time so the ladder never gives up.
      h.speech();
      h.evidence(Math.min(h.state.cursor, 5));
      if (h.state.phase === "page-turn" || h.state.phase === "complete") break;
    }
    expect(prompts).toBeLessThanOrEqual(
      DEFAULT_AUTOMATION_CONFIG.maxPromptsPerPage,
    );
  });

  it("adapts to a slow reader and to punctuation before intervening", () => {
    let state = createAutomationState();
    state = reduce(state, {
      type: "START_PAGE",
      at: 0,
      page: page("p1"),
      words: WORDS.map((w, i) => ({ id: w.id, punctAfter: i === 2 })),
    }).state;
    state = reduce(state, {
      type: "LISTEN_RESULT",
      at: 10,
      runId: state.runId,
      ok: true,
    }).state;
    const fast = nextWakeAt(state, 0)!;

    let slow = state;
    let t = 10;
    for (let i = 0; i < 2; i += 1) {
      t += 3500;
      slow = reduce(slow, {
        type: "WORD_EVIDENCE",
        at: t,
        runId: slow.runId,
        pageId: "p1",
        revisionId: "r1",
        wordId: `w${i}`,
        outcome: "correct",
      }).state;
    }
    slow = reduce(slow, {
      type: "TICK",
      at: t + DEFAULT_AUTOMATION_CONFIG.evidenceLingerMs,
    }).state;
    const slowDelay = nextWakeAt(slow, t)! - t;
    expect(fast).toBe(DEFAULT_AUTOMATION_CONFIG.hesitationMinMs);
    expect(slowDelay).toBeGreaterThan(
      DEFAULT_AUTOMATION_CONFIG.hesitationMinMs,
    );
    expect(slowDelay).toBeLessThanOrEqual(
      DEFAULT_AUTOMATION_CONFIG.hesitationMaxMs * 1.5,
    );

    // Right after a word that ends a clause, the allowed pause is longer.
    const afterPunctuation = reduce(
      { ...state, cursor: 3 },
      { type: "TICK", at: 10 },
    ).state;
    const plain = reduce(
      { ...state, cursor: 2 },
      { type: "TICK", at: 10 },
    ).state;
    expect(
      nextWakeAt(afterPunctuation, 10)! / nextWakeAt(plain, 10)!,
    ).toBeCloseTo(DEFAULT_AUTOMATION_CONFIG.punctuationFactor, 5);
  });

  it("answers an explicit help request immediately, regardless of the assist setting", async () => {
    for (const assist of [true, false]) {
      const h = setup({ assist });
      await h.start();
      h.clock.time = 1000;
      const before = h.calls.length;
      h.runtime.dispatch({
        type: "HELP_REQUEST",
        scope: "word",
        source: "voice",
      });
      const effects = h.runtime.log.filter((e) => e.type === "PLAY_MODEL");
      expect(effects).toHaveLength(1);
      expect(h.calls.slice(before)[1]).toBe("model:word:w0@1");
      expect(h.clock.time).toBe(1000); // zero logical latency (G7)
    }
  });

  it("with assist off, never prompts or models on silence", async () => {
    const h = setup({ assist: false });
    await h.start();
    await h.clock.advance(120_000);
    expect(h.count("model:")).toBe(0);
    expect(h.messages).not.toContain("gentle-prompt");
  });

  it("an error the child fixes within the window triggers no help", async () => {
    const h = setup();
    await h.start();
    await h.clock.advance(1000);
    h.speech();
    h.evidence(0, "retry");
    await h.clock.advance(900);
    h.speech();
    h.evidence(0, "correct"); // self-correction
    await h.clock.advance(3000);
    expect(h.count("model:")).toBe(0);
    expect(h.state.wordStates.w0).toBe("correct");
    expect(h.state.stuckWordId).toBeNull();
  });

  it("an error the child moves past is left for 'needs practice', not interrupted", async () => {
    const h = setup();
    await h.start();
    await h.clock.advance(500);
    h.evidence(0, "correct");
    await h.clock.advance(500);
    h.evidence(1, "retry");
    await h.clock.advance(400);
    h.speech();
    h.evidence(2, "correct");
    await h.clock.advance(1500);
    expect(h.count("model:")).toBe(0);
    expect(h.state.wordStates.w1).toBe("retry");
    expect(h.state.needsPractice).toContain("w1");
  });

  it("a clear error followed by silence is modelled after the self-correction window", async () => {
    const h = setup();
    await h.start();
    await h.clock.advance(500);
    h.evidence(0, "retry");
    await h.clock.advance(1400);
    expect(h.count("model:")).toBe(0);
    await h.clock.advance(300);
    expect(h.calls.find((c) => c.startsWith("model:"))).toBe("model:word:w0@1");
  });

  it("a helped word that is then read is assisted, never plain correct", async () => {
    const h = setup();
    await h.start();
    h.runtime.dispatch({
      type: "HELP_REQUEST",
      scope: "word",
      source: "button",
    });
    h.models[0].resolve();
    await h.clock.advance(400);
    h.speech();
    h.evidence(0, "correct");
    expect(h.state.wordStates.w0).toBe("assisted");
  });

  it("drops evidence that arrives while the app is speaking", async () => {
    const h = setup();
    await h.start();
    h.runtime.dispatch({
      type: "HELP_REQUEST",
      scope: "word",
      source: "button",
    });
    expect(h.state.phase).toBe("modeling");
    h.evidence(0, "correct");
    expect(h.state.wordStates.w0).toBe("pending");
    expect(h.state.cursor).toBe(0);
  });

  it("reopens the microphone after the sample, never before it ended", async () => {
    const h = setup();
    await h.start();
    h.runtime.dispatch({
      type: "HELP_REQUEST",
      scope: "word",
      source: "button",
    });
    await h.clock.advance(5000);
    expect(h.count("listen:")).toBe(1); // still modelling
    h.models[0].resolve();
    await flush();
    expect(h.count("listen:")).toBe(1);
    await h.clock.advance(300);
    expect(h.count("listen:")).toBe(2);
  });
});

describe("pause, permission, offline and recovery (G6, G8, G10)", () => {
  it("a stop is not overridden by late STT, late audio or timers; resume reopens once", async () => {
    const h = setup();
    await h.start();
    h.runtime.dispatch({
      type: "HELP_REQUEST",
      scope: "word",
      source: "button",
    });
    const staleRun = h.state.runId;
    const staleGen = h.state.modeling!.gen;
    h.runtime.dispatch({ type: "PAUSE", by: "child" });
    expect(h.calls).toContain("stop-audio");
    expect(h.calls).toContain("stop-listen:pause");
    const listens = h.count("listen:");

    // Late arrivals from before the stop.
    h.runtime.dispatch({ type: "MODEL_ENDED", gen: staleGen });
    h.runtime.dispatch({
      type: "WORD_EVIDENCE",
      runId: staleRun,
      pageId: "p1",
      revisionId: "r1",
      wordId: "w0",
      outcome: "correct",
    });
    h.runtime.dispatch({ type: "LISTEN_RESULT", runId: staleRun, ok: true });
    await h.clock.advance(300_000);
    expect(h.count("listen:")).toBe(listens);
    expect(h.state.wordStates.w0).toBe("pending");
    expect(h.state.phase).toBe("paused");

    h.runtime.dispatch({ type: "RESUME" });
    await flush();
    expect(h.count("listen:")).toBe(listens + 1);
  });

  it("a pause cancels a pending automatic page turn", async () => {
    const h = setup();
    await h.start();
    await readAllFluently(h);
    h.saves[0].result.resolve(true);
    await flush();
    h.runtime.dispatch({ type: "PAUSE", by: "parent" });
    await h.clock.advance(30_000);
    expect(h.count("turn:")).toBe(0);
    h.runtime.dispatch({ type: "RESUME" });
    await h.clock.advance(1000);
    expect(h.count("turn:")).toBe(1);
  });

  it("an automatic start after a page turn is ignored if the child stopped", async () => {
    const h = setup();
    await h.start("p1");
    h.runtime.dispatch({ type: "PAUSE", by: "child" });
    const listens = h.count("listen:");
    await h.start("p2", { auto: true });
    expect(h.count("listen:")).toBe(listens);
    expect(h.state.page?.pageId).toBe("p1");
    await h.start("p2"); // explicit Start
    expect(h.count("listen:")).toBe(listens + 1);
  });

  it("missing permission asks once and never loops on the microphone", async () => {
    const h = setup();
    h.setListen({ ok: false, reason: "permission" });
    await h.start();
    expect(h.state.phase).toBe("permission-needed");
    expect(h.messages).toContain("permission-needed");
    await h.clock.advance(300_000);
    expect(h.count("listen:")).toBe(1);
    expect(h.count("model:")).toBe(0);
    h.setListen({ ok: true });
    h.runtime.dispatch({ type: "PERMISSION", granted: true });
    await flush();
    expect(h.count("listen:")).toBe(2);
    expect(h.state.phase).toBe("listening");
  });

  it("losing the network pauses interventions, keeps progress, and recovers", async () => {
    const h = setup();
    await h.start();
    await h.clock.advance(500);
    h.evidence(0);
    h.runtime.dispatch({ type: "NETWORK", online: false });
    expect(h.state.phase).toBe("offline");
    await h.clock.advance(120_000);
    expect(h.count("model:")).toBe(0);
    expect(h.state.wordStates.w0).toBe("correct");
    h.runtime.dispatch({ type: "NETWORK", online: true });
    await flush();
    expect(h.messages).toContain("recovered");
    expect(h.state.phase).toBe("listening");
    expect(h.state.cursor).toBe(1);
  });

  it("a failed save never turns the page and retries the same idempotent key with backoff", async () => {
    const h = setup();
    await h.start();
    await readAllFluently(h);
    const key = h.saves[0].key;
    h.saves[0].result.resolve(false);
    await flush();
    expect(h.messages).toContain("unsaved");
    await h.clock.advance(DEFAULT_AUTOMATION_CONFIG.saveRetryBaseMs + 10);
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1].key).toBe(key);
    expect(h.saves[1].attempt).toBe(2);
    h.saves[1].result.resolve(false);
    await flush();
    await h.clock.advance(DEFAULT_AUTOMATION_CONFIG.saveRetryBaseMs + 10);
    expect(h.saves).toHaveLength(2); // second back-off is longer
    await h.clock.advance(DEFAULT_AUTOMATION_CONFIG.saveRetryBaseMs * 2);
    expect(h.saves).toHaveLength(3);
    expect(h.count("turn:")).toBe(0);
    h.saves[2].result.resolve(true);
    await h.clock.advance(1000);
    expect(h.count("turn:")).toBe(1);
    expect(new Set(h.saves.map((s) => s.key)).size).toBe(1);
  });

  it("while offline a failed save waits for the network and then retries immediately", async () => {
    const h = setup();
    await h.start();
    await readAllFluently(h);
    h.runtime.dispatch({ type: "NETWORK", online: false });
    h.saves[0].result.resolve(false);
    await flush();
    await h.clock.advance(120_000);
    expect(h.saves).toHaveLength(1);
    expect(h.count("turn:")).toBe(0);
    h.runtime.dispatch({ type: "NETWORK", online: true });
    await h.clock.advance(1);
    expect(h.saves).toHaveLength(2);
    h.saves[1].result.resolve(true);
    await h.clock.advance(1000);
    expect(h.count("turn:")).toBe(1);
  });

  it("ignores events from another session, page, revision, run, model or save", async () => {
    const h = setup();
    await h.start("p1");
    const oldRun = h.state.runId;
    await h.start("p2");
    h.evidence(0, "correct", { runId: oldRun });
    h.evidence(0, "correct", { pageId: "p1" });
    h.evidence(0, "correct", { revisionId: "r0" });
    expect(h.state.wordStates.w0).toBe("pending");
    h.runtime.dispatch({ type: "SAVE_RESULT", key: "s1:p1:r1", ok: true });
    h.runtime.dispatch({ type: "MODEL_ENDED", gen: 999 });
    expect(h.state.save.status).toBe("idle");
    h.evidence(0, "correct");
    expect(h.state.wordStates.w0).toBe("correct");
  });

  it("session end is terminal", async () => {
    const h = setup();
    await h.start();
    h.runtime.dispatch({ type: "SESSION_END" });
    const before = h.calls.length;
    h.evidence(0);
    h.runtime.dispatch({ type: "RESUME" });
    await h.clock.advance(120_000);
    expect(h.calls.length).toBe(before);
    expect(h.state.phase).toBe("complete");
  });

  it("toggling auto-advance cancels or re-arms a pending turn", async () => {
    const h = setup();
    await h.start();
    await readAllFluently(h);
    h.saves[0].result.resolve(true);
    await flush();
    h.runtime.dispatch({
      type: "SET_SETTINGS",
      settings: { autoAdvance: false },
    });
    await h.clock.advance(10_000);
    expect(h.count("turn:")).toBe(0);
    h.runtime.dispatch({
      type: "SET_SETTINGS",
      settings: { autoAdvance: true },
    });
    await h.clock.advance(1000);
    expect(h.count("turn:")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Property-style: random event orders must preserve the invariants.
// ---------------------------------------------------------------------------
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomEvent(
  random: () => number,
  state: AutomationState,
  at: number,
  pageCounter: number,
): AutomationEvent {
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)];
  const staleRun = random() < 0.15;
  const runId = staleRun ? state.runId - 1 : state.runId;
  const pageId = state.page && random() > 0.1 ? state.page.pageId : "other";
  const word = `w${Math.floor(random() * WORDS.length)}`;
  const kind = pick([
    "START",
    "LISTEN",
    "SPEECH",
    "EVIDENCE",
    "EVIDENCE",
    "EVIDENCE",
    "HELP",
    "MODEL_END",
    "MODEL_FAIL",
    "PAUSE",
    "RESUME",
    "PERMISSION",
    "NETWORK",
    "SAVE",
    "NEXT",
    "TICK",
    "TICK",
    "TICK",
    "SETTINGS",
    "UNSURE",
  ] as const);
  switch (kind) {
    case "START":
      return {
        type: "START_PAGE",
        at,
        page: page(`p${pageCounter}`, random() < 0.2),
        words: WORDS,
        startIndex: random() < 0.2 ? Math.floor(random() * 7) : 0,
        auto: random() < 0.5,
      };
    case "LISTEN":
      return {
        type: "LISTEN_RESULT",
        at,
        runId,
        ok: random() < 0.8,
        reason: pick(["permission", "unavailable"] as const),
      };
    case "SPEECH":
      return { type: "SPEECH_ACTIVITY", at, runId };
    case "EVIDENCE":
      return {
        type: "WORD_EVIDENCE",
        at,
        runId,
        pageId,
        revisionId: "r1",
        wordId: word,
        outcome: pick(["correct", "correct", "retry", "skipped"] as const),
      };
    case "HELP":
      return {
        type: "HELP_REQUEST",
        at,
        scope: pick(["word", "phrase"] as const),
        source: pick(["voice", "button"] as const),
      };
    case "MODEL_END":
      return {
        type: "MODEL_ENDED",
        at,
        gen: state.modeling?.gen ?? state.modelGen - Math.floor(random() * 2),
      };
    case "MODEL_FAIL":
      return {
        type: "MODEL_FAILED",
        at,
        gen: state.modeling?.gen ?? state.modelGen,
      };
    case "PAUSE":
      return {
        type: "PAUSE",
        at,
        by: pick([
          "child",
          "parent",
          "background",
          "presence",
          "voice",
        ] as const),
      };
    case "RESUME":
      return { type: "RESUME", at };
    case "PERMISSION":
      return { type: "PERMISSION", at, granted: random() < 0.6 };
    case "NETWORK":
      return { type: "NETWORK", at, online: random() < 0.6 };
    case "SAVE":
      return {
        type: "SAVE_RESULT",
        at,
        key: random() < 0.85 ? state.save.key : "stale-key",
        ok: random() < 0.6,
      };
    case "NEXT":
      return { type: "MANUAL_NEXT", at };
    case "SETTINGS":
      return {
        type: "SET_SETTINGS",
        at,
        settings: { assist: random() < 0.7, autoAdvance: random() < 0.7 },
      };
    case "UNSURE":
      return { type: "UNSURE_POSITION", at, runId };
    default:
      return { type: "TICK", at };
  }
}

function assertInvariants(
  before: AutomationState,
  event: AutomationEvent,
  after: AutomationState,
  effects: readonly AutomationEffect[],
  ctx: {
    pageEpoch: number;
    saveCount: Map<string, number>;
    turnCount: Map<number, number>;
  },
) {
  const manualHelp = event.type === "HELP_REQUEST";
  const stopped = before.userStopped && after.userStopped;
  // I1: stopped => no automatic mic opening or voice, unless explicitly asked.
  if (stopped) {
    expect(effects.some((e) => e.type === "START_LISTENING")).toBe(false);
    if (!manualHelp)
      expect(effects.some((e) => e.type === "PLAY_MODEL")).toBe(false);
    expect(
      effects.some(
        (e) => e.type === "TURN_PAGE" || e.type === "FINISH_SESSION",
      ),
    ).toBe(false);
  }
  // I5: no intervention while the child is speaking.
  if (
    event.type === "TICK" &&
    event.at - before.lastSpeechAt < before.config.speechQuietMs
  ) {
    expect(effects.some((e) => e.type === "PLAY_MODEL")).toBe(false);
  }
  // I6: assisted/skipped never green.
  for (const id of after.needsPractice) {
    expect(after.wordStates[id]).not.toBe("correct");
  }
  for (const id of after.helped) {
    expect(after.wordStates[id]).not.toBe("correct");
  }
  // I2/I3: counting.
  for (const effect of effects) {
    if (effect.type === "SAVE_PAGE") {
      // Never a second *first* attempt for a key already persisted.
      expect(after.savedKeys.includes(effect.key) && effect.attempt === 1).toBe(
        false,
      );
      if (effect.attempt === 1) {
        ctx.saveCount.set(effect.key, (ctx.saveCount.get(effect.key) ?? 0) + 1);
      }
    }
    if (effect.type === "TURN_PAGE" || effect.type === "FINISH_SESSION") {
      ctx.turnCount.set(
        ctx.pageEpoch,
        (ctx.turnCount.get(ctx.pageEpoch) ?? 0) + 1,
      );
      expect(ctx.turnCount.get(ctx.pageEpoch)).toBe(1);
      // A page only turns after its save was confirmed.
      expect(after.save.status).toBe("saved");
    }
  }
  // Ended is terminal.
  if (before.ended) expect(after.ended).toBe(true);
}

describe("random event orders keep the invariants", () => {
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))("seed %i", (seed) => {
    const random = mulberry32(seed * 7919);
    let state = createAutomationState();
    let at = 0;
    let pageCounter = 1;
    let pageEpoch = 0;
    const ctx = {
      pageEpoch,
      saveCount: new Map<string, number>(),
      turnCount: new Map<number, number>(),
    };
    state = reduce(state, {
      type: "START_PAGE",
      at,
      page: page("p1"),
      words: WORDS,
    }).state;
    for (let step = 0; step < 150; step += 1) {
      at += Math.floor(random() * 2500);
      const event = randomEvent(random, state, at, pageCounter);
      if (event.type === "START_PAGE") {
        pageCounter += 1;
        // Only an accepted start begins a new visit.
        const accepted = !(event.auto && state.userStopped) && !state.ended;
        if (accepted) {
          pageEpoch += 1;
          ctx.pageEpoch = pageEpoch;
        }
      }
      const result = reduce(state, event);
      assertInvariants(state, event, result.state, result.effects, ctx);
      state = result.state;
      // The scheduler contract: a wake-up time is never in the past.
      const wake = nextWakeAt(state, at);
      if (wake !== null) expect(wake).toBeGreaterThanOrEqual(at);
    }
    // A first save attempt for the same key never happened twice within the
    // same visit unless the key was re-entered as a new visit.
    for (const count of ctx.saveCount.values()) {
      expect(count).toBeLessThanOrEqual(pageCounter);
    }
  });
});
