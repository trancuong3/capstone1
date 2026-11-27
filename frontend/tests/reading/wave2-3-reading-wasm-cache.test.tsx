import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadingCompanionBubble } from "@/components/reading/reading-companion-bubble";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import {
  BrowserWasmSttClient,
  getWasmModelCacheStatus,
  resetBrowserWasmSttForTests,
} from "@/lib/reading/browser-wasm-stt";
import { LocalSegmentSpeechRecognition } from "@/lib/reading/local-segment-speech-recognition";
import {
  createAutomationState,
  reduce,
} from "@/lib/reading/reading-automation";
import { RealtimeAlignmentEngine } from "@/lib/reading/realtime-alignment";
import {
  lockSessionVoice,
  resetVoiceLockAndPolicyForTests,
  setVoicePolicyPreferences,
} from "@/lib/reading/session-voice-lock";
import {
  resetSpeechPreferencesCache,
  setSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import {
  clearBrowserTtsCacheForTests,
  getBrowserTtsCacheStats,
  getCachedTtsAudio,
  putCachedTtsAudio,
} from "@/lib/reading/tts-audio-cache";
import { TtsPlayback } from "@/lib/reading/tts-playback";

const { voiceStudioMock } = vi.hoisted(() => ({
  voiceStudioMock: {
    listVoices: vi.fn(),
    synthesizeTimed: vi.fn(),
  },
}));

vi.mock("@/lib/api/voice-studio-service", () => ({
  createVoiceStudioService: () => voiceStudioMock,
}));

describe("Wave 2+3 reading core, WASM STT, cache, and hooks regressions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    resetSpeechPreferencesCache();
    resetVoiceLockAndPolicyForTests();
    resetBrowserWasmSttForTests();
    voiceStudioMock.listVoices.mockReset();
    voiceStudioMock.synthesizeTimed.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("terminates crashed WASM worker on worker.onerror and respawns cleanly on retry", async () => {
    const terminated: number[] = [];
    let workerCount = 0;

    class FakeWorker {
      id: number;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: { message?: string }) => void) | null = null;
      constructor() {
        this.id = ++workerCount;
      }
      postMessage(msg: { type: string; id: string }) {
        if (this.id === 1 && msg.type === "init") {
          queueMicrotask(() => {
            this.onerror?.({ message: "oom crash" });
          });
          return;
        }
        if (msg.type === "init") {
          queueMicrotask(() => {
            this.onmessage?.({
              data: { type: "ready", id: msg.id },
            } as MessageEvent);
          });
        }
      }
      terminate() {
        terminated.push(this.id);
      }
    }

    vi.stubGlobal("Worker", FakeWorker);
    const client = new BrowserWasmSttClient();

    await expect(client.init()).rejects.toThrow(/oom crash/);
    expect(terminated).toEqual([1]);

    // Subsequent init spawns a fresh worker and resolves cleanly
    await expect(client.init()).resolves.toBeUndefined();
    expect(workerCount).toBe(2);

    client.dispose();
    expect(terminated).toEqual([1, 2]);
  });

  it("resolves getWasmModelCacheStatus and closes DB when IndexedDB transaction aborts", async () => {
    const closeSpy = vi.fn();
    vi.stubGlobal("indexedDB", {
      open: () => {
        const openReq: {
          result: unknown;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          onupgradeneeded: (() => void) | null;
        } = {
          result: {
            objectStoreNames: { contains: () => true },
            createObjectStore: vi.fn(),
            close: closeSpy,
            transaction: () => {
              const tx: {
                onabort: (() => void) | null;
                onerror: (() => void) | null;
                objectStore: () => { get: () => Record<string, unknown> };
              } = {
                onabort: null,
                onerror: null,
                objectStore: () => ({
                  get: () => {
                    queueMicrotask(() => tx.onabort?.());
                    return { onsuccess: null, onerror: null };
                  },
                }),
              };
              return tx;
            },
          },
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => openReq.onsuccess?.());
        return openReq;
      },
    });

    const status = await getWasmModelCacheStatus();
    expect(status.ready).toBe(false);
    expect(status.cachedFiles).toBe(0);
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("aborts in-flight model downloads, resets recognizerPromise, and closes DB on worker dispose", async () => {
    const workerSrc = fs.readFileSync(
      path.resolve(__dirname, "../../public/workers/sherpa-stt-worker.js"),
      "utf8",
    );

    const posted: Array<Record<string, unknown>> = [];
    const dbCloseSpy = vi.fn();
    let capturedSignal: AbortSignal | undefined;
    let rejectFetch!: (reason: unknown) => void;

    const fakeIndexedDb = {
      open: () => {
        const dbObj = {
          objectStoreNames: { contains: () => true },
          createObjectStore: vi.fn(),
          close: dbCloseSpy,
          transaction: () => ({
            oncomplete: null,
            onerror: null,
            onabort: null,
            objectStore: () => ({
              get: () => {
                const req: {
                  result: unknown;
                  onsuccess: (() => void) | null;
                  onerror: (() => void) | null;
                } = { result: undefined, onsuccess: null, onerror: null };
                queueMicrotask(() => req.onsuccess?.());
                return req;
              },
            }),
          }),
        };
        const req: {
          result: typeof dbObj;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          onupgradeneeded: (() => void) | null;
        } = {
          result: dbObj,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => req.onsuccess?.());
        return req;
      },
    };

    const fakeSelf: Record<string, unknown> = {
      performance: { now: () => 100 },
      postMessage: (m: Record<string, unknown>) => posted.push(m),
      indexedDB: fakeIndexedDb,
      crypto: { subtle: { digest: vi.fn() } },
      onmessage: null,
    };

    const fakeFetch = vi.fn((_url: string, opts?: { signal?: AbortSignal }) => {
      capturedSignal = opts?.signal;
      return new Promise((_, reject) => {
        rejectFetch = reject;
        opts?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    });

    vm.runInNewContext(workerSrc, {
      self: fakeSelf,
      fetch: fakeFetch,
      crypto: fakeSelf.crypto,
      indexedDB: fakeIndexedDb,
      AbortController,
      setTimeout,
      clearTimeout,
      importScripts: () => {
        const mod = fakeSelf.Module as Record<string, unknown>;
        mod.FS_unlink = vi.fn();
        mod.FS_createDataFile = vi.fn();
        (mod.onRuntimeInitialized as () => void)();
      },
      Float32Array,
      Uint8Array,
      ArrayBuffer,
      Map,
      Set,
      Promise,
      Error,
      Date,
    });

    const onmessage = fakeSelf.onmessage as (ev: {
      data: Record<string, unknown>;
    }) => Promise<void>;

    const initTask = onmessage({ data: { type: "init", id: "init_1" } });
    await vi.waitFor(() => expect(fakeFetch).toHaveBeenCalledTimes(1));
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal?.aborted).toBe(false);

    await onmessage({ data: { type: "dispose", id: "dispose_1" } });
    expect(capturedSignal?.aborted).toBe(true);
    rejectFetch(new DOMException("Aborted", "AbortError"));
    await initTask;

    expect(dbCloseSpy).toHaveBeenCalledTimes(1);
    expect(posted.some((m) => m.type === "disposed")).toBe(true);
    expect(posted.some((m) => m.type === "error" && m.id === "init_1")).toBe(
      true,
    );
  });

  it("reads only lightweight metadata (zero entries.getAll blob scans) and handles tx.onabort in tts-audio-cache", async () => {
    const storeMaps = new Map<string, Map<string, unknown>>();
    const getAllStoresCalled: string[] = [];
    let abortNextWrite = false;
    const closeSpy = vi.fn();

    const makeReq = <T,>(run: () => T) => {
      const req: {
        result: T | undefined;
        onsuccess: (() => void) | null;
        onerror: (() => void) | null;
      } = { result: undefined, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        req.result = run();
        req.onsuccess?.();
      });
      return req;
    };

    const getMap = (name: string) => {
      let map = storeMaps.get(name);
      if (!map) {
        map = new Map<string, unknown>();
        storeMaps.set(name, map);
      }
      return map;
    };

    vi.stubGlobal("indexedDB", {
      open: () => {
        const dbObj = {
          objectStoreNames: {
            contains: (name: string) => name === "entries" || name === "meta",
          },
          createObjectStore: vi.fn((name: string) => getMap(name)),
          close: closeSpy,
          transaction: (_stores: string | string[], mode: string) => {
            const tx: {
              oncomplete: (() => void) | null;
              onerror: (() => void) | null;
              onabort: (() => void) | null;
              objectStore: (name: string) => Record<string, unknown>;
            } = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: (name: string) => {
                const map = getMap(name);
                return {
                  get: (key: string) => makeReq(() => map.get(key)),
                  getAll: () => {
                    getAllStoresCalled.push(name);
                    return makeReq(() => Array.from(map.values()));
                  },
                  put: (value: { key: string }) =>
                    makeReq(() => {
                      if (abortNextWrite && mode === "readwrite") {
                        queueMicrotask(() => tx.onabort?.());
                        return value.key;
                      }
                      map.set(value.key, value);
                      queueMicrotask(() => tx.oncomplete?.());
                      return value.key;
                    }),
                  delete: (key: string) =>
                    makeReq(() => {
                      map.delete(key);
                      return undefined;
                    }),
                  clear: () =>
                    makeReq(() => {
                      map.clear();
                      queueMicrotask(() => tx.oncomplete?.());
                      return undefined;
                    }),
                };
              },
            };
            return tx;
          },
        };
        const openReq: {
          result: typeof dbObj;
          onsuccess: (() => void) | null;
          onerror: (() => void) | null;
          onupgradeneeded: (() => void) | null;
        } = {
          result: dbObj,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => openReq.onsuccess?.());
        return openReq;
      },
    });

    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], {
      type: "audio/mpeg",
    });
    const saved = await putCachedTtsAudio({
      key: "clip_1",
      audio: blob,
      scope: "CATALOG",
    });
    expect(saved).toBe(true);

    const stats = await getBrowserTtsCacheStats();
    expect(stats.entryCount).toBe(1);
    expect(stats.usedBytes).toBe(4);
    expect(getAllStoresCalled).toEqual(["meta", "meta"]);
    expect(getAllStoresCalled).not.toContain("entries");

    const hit = await getCachedTtsAudio("clip_1");
    expect(hit?.size).toBe(4);

    // Abort handling resolves false cleanly and closes DB
    abortNextWrite = true;
    const abortedSave = await putCachedTtsAudio({
      key: "clip_2",
      audio: blob,
      scope: "CATALOG",
    });
    expect(abortedSave).toBe(false);
    abortNextWrite = false;

    await clearBrowserTtsCacheForTests();
    expect(closeSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("resumes listening on WAIT_REQUESTED when modeling or not yet listening", () => {
    const base = createAutomationState();
    const started = reduce(base, {
      type: "START_PAGE",
      at: 1000,
      page: {
        sessionId: "s1",
        pageId: "p1",
        revisionId: "r1",
        isLastPage: false,
      },
      words: [
        { id: "w1", punctAfter: false },
        { id: "w2", punctAfter: true },
      ],
    });

    // Case 1: WAIT_REQUESTED while modeling -> stops audio and schedules resumeListenAt
    const modelingState = {
      ...started.state,
      phase: "modeling" as const,
      listening: false,
      modeling: { gen: 2, wordId: "w1" },
    };
    const waited = reduce(modelingState, {
      type: "WAIT_REQUESTED",
      at: 5000,
      extendMs: 15_000,
    });
    expect(waited.effects.some((e) => e.type === "STOP_AUDIO")).toBe(true);
    expect(waited.state.resumeListenAt).toBe(
      5000 + modelingState.config.resumeAfterModelMs,
    );

    const resumed = reduce(waited.state, {
      type: "TICK",
      at: waited.state.resumeListenAt!,
    });
    expect(resumed.effects.some((e) => e.type === "START_LISTENING")).toBe(
      true,
    );
    expect(resumed.state.resumeListenAt).toBeNull();
    expect(resumed.state.phase).toBe("listening");

    // Case 2: WAIT_REQUESTED while not modeling and not listening -> immediately emits START_LISTENING
    const idleListeningState = {
      ...started.state,
      listening: false,
      modeling: null,
      permissionMissing: false,
    };
    const waitedIdle = reduce(idleListeningState, {
      type: "WAIT_REQUESTED",
      at: 6000,
    });
    expect(waitedIdle.effects.some((e) => e.type === "START_LISTENING")).toBe(
      true,
    );
    expect(waitedIdle.state.runId).toBeGreaterThan(idleListeningState.runId);
  });

  it("cancels hung browser SpeechSynthesis via watchdog and keeps shortCacheBytes non-negative", async () => {
    vi.useFakeTimers();
    const cancelSpy = vi.fn();
    const speakSpy = vi.fn();
    const fakeSynth = {
      speaking: true,
      pending: false,
      getVoices: () => [{ lang: "vi-VN", name: "Vietnamese", default: true }],
      speak: speakSpy,
      cancel: cancelSpy,
      pause: vi.fn(),
      resume: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    class FakeUtterance {
      text: string;
      lang = "";
      rate = 1;
      voice: unknown = null;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((ev: { error?: string }) => void) | null = null;
      onboundary: ((ev: { charIndex?: number }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    }
    vi.stubGlobal("speechSynthesis", fakeSynth);
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });

    const speech = {
      synthesize: vi.fn().mockRejectedValue(new Error("local down")),
    };
    const studio = {
      listVoices: vi.fn(),
      synthesizeTimed: vi.fn(),
    };

    const playback = new TtsPlayback(speech as never, studio as never);
    const playPromise = playback.play("Con mèo");

    // Advance past 40ms cancel-delay + 8s minimum watchdog deadline without firing onend
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(playPromise).resolves.toBeUndefined();
    expect(cancelSpy).toHaveBeenCalled();

    // Verify shortCacheBytes guard never goes negative
    const internal = playback as unknown as {
      shortCacheBytes: number;
      cacheShort: (
        key: string,
        entry: {
          audio: Blob;
          usedFallbackVoice: boolean;
          cachedSpeed: number | null;
        },
      ) => void;
    };
    internal.shortCacheBytes = 0;
    internal.cacheShort("k1", {
      audio: new Blob([new Uint8Array(100)]),
      usedFallbackVoice: false,
      cachedSpeed: 1,
    });
    // Simulate accounting drift & overwrite
    internal.shortCacheBytes = 10;
    internal.cacheShort("k1", {
      audio: new Blob([new Uint8Array(50)]),
      usedFallbackVoice: false,
      cachedSpeed: 1,
    });
    expect(internal.shortCacheBytes).toBeGreaterThanOrEqual(0);
  });

  it("strips Vietnamese hesitation FILLER_WORDS before computing isOffTopicText", () => {
    const engine = new RealtimeAlignmentEngine([
      { word_id: "w1", word_index: 10, text: "Con", bbox: [0, 0, 0.1, 0.1] },
      { word_id: "w2", word_index: 20, text: "mèo", bbox: [0.1, 0, 0.1, 0.1] },
      { word_id: "w3", word_index: 30, text: "đang", bbox: [0.2, 0, 0.1, 0.1] },
      { word_id: "w4", word_index: 40, text: "ngủ", bbox: [0.3, 0, 0.1, 0.1] },
    ]);

    expect(engine.isOffTopicText("ờ ừm ầm con mèo")).toBe(false);
    expect(engine.isOffTopicText("ờ ừm con")).toBe(false);
    expect(engine.isOffTopicText("ờ ừm mẹ ơi con đói bụng quá")).toBe(true);
  });

  it("fences async openAudioGraph and stop callbacks by epoch across rapid abort/restart", async () => {
    let resolveGsm!: (stream: MediaStream) => void;
    const stopTrackSpy = vi.fn();
    const fakeStream = {
      getTracks: () => [{ stop: stopTrackSpy, readyState: "live" }],
      getAudioTracks: () => [{ stop: stopTrackSpy, readyState: "live" }],
    } as unknown as MediaStream;

    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(
          () =>
            new Promise<MediaStream>((resolve) => {
              resolveGsm = resolve;
            }),
        ),
      },
    });

    const speechService = {
      transcribeSegment: vi.fn(),
      getVoiceSttStreamInfo: vi.fn().mockResolvedValue(null),
    };
    const rec = new LocalSegmentSpeechRecognition(speechService as never);
    const onend = vi.fn();
    rec.onend = onend;

    rec.start();
    const firstEpoch = rec.getEpoch();
    rec.abort();
    expect(rec.getEpoch()).toBe(firstEpoch + 1);
    onend.mockClear();

    // Late getUserMedia resolution from aborted epoch MUST stop tracks and never fire another onend
    resolveGsm(fakeStream);
    await Promise.resolve();
    await Promise.resolve();

    expect(stopTrackSpy).toHaveBeenCalledTimes(1);
    expect(onend).not.toHaveBeenCalled();
  });

  it("renders accurate offline cache badges/notices for explicit empty or single non-default cached_voice_ids and hides backend/.env", async () => {
    voiceStudioMock.listVoices.mockResolvedValue({
      default_voice_id: "local_north_truc_ly",
      local_worker_ready: false,
      cached_voice_ids: [],
      voices: [
        {
          voice_id: "local_north_truc_ly",
          name: "Cô Trúc Ly - Miền Bắc",
          gender: "female",
          region: "north",
          provider: "local",
        },
        {
          voice_id: "local_south_thuc_doan",
          name: "Cô Thục Đoan - Miền Nam",
          gender: "female",
          region: "south",
          provider: "local",
        },
      ],
    });

    const user = userEvent.setup();
    const { unmount } = render(
      <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await screen.findByRole("radio", { name: /Cô Trúc Ly/ });

    // Explicit cached_voice_ids: [] MUST NOT show false "Sẵn Wi-Fi" badge on default voice
    expect(
      screen.queryByTestId("voice-wifi-ready-badge-local_north_truc_ly"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("voice-offline-cache-notice")).toHaveTextContent(
      /Giọng đọc trực tuyến hiện đang tạm nghỉ/i,
    );

    // Verify technical provider toggle and raw file paths are never rendered
    expect(
      screen.queryByRole("button", { name: /Máy này \+ Google dự phòng/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/backend\/\.env/i)).not.toBeInTheDocument();
    unmount();

    // Single non-default cached voice names the actual cached voice
    voiceStudioMock.listVoices.mockResolvedValue({
      default_voice_id: "local_north_truc_ly",
      local_worker_ready: false,
      cached_voice_ids: ["local_south_thuc_doan"],
      voices: [
        {
          voice_id: "local_north_truc_ly",
          name: "Cô Trúc Ly - Miền Bắc",
          gender: "female",
          region: "north",
          provider: "local",
        },
        {
          voice_id: "local_south_thuc_doan",
          name: "Cô Thục Đoan - Miền Nam",
          gender: "female",
          region: "south",
          provider: "local",
        },
      ],
    });
    render(
      <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />,
    );
    await user.click(screen.getByRole("button", { name: /Giọng đọc/ }));
    await screen.findByRole("radio", { name: /Cô Thục Đoan/ });
    expect(
      screen.queryByTestId("voice-wifi-ready-badge-local_north_truc_ly"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByTestId("voice-wifi-ready-badge-local_south_thuc_doan"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("voice-offline-cache-notice")).toHaveTextContent(
      /Cô Thục Đoan/,
    );
  });

  it("reactively updates ReadingCompanionBubble and useTeacherPersona on voice changes", () => {
    const { result } = renderHook(() => useTeacherPersona());
    expect(result.current.title).toBe("Cô giáo AI");

    render(
      <ReadingCompanionBubble
        state={{
          mood: "listening",
          title: "Cô giáo đồng hành",
          message: "Cô đang lắng nghe bé đọc nhé",
        }}
      />,
    );
    expect(screen.getByTestId("reading-companion-bubble")).toHaveAttribute(
      "data-teacher-persona",
      "female",
    );
    expect(screen.getByText(/Cô đang lắng nghe/)).toBeInTheDocument();

    act(() => {
      lockSessionVoice("session-persona", {
        voiceId: "local_north_thien_minh",
        forceUpdate: true,
      });
    });

    expect(result.current.title).toBe("Thầy giáo AI");
    expect(screen.getByTestId("reading-companion-bubble")).toHaveAttribute(
      "data-teacher-persona",
      "male",
    );
    expect(screen.getByText(/Thầy đang lắng nghe/)).toBeInTheDocument();

    act(() => {
      setSpeechPreferences({ voiceId: "local_north_truc_ly" });
      lockSessionVoice("session-persona", {
        voiceId: "local_north_truc_ly",
        forceUpdate: true,
      });
    });
    expect(result.current.title).toBe("Cô giáo AI");
  });

  it("resets captureErrorRef in useSpeechRecorder.cancel() and memoizes recorder and player controllers", async () => {
    const recorderErrors: Array<() => void> = [];

    class FakeMediaRecorder {
      static isTypeSupported = () => true;
      state = "inactive";
      mimeType = "audio/webm";
      stream: MediaStream;
      ondataavailable: ((ev: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(stream: MediaStream) {
        this.stream = stream;
        recorderErrors.push(() => this.onerror?.());
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.onstop?.();
      }
    }

    const fakeStream = {
      getTracks: () => [
        {
          readyState: "live",
          stop: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          getSettings: () => ({}),
        },
      ],
    } as unknown as MediaStream;

    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getSupportedConstraints: () => ({}),
        getUserMedia: vi.fn().mockResolvedValue(fakeStream),
      },
    });

    const onCaptureError = vi.fn();
    const { result: recHook, rerender: rerenderRec } = renderHook(() =>
      useSpeechRecorder(onCaptureError),
    );
    const firstRecRef = recHook.current;
    rerenderRec();
    expect(recHook.current).toBe(firstRecRef);

    await act(async () => {
      await recHook.current.start();
    });
    act(() => {
      recorderErrors.at(-1)?.();
    });
    expect(onCaptureError).toHaveBeenCalledTimes(1);

    // Before cancel(), stop() rejects with the capture error; after cancel(), stop() resolves null!
    act(() => {
      recHook.current.cancel();
    });
    await expect(recHook.current.stop()).resolves.toBeNull();

    // useSpeechPlayer returns a referentially stable controller across re-renders
    const { result: playerHook, rerender: rerenderPlayer } = renderHook(() =>
      useSpeechPlayer(),
    );
    const firstPlayerRef = playerHook.current;
    rerenderPlayer();
    expect(playerHook.current).toBe(firstPlayerRef);
  });
});
