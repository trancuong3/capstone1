import {
  expect,
  type Browser,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import {
  book as baseBook,
  ids,
  installApiFixture,
  type BrowserApiState,
} from "./real-data-fixture";

export async function withIsolatedPage<T>(
  browser: Browser,
  testInfo: TestInfo,
  fn: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    extraHTTPHeaders: testInfo.project.use.extraHTTPHeaders,
    viewport: testInfo.project.use.viewport,
    isMobile: testInfo.project.use.isMobile,
    hasTouch: testInfo.project.use.hasTouch,
    serviceWorkers: "block",
  });
  try {
    const isolatedPage = await context.newPage();
    return await fn(isolatedPage);
  } finally {
    await context.close();
  }
}

export interface ReadingWordSpec {
  readonly word_id: string;
  readonly word_index: number;
  readonly text: string;
  readonly bbox: readonly [number, number, number, number];
  readonly line_index: number;
}

export interface ReadingPageSpec {
  readonly page_id: string;
  readonly page_revision_id: string;
  readonly page_number: number;
  readonly confidence: number | null;
  readonly width: number;
  readonly height: number;
  readonly image_overlay_safe: boolean;
  readonly image_url: string | null;
  readonly illustration_url?: string | null;
  readonly illustration_text_free?: boolean;
  readonly tts_audio_url?: string | null;
  readonly tts_word_timings?: ReadonlyArray<{
    readonly index: number;
    readonly start: number;
    readonly end: number;
  }> | null;
  readonly text: string;
  readonly words: readonly ReadingWordSpec[];
}

export interface NativeSpeechBridgeMockOptions {
  readonly ttsAvailable?: boolean;
  readonly viVoicesCount?: number;
  readonly sttAvailable?: boolean;
  readonly onDeviceSttAvailable?: boolean;
  readonly platform?: string;
  readonly autoReplyCapabilities?: boolean;
  readonly capabilitiesDelayMs?: number;
  readonly autoReplyTtsDone?: boolean;
  readonly ttsDurationMs?: number;
  readonly ttsRangeEvents?: ReadonlyArray<{
    readonly start: number;
    readonly end: number;
    readonly delayMs: number;
  }>;
  readonly ttsError?: {
    readonly code: string;
    readonly message: string;
  } | null;
  readonly settingsOpenResult?: boolean;
}

export interface WasmWorkerMockOptions {
  readonly initDelayMs?: number;
  readonly initError?: string | null;
  readonly crashOnInit?: boolean;
  readonly decodeDelayMs?: number;
  readonly scriptedOutputs?: readonly string[];
  readonly emitProgress?: boolean;
}

export interface SpeechAndAudioMockOptions {
  readonly denyMicrophone?: boolean;
  readonly silentMicrophone?: boolean;
  readonly browserSpeechRecognition?: boolean;
  readonly browserVoices?: ReadonlyArray<{
    readonly lang: string;
    readonly name?: string;
  }>;
  readonly audioDurationSeconds?: number;
}

export interface VoiceNetworkMockOptions {
  readonly localAvailable?: boolean;
  readonly localSttReady?: boolean;
  readonly localTtsReady?: boolean;
  readonly googleSttConfigured?: boolean;
  readonly googleTtsConfigured?: boolean;
  readonly timedTtsStatus?: number;
  readonly timedTtsDelayMs?: number;
  readonly timedTtsDurationSeconds?: number;
  readonly shortTtsStatus?: number;
  readonly shortTtsDelayMs?: number;
  readonly shortTtsDurationSeconds?: number;
  readonly phonicsTtsStatus?: number;
  readonly sttStatus?: number;
  readonly precomputedAudioStatus?: number;
}

export interface ReadingVoiceSessionOptions {
  readonly bookId?: string;
  readonly sessionId?: string;
  readonly visibilityScope?: "CATALOG" | "PARENT_PRIVATE";
  readonly pages?: readonly ReadingPageSpec[];
  readonly initialState?: "ready" | "reading";
  readonly autoNavigate?: boolean;
  readonly previewStatus?: number;
  readonly nativeBridge?: NativeSpeechBridgeMockOptions | null;
  readonly wasmWorker?: WasmWorkerMockOptions | null;
  readonly speechAndAudio?: SpeechAndAudioMockOptions;
  readonly voice?: VoiceNetworkMockOptions;
  readonly studioCoverUrl?: string | null;
}

export interface HighlightTransition {
  readonly timestamp: number;
  readonly wordId: string | null;
  readonly wordIndex: number;
  readonly readingState: string | null;
  readonly ariaCurrent: string | null;
}

export interface WordGeometryBox {
  readonly wordId: string;
  readonly text: string;
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly left: number;
}

export interface PrivateAudioLeakageReport {
  readonly idbEntryCount: number;
  readonly idbKeys: readonly string[];
  readonly idbScopes: readonly string[];
  readonly cacheStorageKeys: readonly string[];
  readonly catalogTtsRequests: readonly string[];
  readonly ttsRequests: ReadonlyArray<{
    readonly path: string;
    readonly cacheScope: string | null;
    readonly bookId: string | null;
    readonly pageId: string | null;
    readonly status: number;
    readonly responseScope: string | null;
  }>;
}

export const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function createSilentWavBuffer(seconds = 2): Buffer {
  const bytes = Math.max(3200, Math.round(16_000 * 2 * seconds));
  const audio = Buffer.alloc(44 + bytes);
  audio.write("RIFF");
  audio.writeUInt32LE(36 + bytes, 4);
  audio.write("WAVE", 8);
  audio.write("fmt ", 12);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16_000, 24);
  audio.writeUInt32LE(32_000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(bytes, 40);
  return audio;
}

export function buildWordsFromText(
  text: string,
  options: {
    readonly prefix?: string;
    readonly wordsPerLine?: number;
  } = {},
): ReadingWordSpec[] {
  const prefix = options.prefix ?? "91000000-0000-4000-8000-";
  const lines = text.split("\n");
  const words: ReadingWordSpec[] = [];
  let lineIndex = 0;
  for (const line of lines) {
    const tokens = line.trim().split(/\s+/u).filter(Boolean);
    if (!tokens.length) continue;
    const perLine = options.wordsPerLine ?? Math.max(1, tokens.length);
    for (let i = 0; i < tokens.length; i += 1) {
      const idx = words.length;
      const effectiveLine =
        options.wordsPerLine !== undefined
          ? Math.floor(idx / perLine)
          : lineIndex;
      const col = options.wordsPerLine !== undefined ? idx % perLine : i;
      words.push({
        word_id: `${prefix}${String(idx + 1).padStart(12, "0")}`,
        word_index: idx,
        text: tokens[i],
        bbox: [
          Math.min(0.82, 0.06 + col * 0.14),
          Math.min(0.92, 0.08 + effectiveLine * 0.07),
          0.12,
          0.05,
        ],
        line_index: effectiveLine,
      });
    }
    lineIndex += 1;
  }
  return words;
}

export function buildLongPoetryPageSpec(
  lineCount = 120,
  pageId = ids.page,
  revisionId = ids.revision,
): ReadingPageSpec {
  const verses = [
    ["Trăng", "sáng", "trước", "sân", "nhà"],
    ["Gió", "mát", "thổi", "qua", "hiên"],
    ["Bé", "ngồi", "chăm", "đọc", "sách"],
    ["Chữ", "đẹp", "lại", "thật", "hiền."],
  ];
  const lines: string[] = [];
  const words: ReadingWordSpec[] = [];
  for (let line = 0; line < lineCount; line += 1) {
    const verse =
      line === lineCount - 1
        ? ["Hết", "thơ", "bé", "vui", "cười."]
        : verses[line % verses.length];
    lines.push(verse.join(" "));
    for (let i = 0; i < verse.length; i += 1) {
      const idx = words.length;
      words.push({
        word_id: `93000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        word_index: idx,
        text: verse[i],
        bbox: [
          0.1 + i * 0.12,
          Math.min(0.95, 0.02 + line * 0.0075),
          0.09,
          0.006,
        ],
        line_index: line,
      });
    }
  }
  return {
    page_id: pageId,
    page_revision_id: revisionId,
    page_number: 1,
    confidence: 0.98,
    width: 600,
    height: 800,
    image_overlay_safe: false,
    image_url: "http://127.0.0.1:8000/fixture-page.png",
    text: lines.join("\n"),
    words,
  };
}

export async function installNativeSpeechBridgeMock(
  page: Page,
  options: NativeSpeechBridgeMockOptions = {},
): Promise<void> {
  await page.addInitScript((opts: NativeSpeechBridgeMockOptions) => {
    const listeners = new Set<(event: { data: string }) => void>();
    const commands: Array<{
      readonly action: string;
      readonly requestId?: string;
      readonly timestamp: number;
      readonly activeTracksAtDispatch: number;
      readonly payload: Record<string, unknown>;
    }> = [];
    let currentTtsRequestId: string | null = null;
    let currentSttRequestId: string | null = null;
    let ttsTimers: Array<ReturnType<typeof setTimeout>> = [];

    const clearTtsTimers = () => {
      for (const timer of ttsTimers) clearTimeout(timer);
      ttsTimers = [];
    };

    const emit = (event: Record<string, unknown>) => {
      const serialized = JSON.stringify(event);
      for (const listener of [...listeners]) {
        try {
          listener({ data: serialized });
        } catch {
          // Isolate listener errors
        }
      }
      if (typeof port.onmessage === "function") {
        try {
          port.onmessage({ data: serialized } as MessageEvent);
        } catch {
          // Ignore
        }
      }
    };

    const port = {
      onmessage: null as
        ((event: { data: unknown } | MessageEvent) => void) | null,
      addEventListener(
        type: string,
        listener: (event: { data: string }) => void,
      ) {
        if (type === "message") listeners.add(listener);
      },
      removeEventListener(
        type: string,
        listener: (event: { data: string }) => void,
      ) {
        if (type === "message") listeners.delete(listener);
      },
      postMessage(raw: string) {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return;
        }
        const action = String(parsed.action ?? "");
        const requestId =
          typeof parsed.requestId === "string" ? parsed.requestId : undefined;
        const probe = (
          window as unknown as {
            __voiceHarness?: { activeTracks?: number };
          }
        ).__voiceHarness;
        commands.push({
          action,
          requestId,
          timestamp: performance.now(),
          activeTracksAtDispatch: probe?.activeTracks ?? 0,
          payload: parsed,
        });

        if (
          action === "getCapabilities" &&
          opts.autoReplyCapabilities !== false
        ) {
          const reply = () =>
            emit({
              type: "capabilities",
              requestId,
              ttsAvailable: opts.ttsAvailable ?? true,
              viVoicesCount: opts.viVoicesCount ?? 2,
              sttAvailable: opts.sttAvailable ?? true,
              onDeviceSttAvailable: opts.onDeviceSttAvailable ?? true,
              platform: opts.platform ?? "android-webview-mock",
            });
          if (opts.capabilitiesDelayMs && opts.capabilitiesDelayMs > 0) {
            setTimeout(reply, opts.capabilitiesDelayMs);
          } else {
            queueMicrotask(reply);
          }
          return;
        }

        if (action === "openTtsInstallSettings") {
          queueMicrotask(() => {
            emit({
              type:
                opts.settingsOpenResult === false
                  ? "tts_settings_unavailable"
                  : "tts_settings_opened",
              requestId,
            });
          });
          return;
        }

        if (action === "speak") {
          clearTtsTimers();
          currentTtsRequestId = requestId ?? null;
          if (opts.ttsError) {
            queueMicrotask(() => {
              emit({
                type: "tts_error",
                requestId,
                code: opts.ttsError?.code,
                message: opts.ttsError?.message,
              });
            });
            return;
          }
          if (opts.autoReplyTtsDone !== false) {
            ttsTimers.push(
              setTimeout(() => {
                emit({ type: "tts_start", requestId });
              }, 20),
            );
            for (const r of opts.ttsRangeEvents ?? []) {
              ttsTimers.push(
                setTimeout(() => {
                  emit({
                    type: "tts_range",
                    requestId,
                    start: r.start,
                    end: r.end,
                  });
                }, r.delayMs),
              );
            }
            const duration = opts.ttsDurationMs ?? 650;
            ttsTimers.push(
              setTimeout(() => {
                emit({ type: "tts_done", requestId });
              }, duration),
            );
          }
          return;
        }

        if (action === "stopSpeak") {
          clearTtsTimers();
          const targetId = currentTtsRequestId;
          currentTtsRequestId = null;
          if (targetId) {
            queueMicrotask(() => {
              emit({ type: "tts_stopped", requestId: targetId });
            });
          }
          return;
        }

        if (action === "startStt") {
          currentSttRequestId = requestId ?? null;
          queueMicrotask(() => {
            emit({ type: "stt_ready", requestId: currentSttRequestId });
          });
          return;
        }

        if (action === "stopStt" || action === "cancelStt") {
          const targetId = currentSttRequestId ?? requestId;
          currentSttRequestId = null;
          queueMicrotask(() => {
            emit({ type: "stt_end", requestId: targetId });
          });
        }
      },
    };

    Object.defineProperty(window, "ViReadNativeSpeech", {
      configurable: true,
      value: port,
    });

    Object.assign(window, {
      __nativeSpeechHarness: {
        commands,
        getCommands: (action?: string) =>
          action ? commands.filter((c) => c.action === action) : [...commands],
        getLastTtsRequestId: () => currentTtsRequestId,
        getLastSttRequestId: () => currentSttRequestId,
        pushEvent: (event: Record<string, unknown>) => emit(event),
        pushTtsStart: (requestId?: string) =>
          emit({
            type: "tts_start",
            requestId: requestId ?? currentTtsRequestId ?? undefined,
          }),
        pushTtsRange: (start: number, end: number, requestId?: string) =>
          emit({
            type: "tts_range",
            requestId: requestId ?? currentTtsRequestId ?? undefined,
            start,
            end,
          }),
        pushTtsDone: (requestId?: string) =>
          emit({
            type: "tts_done",
            requestId: requestId ?? currentTtsRequestId ?? undefined,
          }),
        pushTtsError: (code: string, message: string, requestId?: string) =>
          emit({
            type: "tts_error",
            requestId: requestId ?? currentTtsRequestId ?? undefined,
            code,
            message,
          }),
        pushSttOnset: (onsetAt?: number) =>
          emit({
            type: "stt_onset",
            requestId: currentSttRequestId ?? undefined,
            onsetAt: onsetAt ?? Date.now(),
          }),
        pushSttPartial: (transcript: string) =>
          emit({
            type: "stt_partial",
            requestId: currentSttRequestId ?? undefined,
            transcript,
            onsetAt: Date.now(),
          }),
        pushSttFinal: (
          transcript: string,
          alternatives: readonly string[] = [],
        ) =>
          emit({
            type: "stt_final",
            requestId: currentSttRequestId ?? undefined,
            transcript,
            alternatives,
            onsetAt: Date.now(),
          }),
        pushSttError: (code: string, message?: string) =>
          emit({
            type: "stt_error",
            requestId: currentSttRequestId ?? undefined,
            code,
            message,
          }),
        pushSttEnd: () =>
          emit({
            type: "stt_end",
            requestId: currentSttRequestId ?? undefined,
          }),
      },
    });
  }, options);
}

export async function installWasmWorkerMock(
  page: Page,
  options: WasmWorkerMockOptions = {},
): Promise<void> {
  await page.addInitScript((opts: WasmWorkerMockOptions) => {
    const OriginalWorker = window.Worker;
    const telemetry = {
      workerInitCount: 0,
      initResolvedCount: 0,
      transcribeCount: 0,
      cancelledIds: [] as string[],
      transcriptQueue: [...(opts.scriptedOutputs ?? [])],
      currentInitDelayMs: opts.initDelayMs ?? 20,
      currentInitError: opts.initError ?? null,
      currentCrashOnInit: opts.crashOnInit ?? false,
      currentDecodeDelayMs: opts.decodeDelayMs ?? 15,
    };

    class MockSherpaWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;
      private readonly listeners = new Map<
        string,
        Set<(event: Event) => void>
      >();
      private readonly timers = new Map<
        string,
        ReturnType<typeof setTimeout>
      >();
      private terminated = false;

      constructor() {
        telemetry.workerInitCount += 1;
      }

      addEventListener(type: string, listener: (event: Event) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(listener);
      }

      removeEventListener(type: string, listener: (event: Event) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      private dispatchMessage(data: unknown) {
        if (this.terminated) return;
        const event = { data } as MessageEvent;
        this.onmessage?.(event);
        for (const fn of this.listeners.get("message") ?? []) {
          fn(event as unknown as Event);
        }
      }

      private dispatchError(message: string) {
        if (this.terminated) return;
        const event = { message } as ErrorEvent;
        this.onerror?.(event);
        for (const fn of this.listeners.get("error") ?? []) {
          fn(event as unknown as Event);
        }
      }

      postMessage(payload: Record<string, unknown>) {
        if (this.terminated) return;
        const type = String(payload.type ?? "");
        const id = typeof payload.id === "string" ? payload.id : undefined;

        if (type === "cancel" && id) {
          telemetry.cancelledIds.push(id);
          const pendingTimer = this.timers.get(id);
          if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.timers.delete(id);
          }
          return;
        }

        if (type === "init" && id) {
          if (opts.emitProgress !== false) {
            queueMicrotask(() => {
              this.dispatchMessage({
                type: "progress",
                stage: "loading-model",
                file: "encoder.int8.onnx",
                index: 1,
                total: 4,
              });
            });
          }
          const delay = telemetry.currentInitDelayMs;
          const timer = setTimeout(() => {
            this.timers.delete(id);
            if (telemetry.currentCrashOnInit) {
              this.dispatchError(
                telemetry.currentInitError || "WASM STT worker crashed",
              );
              return;
            }
            if (telemetry.currentInitError) {
              this.dispatchMessage({
                type: "error",
                id,
                message: telemetry.currentInitError,
              });
              return;
            }
            telemetry.initResolvedCount += 1;
            this.dispatchMessage({ type: "ready", id });
          }, delay);
          this.timers.set(id, timer);
          return;
        }

        if (type === "transcribe" && id) {
          telemetry.transcribeCount += 1;
          const nextText =
            telemetry.transcriptQueue.length > 0
              ? telemetry.transcriptQueue.shift()!
              : "";
          const timer = setTimeout(() => {
            this.timers.delete(id);
            this.dispatchMessage({
              type: "result",
              id,
              text: nextText,
              decodeMs: telemetry.currentDecodeDelayMs,
            });
          }, telemetry.currentDecodeDelayMs);
          this.timers.set(id, timer);
        }
      }

      terminate() {
        this.terminated = true;
        for (const t of this.timers.values()) clearTimeout(t);
        this.timers.clear();
      }
    }

    const WrappedWorker = function (
      scriptURL: string | URL,
      workerOptions?: WorkerOptions,
    ) {
      const urlText = String(scriptURL);
      if (urlText.includes("/workers/sherpa-stt-worker.js")) {
        return new MockSherpaWorker() as unknown as Worker;
      }
      return new OriginalWorker(scriptURL, workerOptions);
    } as unknown as typeof Worker;
    WrappedWorker.prototype = OriginalWorker.prototype;

    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: WrappedWorker,
    });

    Object.assign(window, {
      __wasmWorkerHarness: {
        getStats: () => ({
          workerInitCount: telemetry.workerInitCount,
          initResolvedCount: telemetry.initResolvedCount,
          transcribeCount: telemetry.transcribeCount,
          cancelledIds: [...telemetry.cancelledIds],
          pendingQueueLength: telemetry.transcriptQueue.length,
        }),
        enqueueTranscript: (...texts: string[]) => {
          telemetry.transcriptQueue.push(...texts);
        },
        setInitError: (message: string | null, crash = false) => {
          telemetry.currentInitError = message;
          telemetry.currentCrashOnInit = crash;
        },
      },
    });
  }, options);
}

export async function installSpeechAndAudioMock(
  page: Page,
  options: SpeechAndAudioMockOptions = {},
): Promise<void> {
  await page.addInitScript((opts: SpeechAndAudioMockOptions) => {
    interface TrackedAudioNodeEntry {
      ctx: BaseAudioContext | undefined;
      attachedAt: number;
      firstQuantumAt: number | null;
      isCold: boolean;
      disconnected: boolean;
    }

    const audioGraphState = {
      pendingModules: 0,
      loadedModules: 0,
      workletAttachCount: 0,
      activeWorklets: [] as TrackedAudioNodeEntry[],
      activeScriptProcessors: [] as TrackedAudioNodeEntry[],
    };

    const pruneInactiveEntries = (entries: TrackedAudioNodeEntry[]) => {
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry.disconnected || entry.ctx?.state === "closed") {
          entries.splice(i, 1);
        }
      }
    };

    const isAudioGraphReadyAndSettled = (now: number): boolean => {
      pruneInactiveEntries(audioGraphState.activeWorklets);
      pruneInactiveEntries(audioGraphState.activeScriptProcessors);
      if (audioGraphState.pendingModules > 0) {
        return false;
      }
      if (audioGraphState.activeWorklets.length > 0) {
        const latest =
          audioGraphState.activeWorklets[
            audioGraphState.activeWorklets.length - 1
          ];
        const settleMs = latest.isCold ? 220 : 40;
        const settledByTime = now - latest.attachedAt >= settleMs;
        const quantumReady =
          (latest.firstQuantumAt !== null &&
            now - latest.firstQuantumAt >= 20) ||
          now - latest.attachedAt >= 1200;
        return settledByTime && quantumReady;
      }
      if (audioGraphState.activeScriptProcessors.length > 0) {
        const latest =
          audioGraphState.activeScriptProcessors[
            audioGraphState.activeScriptProcessors.length - 1
          ];
        return now - latest.attachedAt >= 40;
      }
      return false;
    };

    if (
      typeof window.AudioWorklet === "function" &&
      typeof window.AudioWorklet.prototype?.addModule === "function"
    ) {
      const originalAddModule = window.AudioWorklet.prototype.addModule;
      window.AudioWorklet.prototype.addModule = function (
        this: AudioWorklet,
        moduleURL: string | URL,
        moduleOptions?: WorkletOptions,
      ) {
        audioGraphState.pendingModules += 1;
        return originalAddModule.call(this, moduleURL, moduleOptions).then(
          (result) => {
            audioGraphState.pendingModules = Math.max(
              0,
              audioGraphState.pendingModules - 1,
            );
            audioGraphState.loadedModules += 1;
            return result;
          },
          (err) => {
            audioGraphState.pendingModules = Math.max(
              0,
              audioGraphState.pendingModules - 1,
            );
            throw err;
          },
        );
      };
    }

    const OriginalAudioWorkletNode = window.AudioWorkletNode;
    if (typeof OriginalAudioWorkletNode === "function") {
      const WrappedAudioWorkletNode = new Proxy(OriginalAudioWorkletNode, {
        construct(target, args, newTarget) {
          const node = Reflect.construct(
            target,
            args,
            newTarget === WrappedAudioWorkletNode ? target : newTarget,
          ) as AudioWorkletNode;
          const processorName = typeof args[1] === "string" ? args[1] : "";
          const ctx = args[0] as BaseAudioContext | undefined;
          if (processorName === "viread-capture-processor") {
            const isCold = audioGraphState.workletAttachCount === 0;
            audioGraphState.workletAttachCount += 1;
            const entry: TrackedAudioNodeEntry = {
              ctx,
              attachedAt: performance.now(),
              firstQuantumAt: null,
              isCold,
              disconnected: false,
            };
            audioGraphState.activeWorklets.push(entry);
            try {
              const portProtoDesc = Object.getOwnPropertyDescriptor(
                MessagePort.prototype,
                "onmessage",
              );
              let userOnMessage: ((ev: MessageEvent) => unknown) | null = null;
              Object.defineProperty(node.port, "onmessage", {
                configurable: true,
                get: () => userOnMessage,
                set: (handler: ((ev: MessageEvent) => unknown) | null) => {
                  userOnMessage = handler;
                  if (typeof handler === "function") {
                    portProtoDesc?.set?.call(node.port, (ev: MessageEvent) => {
                      if (entry.firstQuantumAt === null) {
                        entry.firstQuantumAt = performance.now();
                      }
                      return handler.call(node.port, ev);
                    });
                  } else {
                    portProtoDesc?.set?.call(node.port, handler);
                  }
                },
              });
            } catch {
              // Ignore if MessagePort.onmessage cannot be wrapped
            }
            const origDisconnect = node.disconnect.bind(node);
            node.disconnect = ((...disconnectArgs: unknown[]) => {
              if (disconnectArgs.length === 0) {
                entry.disconnected = true;
              }
              return (origDisconnect as (...a: unknown[]) => void)(
                ...disconnectArgs,
              );
            }) as AudioWorkletNode["disconnect"];
          }
          return node;
        },
      });
      Object.defineProperty(window, "AudioWorkletNode", {
        configurable: true,
        value: WrappedAudioWorkletNode,
      });
    }

    if (
      typeof window.BaseAudioContext === "function" &&
      typeof window.BaseAudioContext.prototype?.createScriptProcessor ===
        "function"
    ) {
      const originalCreateScriptProcessor =
        window.BaseAudioContext.prototype.createScriptProcessor;
      window.BaseAudioContext.prototype.createScriptProcessor = function (
        this: BaseAudioContext,
        bufferSize?: number,
        numberOfInputChannels?: number,
        numberOfOutputChannels?: number,
      ) {
        const processor = originalCreateScriptProcessor.call(
          this,
          bufferSize,
          numberOfInputChannels,
          numberOfOutputChannels,
        );
        const entry: TrackedAudioNodeEntry = {
          ctx: this,
          attachedAt: performance.now(),
          firstQuantumAt: null,
          isCold: false,
          disconnected: false,
        };
        audioGraphState.activeScriptProcessors.push(entry);
        const origDisconnect = processor.disconnect.bind(processor);
        processor.disconnect = ((...disconnectArgs: unknown[]) => {
          if (disconnectArgs.length === 0) {
            entry.disconnected = true;
          }
          return (origDisconnect as (...a: unknown[]) => void)(
            ...disconnectArgs,
          );
        }) as ScriptProcessorNode["disconnect"];
        return processor;
      };
    }

    const activePulseCounts = new WeakMap<GainNode, number>();
    const harness = {
      microphoneRequests: 0,
      activeTracks: 0,
      lastTrackStoppedAt: 0,
      audios: [] as HTMLAudioElement[],
      utterances: [] as Array<{
        text: string;
        lang: string;
        rate: number;
        utterance: SpeechSynthesisUtterance;
      }>,
      synthCancels: 0,
      synthPauses: 0,
      synthResumes: 0,
      browserRecStarts: 0,
      browserRecInstances: [] as Array<{
        emitResult: (
          transcript: string,
          isFinal: boolean,
          confidence?: number,
        ) => void;
      }>,
      activeGainNodes: [] as GainNode[],
      workletState: audioGraphState,
      pulseSpeech: (durationMs = 260, gainValue = 0.14): Promise<void> => {
        const holdMs = Math.max(durationMs, 320);
        const pollIntervalMs = 25;
        const maxWaitMs = 3000;
        const startedAt = performance.now();

        return new Promise<void>((resolve) => {
          const triggerPulse = () => {
            const targets = [...harness.activeGainNodes];
            if (targets.length === 0) {
              resolve();
              return;
            }
            for (const gain of targets) {
              const prevCount = activePulseCounts.get(gain) ?? 0;
              activePulseCounts.set(gain, prevCount + 1);
              try {
                gain.gain.value = gainValue;
              } catch {
                // Ignore closed audio contexts
              }
            }
            setTimeout(() => {
              for (const gain of targets) {
                const nextCount = Math.max(
                  0,
                  (activePulseCounts.get(gain) ?? 1) - 1,
                );
                activePulseCounts.set(gain, nextCount);
                if (nextCount === 0) {
                  try {
                    gain.gain.value = 0;
                  } catch {
                    // Ignore closed audio contexts
                  }
                }
              }
              resolve();
            }, holdMs);
          };

          const waitUntilReady = () => {
            const now = performance.now();
            const hasGainNodes = harness.activeGainNodes.length > 0;
            const graphReady = isAudioGraphReadyAndSettled(now);
            if ((hasGainNodes && graphReady) || now - startedAt >= maxWaitMs) {
              triggerPulse();
              return;
            }
            setTimeout(waitUntilReady, pollIntervalMs);
          };

          waitUntilReady();
        });
      },
    };
    Object.assign(window, { __voiceHarness: harness });

    // Audio wrapper so playbackRate, currentTime, pause/resume are inspectable.
    const OriginalAudio = window.Audio;
    Object.defineProperty(window, "Audio", {
      configurable: true,
      value: function (src?: string) {
        const audio = new OriginalAudio(src);
        harness.audios.push(audio);
        return audio;
      },
    });

    // SpeechSynthesis mock (supports configurable Vietnamese or missing voices).
    class MockUtterance {
      lang = "";
      rate = 1;
      pitch = 1;
      voice: SpeechSynthesisVoice | null = null;
      onstart: SpeechSynthesisUtterance["onstart"] = null;
      onboundary: SpeechSynthesisUtterance["onboundary"] = null;
      onend: SpeechSynthesisUtterance["onend"] = null;
      onerror: SpeechSynthesisUtterance["onerror"] = null;
      constructor(readonly text: string) {}
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", {
      configurable: true,
      value: MockUtterance,
    });
    const voices = (
      opts.browserVoices ?? [{ lang: "vi-VN", name: "Vi Mock" }]
    ).map(
      (v) =>
        ({
          lang: v.lang,
          name: v.name ?? v.lang,
          default: true,
          localService: false,
          voiceURI: v.name ?? v.lang,
        }) as SpeechSynthesisVoice,
    );
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => voices,
        speak: (utterance: SpeechSynthesisUtterance) => {
          harness.utterances.push({
            text: utterance.text,
            lang: utterance.lang,
            rate: utterance.rate,
            utterance,
          });
          queueMicrotask(() => {
            utterance.onstart?.({
              utterance,
              elapsedTime: 0,
              charIndex: 0,
            } as SpeechSynthesisEvent);
          });
        },
        cancel: () => {
          harness.synthCancels += 1;
        },
        pause: () => {
          harness.synthPauses += 1;
        },
        resume: () => {
          harness.synthResumes += 1;
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });

    if (opts.browserSpeechRecognition) {
      class MockBrowserSpeechRecognition {
        continuous = true;
        interimResults = true;
        lang = "vi-VN";
        maxAlternatives = 1;
        onresult: ((ev: unknown) => void) | null = null;
        onerror: ((ev: unknown) => void) | null = null;
        onend: (() => void) | null = null;
        private readonly items: unknown[] = [];

        constructor() {
          harness.browserRecInstances.push({
            emitResult: (
              transcript: string,
              isFinal: boolean,
              confidence = 0.9,
            ) => {
              const idx = this.items.length;
              const entry = {
                isFinal,
                length: 1,
                0: { transcript, confidence },
              };
              if (isFinal) this.items.push(entry);
              const resultsObj: Record<number, unknown> & { length: number } = {
                length: this.items.length + (isFinal ? 0 : 1),
              };
              for (let i = 0; i < this.items.length; i += 1) {
                resultsObj[i] = this.items[i];
              }
              if (!isFinal) resultsObj[idx] = entry;
              this.onresult?.({ resultIndex: idx, results: resultsObj });
            },
          });
        }
        start() {
          harness.browserRecStarts += 1;
        }
        stop() {
          this.onend?.();
        }
        abort() {
          this.onend?.();
        }
      }
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: MockBrowserSpeechRecognition,
      });
      Object.defineProperty(window, "webkitSpeechRecognition", {
        configurable: true,
        value: MockBrowserSpeechRecognition,
      });
    } else {
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: undefined,
      });
      Object.defineProperty(window, "webkitSpeechRecognition", {
        configurable: true,
        value: undefined,
      });
    }

    if (
      navigator.permissions &&
      typeof navigator.permissions.query === "function"
    ) {
      const originalQuery = navigator.permissions.query.bind(
        navigator.permissions,
      );
      Object.defineProperty(navigator.permissions, "query", {
        configurable: true,
        value: async (desc: PermissionDescriptor) => {
          if (desc.name === "microphone") {
            return {
              name: "microphone",
              state: opts.denyMicrophone ? "denied" : "granted",
              onchange: null,
              addEventListener: () => undefined,
              removeEventListener: () => undefined,
              dispatchEvent: () => false,
            } as unknown as PermissionStatus;
          }
          return originalQuery(desc);
        },
      });
    }

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        harness.microphoneRequests += 1;
        if (opts.denyMicrophone) {
          throw new DOMException(
            "Isolated denied microphone fixture",
            "NotAllowedError",
          );
        }
        const ctx = new AudioContext();
        await ctx.resume().catch(() => undefined);
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 230;
        gain.gain.value = opts.silentMicrophone ? 0 : 0.0002;
        osc.connect(gain);
        gain.connect(dest);
        osc.start();
        harness.activeGainNodes.push(gain);

        const stream = dest.stream;
        for (const track of stream.getTracks()) {
          harness.activeTracks += 1;
          const origStop = track.stop.bind(track);
          let stopped = false;
          track.stop = () => {
            if (!stopped) {
              stopped = true;
              harness.activeTracks = Math.max(0, harness.activeTracks - 1);
              harness.lastTrackStoppedAt = performance.now();
              const idx = harness.activeGainNodes.indexOf(gain);
              if (idx >= 0) harness.activeGainNodes.splice(idx, 1);
              try {
                osc.stop();
                void ctx.close();
              } catch {
                // Ignore
              }
            }
            origStop();
          };
        }
        return stream;
      },
    });
  }, options);
}

export async function installHighlightObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const prevObserver = (
      window as unknown as {
        __highlightObserver?: { disconnect?: () => void };
      }
    ).__highlightObserver;
    prevObserver?.disconnect?.();

    const getWords = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-reading-panel="text"] [data-word-id], [data-image-overlay="true"] [data-word-id]',
        ),
      );

    const transitions: HighlightTransition[] = [];
    const recordSnapshot = () => {
      const words = getWords();
      if (!words.length) return;
      const currentIdx = words.findIndex(
        (el) => el.getAttribute("aria-current") === "true",
      );
      const currentEl = currentIdx >= 0 ? words[currentIdx] : null;
      const nextEntry: HighlightTransition = {
        timestamp: performance.now(),
        wordId: currentEl?.getAttribute("data-word-id") ?? null,
        wordIndex: currentIdx,
        readingState: currentEl?.getAttribute("data-reading-state") ?? null,
        ariaCurrent: currentEl?.getAttribute("aria-current") ?? null,
      };
      const prev = transitions[transitions.length - 1];
      if (
        !prev ||
        prev.wordIndex !== nextEntry.wordIndex ||
        prev.wordId !== nextEntry.wordId ||
        prev.readingState !== nextEntry.readingState
      ) {
        transitions.push(nextEntry);
      }
    };

    recordSnapshot();
    const target =
      document.querySelector('[data-reading-shell="true"]') ?? document.body;
    const observer = new MutationObserver(() => {
      recordSnapshot();
    });
    observer.observe(target, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-current", "data-reading-state"],
    });
    Object.assign(window, {
      __highlightObserver: {
        transitions,
        disconnect: () => observer.disconnect(),
      },
    });
  });
}

export async function readHighlightTransitions(
  page: Page,
): Promise<HighlightTransition[]> {
  return page.evaluate(() => {
    const obs = (
      window as unknown as {
        __highlightObserver?: { transitions: HighlightTransition[] };
      }
    ).__highlightObserver;
    return obs ? [...obs.transitions] : [];
  });
}

export function assertMonotonicTransitions(
  transitions: readonly HighlightTransition[],
  options: {
    readonly allowNull?: boolean;
    readonly minDistinctIndices?: number;
  } = {},
): void {
  let maxSeen = -1;
  const distinct = new Set<number>();
  for (let i = 0; i < transitions.length; i += 1) {
    const item = transitions[i];
    if (item.wordIndex < 0) {
      if (options.allowNull === false) {
        throw new Error(
          `Unexpected null/cleared highlight at transition #${i}: ${JSON.stringify(transitions)}`,
        );
      }
      continue;
    }
    if (item.wordIndex < maxSeen) {
      throw new Error(
        `Non-monotonic highlight jump ${maxSeen} -> ${item.wordIndex} at transition #${i}: ${JSON.stringify(transitions)}`,
      );
    }
    maxSeen = item.wordIndex;
    distinct.add(item.wordIndex);
  }
  if (
    typeof options.minDistinctIndices === "number" &&
    distinct.size < options.minDistinctIndices
  ) {
    throw new Error(
      `Expected >= ${options.minDistinctIndices} distinct highlighted word indices, got ${distinct.size}: ${JSON.stringify(transitions)}`,
    );
  }
}

export async function measureWordGeometrySnapshot(
  page: Page,
): Promise<WordGeometryBox[]> {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-reading-panel="text"] [data-word-id]',
      ),
    ).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        wordId: el.getAttribute("data-word-id") ?? "",
        text: el.textContent?.trim() ?? "",
        width: rect.width,
        height: rect.height,
        top: rect.top,
        left: rect.left,
      };
    }),
  );
}

export async function inspectPrivateAudioLeakage(
  page: Page,
  network?: {
    readonly catalogTtsRequests: readonly string[];
    readonly ttsRequests: PrivateAudioLeakageReport["ttsRequests"];
  },
): Promise<PrivateAudioLeakageReport> {
  const storage = await page.evaluate(async () => {
    const idbKeys: string[] = [];
    const idbScopes: string[] = [];

    if (typeof indexedDB !== "undefined") {
      let hasDb = true;
      if (typeof indexedDB.databases === "function") {
        const dbs = await indexedDB.databases().catch(() => []);
        hasDb = dbs.some((db) => db.name === "viread-tts-audio-v1");
      }
      if (hasDb) {
        await new Promise<void>((resolve) => {
          let createdHere = false;
          const req = indexedDB.open("viread-tts-audio-v1", 1);
          req.onupgradeneeded = () => {
            createdHere = true;
            const db = req.result;
            if (!db.objectStoreNames.contains("entries")) {
              db.createObjectStore("entries", { keyPath: "key" });
            }
          };
          req.onsuccess = () => {
            const db = req.result;
            if (createdHere || !db.objectStoreNames.contains("entries")) {
              db.close();
              if (createdHere) indexedDB.deleteDatabase("viread-tts-audio-v1");
              resolve();
              return;
            }
            try {
              const tx = db.transaction("entries", "readonly");
              const getAll = tx.objectStore("entries").getAll();
              getAll.onsuccess = () => {
                const items = (getAll.result ?? []) as Array<{
                  key?: string;
                  scope?: string;
                }>;
                for (const item of items) {
                  if (item.key) idbKeys.push(item.key);
                  if (item.scope) idbScopes.push(item.scope);
                }
                db.close();
                resolve();
              };
              getAll.onerror = () => {
                db.close();
                resolve();
              };
            } catch {
              db.close();
              resolve();
            }
          };
          req.onerror = () => resolve();
        });
      }
    }

    const cacheStorageKeys: string[] = [];
    if (typeof caches !== "undefined") {
      try {
        const cacheNames = await caches.keys();
        if (cacheNames.includes("viread-catalog-tts-v1")) {
          const cache = await caches.open("viread-catalog-tts-v1");
          const reqs = await cache.keys();
          for (const req of reqs) cacheStorageKeys.push(req.url);
        }
      } catch {
        // Ignore blocked CacheStorage
      }
    }

    return { idbKeys, idbScopes, cacheStorageKeys };
  });

  return {
    idbEntryCount: storage.idbKeys.length,
    idbKeys: storage.idbKeys,
    idbScopes: storage.idbScopes,
    cacheStorageKeys: storage.cacheStorageKeys,
    catalogTtsRequests: network?.catalogTtsRequests ?? [],
    ttsRequests: network?.ttsRequests ?? [],
  };
}

export async function installReadingVoiceSession(
  page: Page,
  options: ReadingVoiceSessionOptions = {},
) {
  const api: BrowserApiState = await installApiFixture(page);
  api.previewStatus = options.previewStatus ?? 200;

  const bookId = options.bookId ?? ids.book;
  const sessionId = options.sessionId ?? ids.session;
  const visibilityScope = options.visibilityScope ?? "CATALOG";
  const defaultWords = buildWordsFromText("Bé mèo nhỏ đang đọc sách");
  const pages: readonly ReadingPageSpec[] = options.pages ?? [
    {
      page_id: ids.page,
      page_revision_id: ids.revision,
      page_number: 1,
      confidence: 0.98,
      width: 600,
      height: 800,
      image_overlay_safe: false,
      image_url: null,
      text: "Bé mèo nhỏ đang đọc sách",
      words: defaultWords,
    },
  ];

  let currentPageIndex = 0;
  let finished = false;
  const completedPages = new Set<string>();
  const voiceState: {
    localAvailable: boolean;
    localSttReady: boolean;
    localTtsReady: boolean;
    googleSttConfigured: boolean;
    googleTtsConfigured: boolean;
    timedTtsStatus: number;
    timedTtsDelayMs: number;
    timedTtsDurationSeconds: number;
    shortTtsStatus: number;
    shortTtsDelayMs: number;
    shortTtsDurationSeconds: number;
    phonicsTtsStatus: number;
    sttStatus: number;
    sttTranscript: string | null;
    precomputedAudioStatus: number;
  } = {
    localAvailable: options.voice?.localAvailable ?? true,
    localSttReady: options.voice?.localSttReady ?? true,
    localTtsReady: options.voice?.localTtsReady ?? true,
    googleSttConfigured: options.voice?.googleSttConfigured ?? false,
    googleTtsConfigured: options.voice?.googleTtsConfigured ?? false,
    timedTtsStatus: options.voice?.timedTtsStatus ?? 200,
    timedTtsDelayMs: options.voice?.timedTtsDelayMs ?? 0,
    timedTtsDurationSeconds: options.voice?.timedTtsDurationSeconds ?? 3,
    shortTtsStatus: options.voice?.shortTtsStatus ?? 200,
    shortTtsDelayMs: options.voice?.shortTtsDelayMs ?? 0,
    shortTtsDurationSeconds: options.voice?.shortTtsDurationSeconds ?? 2,
    phonicsTtsStatus: options.voice?.phonicsTtsStatus ?? 200,
    sttStatus: options.voice?.sttStatus ?? 200,
    sttTranscript: null,
    precomputedAudioStatus: options.voice?.precomputedAudioStatus ?? 200,
  };

  const catalogTtsRequests: string[] = [];
  const sttRequests: Array<{ path: string; status: number }> = [];
  const ttsRequests: Array<{
    path: string;
    cacheScope: string | null;
    bookId: string | null;
    pageId: string | null;
    status: number;
    responseScope: string | null;
  }> = [];
  const comparisons: Array<Record<string, unknown>> = [];
  const readingEvents: Array<Record<string, unknown>> = [];
  const unexpectedReadingPaths: string[] = [];
  let latestReport: Record<string, unknown> | null = null;
  const now = "2026-11-26T06:00:00Z";

  const corsHeaders = {
    "access-control-allow-origin": "http://127.0.0.1:3106",
    "access-control-allow-headers":
      "authorization,content-type,accept,x-voice-policy-mode,x-allow-google-stt-fallback,x-allow-google-tts-fallback,x-voice-region,x-voice-session-id,x-voice-page-id,x-voice-turn-id",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-expose-headers":
      "x-voice-provider,x-resolved-voice-id,x-voice-region,x-voice-model-version,x-voice-fallback,x-tts-scope",
  };

  const respondJson = (
    route: Route,
    body: unknown,
    status = 200,
    extraHeaders: Record<string, string> = {},
  ) =>
    route.fulfill({
      status,
      headers: { ...corsHeaders, ...extraHeaders },
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  const bookDto = {
    ...baseBook,
    id: bookId,
    title:
      visibilityScope === "PARENT_PRIVATE"
        ? "Sách riêng tư của bé"
        : baseBook.title,
    visibility_scope: visibilityScope,
  };

  const sessionSummaryDto = () => ({
    id: sessionId,
    child_id: ids.child,
    book_id: bookId,
    state: finished ? "FINISHED" : "PAGE_READY",
    started_at: now,
    ended_at: finished ? now : null,
    duration_ms: finished ? 60_000 : null,
  });

  const buildProgress = () => ({
    session_id: sessionId,
    persisted: true,
    start_page_id: pages[0].page_id,
    end_page_id: pages[pages.length - 1].page_id,
    current_page_id: pages[currentPageIndex].page_id,
    start_page_number: pages[0].page_number,
    end_page_number: pages[pages.length - 1].page_number,
    current_page_number: pages[currentPageIndex].page_number,
    current_index: currentPageIndex,
    total_pages: pages.length,
    completed_pages: completedPages.size,
    pages: pages.map((p, idx) => ({
      page_id: p.page_id,
      page_revision_id: p.page_revision_id,
      page_number: p.page_number,
      page_order: idx,
      status: completedPages.has(p.page_id)
        ? "COMPLETED"
        : idx === currentPageIndex
          ? "IN_PROGRESS"
          : "PENDING",
      started_at: idx <= currentPageIndex ? now : null,
      completed_at: completedPages.has(p.page_id) ? now : null,
    })),
  });

  await page.route("http://127.0.0.1:8000/fixture-page.png", (route) =>
    route.fulfill({
      status: 200,
      headers: corsHeaders,
      contentType: "image/png",
      body: Buffer.from(SAMPLE_PNG_BASE64, "base64"),
    }),
  );

  await page.route("http://127.0.0.1:8000/fixture-illustration.png", (route) =>
    route.fulfill({
      status: 200,
      headers: corsHeaders,
      contentType: "image/png",
      body: Buffer.from(SAMPLE_PNG_BASE64, "base64"),
    }),
  );

  await page.route("http://127.0.0.1:8000/viread-catalog-tts/**", (route) => {
    const reqUrl = route.request().url();
    catalogTtsRequests.push(reqUrl);
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    if (voiceState.precomputedAudioStatus !== 200) {
      return respondJson(route, {}, voiceState.precomputedAudioStatus);
    }
    return route.fulfill({
      status: 200,
      headers: corsHeaders,
      contentType: "audio/wav",
      body: createSilentWavBuffer(voiceState.timedTtsDurationSeconds),
    });
  });

  await page.route("http://127.0.0.1:8000/books/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    const path = new URL(route.request().url()).pathname;
    if (path === "/books/catalog") {
      return respondJson(route, [bookDto]);
    }
    if (path === `/books/catalog/${bookId}`) {
      return respondJson(route, bookDto);
    }
    if (path === `/books/catalog/${bookId}/preview`) {
      if (api.previewStatus !== 200) {
        return respondJson(route, [], api.previewStatus);
      }
      return respondJson(
        route,
        pages.map((p) => ({
          page_id: p.page_id,
          page_number: p.page_number,
          lifecycle_status: "ACTIVE",
          current_verified_revision_id: p.page_revision_id,
          preview_url: "http://127.0.0.1:8000/fixture-page.png",
        })),
      );
    }
    return route.fallback();
  });

  await page.route(
    "http://127.0.0.1:8000/studio/books/**/assets",
    async (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({ status: 204, headers: corsHeaders });
      }
      return respondJson(route, {
        book_id: bookId,
        title: bookDto.title,
        author: bookDto.author,
        min_grade: bookDto.min_grade,
        max_grade: bookDto.max_grade,
        visibility_scope: visibilityScope,
        active_cover: options.studioCoverUrl
          ? {
              id: "70000000-0000-4000-8000-000000000001",
              book_id: bookId,
              book_page_id: null,
              source_revision_id: null,
              asset_role: "COVER",
              source_type: "AI_GENERATED",
              media_url: options.studioCoverUrl,
              mime_type: "image/png",
              width: 600,
              height: 800,
              size_bytes: 1024,
              asset_hash: "cover-hash-1",
              asset_version: 1,
              is_active: true,
              text_free_verified: true,
              moderation_status: "APPROVED",
              provider_name: null,
              model_id: null,
              job_id: null,
              metadata: {},
              created_at: now,
              updated_at: now,
            }
          : null,
        effective_cover_source: options.studioCoverUrl
          ? "AI_GENERATED"
          : "METADATA_RENDER",
        metadata_fallback: {
          palette_id: "sky-blue",
          primary_color: "#1D4ED8",
          secondary_color: "#DBEAFE",
          accent_color: "#F59E0B",
          motif: "storybook",
          title: bookDto.title,
          author: bookDto.author,
          grade_label: `Lớp ${bookDto.min_grade}–${bookDto.max_grade}`,
          source_type: "METADATA_RENDER",
        },
        style_bible: null,
        page_illustrations: pages
          .filter((p) => Boolean(p.illustration_url))
          .map((p, idx) => ({
            id: `71000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
            book_id: bookId,
            book_page_id: p.page_id,
            source_revision_id: p.page_revision_id,
            asset_role: "PAGE_ILLUSTRATION",
            source_type: "AI_GENERATED",
            media_url: p.illustration_url!,
            mime_type: "image/png",
            width: p.width,
            height: p.height,
            size_bytes: 1024,
            asset_hash: `illust-hash-${idx + 1}`,
            asset_version: 1,
            is_active: true,
            text_free_verified: Boolean(p.illustration_text_free),
            moderation_status: "APPROVED",
            provider_name: null,
            model_id: null,
            job_id: null,
            metadata: {},
            created_at: now,
            updated_at: now,
          })),
        ai_image_provider_available: false,
        ai_image_provider_name: null,
        ai_image_provider_message_vi:
          "Chưa cấu hình nhà cung cấp tạo ảnh AI miễn phí.",
        v2_storage_degraded: false,
      });
    },
  );

  await page.route("http://127.0.0.1:8000/reading/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    const url = new URL(route.request().url());
    const path = url.pathname;
    const base = `/reading/sessions/${sessionId}`;

    if (path === "/reading/history") {
      return respondJson(route, {
        sessions: [sessionSummaryDto()],
        next_cursor: null,
      });
    }
    if (path === `/reading/history/${sessionId}/book`) {
      return respondJson(route, bookDto);
    }
    if (path === `/reading/history/${sessionId}`) {
      return respondJson(route, {
        ...sessionSummaryDto(),
        selected_page_revision_ids: pages.map((p) => p.page_revision_id),
        reference_page_revision_ids: [],
        events: readingEvents,
        fluency_assessment: null,
        comprehension: [],
        report_id: latestReport ? ids.oldRevision : null,
        availability: {
          events: readingEvents.length ? "available" : "absent",
          fluency: "absent",
          comprehension: "absent",
        },
      });
    }
    if (path === "/reading/sessions" && route.request().method() === "POST") {
      return respondJson(
        route,
        {
          Id: sessionId,
          State: "IN_PROGRESS",
          SelectedPageId: pages[0].page_id,
          SelectedPageRevisionId: pages[0].page_revision_id,
          StartedAt: now,
        },
        201,
      );
    }
    if (path === base) {
      return respondJson(route, sessionSummaryDto());
    }
    if (path === `${base}/page`) {
      return respondJson(route, pages[currentPageIndex]);
    }
    if (path === `${base}/progress`) {
      return respondJson(route, buildProgress());
    }
    if (path === `${base}/navigate`) {
      const body = route.request().postDataJSON() as {
        target_page_id?: string;
      };
      const idx = pages.findIndex((p) => p.page_id === body?.target_page_id);
      if (idx >= 0) currentPageIndex = idx;
      return respondJson(route, buildProgress());
    }
    if (path.startsWith(`${base}/pages/`) && path.endsWith("/complete")) {
      const pageId = path.split("/")[5];
      if (pageId) completedPages.add(pageId);
      return respondJson(route, buildProgress());
    }
    if (path === `${base}/practice-state`) {
      return respondJson(route, {
        session_id: sessionId,
        legacy_evidence_present: false,
        pages: [],
        words: [],
      });
    }
    if (path === `${base}/completion-summary`) {
      const totalWords = pages[0].words.length;
      return respondJson(route, {
        assessment: {
          first_pass_correct: totalWords,
          first_pass_incorrect: 0,
          self_corrected_words: 0,
          unresolved_words: 0,
          retry_attempts: 0,
          skipped_after_retry_limit: 0,
          recognition_uncertain: 0,
        },
        duration_minutes: 1,
        pages_explored: Math.max(1, completedPages.size),
        selected_range_pages: pages.length,
        practiced_words: totalWords,
        score: 100,
        correct_words: pages[0].words.map((w) => w.text),
        mispronounced_words: [],
        skipped_words: [],
        transcripts: [pages[0].text],
        spoken_words: pages[0].words.map((w) => w.text),
      });
    }
    if (path === `${base}/finish`) {
      finished = true;
      return respondJson(route, sessionSummaryDto());
    }
    if (path === `${base}/reports`) {
      return respondJson(route, {
        session_id: sessionId,
        reports: latestReport ? [latestReport] : [],
        total: latestReport ? 1 : 0,
        assessment: null,
      });
    }
    if (path === `${base}/compare`) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      comparisons.push(body);
      const currentPage = pages[currentPageIndex];
      latestReport = {
        report_id: ids.oldRevision,
        created_at: now,
        page_id: currentPage.page_id,
        page_revision_id: currentPage.page_revision_id,
        transcript: currentPage.text,
        distance: 0,
        alignment: currentPage.words.map((w) => ({
          book_word: w.text,
          spoken_word: w.text,
          book_index: w.word_index,
          spoken_index: w.word_index,
          status: "MATCH",
        })),
        summary: {
          assessment_version: 1,
          initial_assessment: currentPage.words.map((w) => ({
            ...w,
            status: "CORRECT",
          })),
          missing_words: [],
          extra_words: [],
          substitutions: [],
          repeated_count: 0,
          repeated_words: [],
          hesitations: [],
          hesitation_seconds: null,
        },
      };
      return respondJson(route, { session_id: sessionId, ...latestReport });
    }
    if (path === "/reading/events") {
      const ev = route.request().postDataJSON() as Record<string, unknown>;
      readingEvents.push(ev);
      return respondJson(
        route,
        { ...ev, Id: ids.draftRevision, Confidence: null, CreatedAt: now },
        201,
      );
    }
    if (path.includes("/questions")) {
      return respondJson(route, { session_id: sessionId, questions: [] });
    }
    unexpectedReadingPaths.push(path);
    api.unexpected.push(`reading:${path}`);
    return respondJson(route, {}, 404);
  });

  await page.route("http://127.0.0.1:8000/tutor/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (
      path.startsWith("/tutor/children/") &&
      path.endsWith("/progress-assessment")
    ) {
      return route.fallback();
    }
    return respondJson(route, {
      session_id: sessionId,
      total: 0,
      source: null,
      created: false,
    });
  });

  await page.route("http://127.0.0.1:8000/voice/**", async (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    const path = new URL(route.request().url()).pathname;
    if (path === "/voice/status") {
      return respondJson(route, {
        default_mode: "local_only",
        default_voice_id: "Binh",
        local: {
          available: voiceState.localAvailable,
          stt_ready: voiceState.localSttReady,
          tts_ready: voiceState.localTtsReady,
        },
        google: {
          stt_configured: voiceState.googleSttConfigured,
          tts_configured: voiceState.googleTtsConfigured,
          stt_cooldown: false,
          tts_cooldown: false,
        },
      });
    }
    if (path === "/voice/voices") {
      return respondJson(route, {
        default_voice_id: "Binh",
        voices: [
          {
            voice_id: "Binh",
            name: "Bình (Nam miền Bắc)",
            gender: "male",
            region: "north",
          },
          {
            voice_id: "Ngoc",
            name: "Ngọc (Nữ miền Nam)",
            gender: "female",
            region: "south",
          },
        ],
      });
    }
    if (path === "/voice/text-to-speech/timed") {
      if (voiceState.timedTtsDelayMs > 0) {
        await new Promise((r) => setTimeout(r, voiceState.timedTtsDelayMs));
      }
      const body = route.request().postDataJSON() as {
        words?: string[];
        cache_scope?: string;
        book_id?: string;
        page_id?: string;
      };
      const reqScope = body.cache_scope ?? null;
      const respScope =
        visibilityScope === "PARENT_PRIVATE" ? "PRIVATE" : "CATALOG";
      ttsRequests.push({
        path,
        cacheScope: reqScope,
        bookId: body.book_id ?? null,
        pageId: body.page_id ?? null,
        status: voiceState.timedTtsStatus,
        responseScope: respScope,
      });
      if (voiceState.timedTtsStatus !== 200) {
        return respondJson(
          route,
          { detail: { code: "SPEECH_UNAVAILABLE" } },
          voiceState.timedTtsStatus,
        );
      }
      const words = body.words ?? [];
      const dur = voiceState.timedTtsDurationSeconds;
      return respondJson(
        route,
        {
          audio_base64: createSilentWavBuffer(dur).toString("base64"),
          content_type: "audio/wav",
          duration_seconds: dur,
          words: words.map((_w, index) => ({
            index,
            start: (index * dur) / Math.max(1, words.length),
            end: ((index + 1) * dur) / Math.max(1, words.length),
          })),
        },
        200,
        {
          "x-tts-scope": respScope,
          "cache-control": "private, no-store",
        },
      );
    }
    if (path === "/voice/text-to-speech") {
      if (voiceState.shortTtsDelayMs > 0) {
        await new Promise((r) => setTimeout(r, voiceState.shortTtsDelayMs));
      }
      const body = route.request().postDataJSON() as {
        cache_scope?: string;
        book_id?: string;
        page_id?: string;
      };
      const reqScope = body.cache_scope ?? null;
      const respScope =
        visibilityScope === "PARENT_PRIVATE" ? "PRIVATE" : "CATALOG";
      ttsRequests.push({
        path,
        cacheScope: reqScope,
        bookId: body.book_id ?? null,
        pageId: body.page_id ?? null,
        status: voiceState.shortTtsStatus,
        responseScope: respScope,
      });
      if (voiceState.shortTtsStatus !== 200) {
        return respondJson(
          route,
          { detail: { code: "LOCAL_TTS_UNAVAILABLE" } },
          voiceState.shortTtsStatus,
        );
      }
      return route.fulfill({
        status: 200,
        headers: {
          ...corsHeaders,
          "x-tts-scope": respScope,
          "cache-control": "private, no-store",
        },
        contentType: "audio/wav",
        body: createSilentWavBuffer(voiceState.shortTtsDurationSeconds),
      });
    }
    if (path === "/voice/text-to-speech/phonics") {
      if (voiceState.phonicsTtsStatus !== 200) {
        return respondJson(
          route,
          { detail: { code: "PHONICS_TTS_UNAVAILABLE" } },
          voiceState.phonicsTtsStatus,
        );
      }
      return respondJson(route, {
        audio_base64: createSilentWavBuffer(0.6).toString("base64"),
        content_type: "audio/wav",
        duration_seconds: 0.6,
        step_timings: [{ id: "step-1", index: 0, start: 0, end: 0.6 }],
        resolved_voice_id: "local_north_truc_ly",
        model_version: "vieneu-v3-turbo-onnx-fp32-3.8.5",
      });
    }
    if (path === "/voice/speech-to-text") {
      sttRequests.push({ path, status: voiceState.sttStatus });
      if (voiceState.sttStatus !== 200) {
        return respondJson(
          route,
          { detail: { code: "STT_TEMPORARILY_UNAVAILABLE" } },
          voiceState.sttStatus,
        );
      }
      return respondJson(route, {
        text:
          voiceState.sttTranscript ??
          pages[currentPageIndex].words[0]?.text ??
          "Bé",
        language_code: "vi",
        language_probability: 0.98,
        words: null,
      });
    }
    unexpectedReadingPaths.push(path);
    api.unexpected.push(`voice:${path}`);
    return respondJson(route, {}, 404);
  });

  if (options.nativeBridge) {
    await installNativeSpeechBridgeMock(page, options.nativeBridge);
  }
  if (options.wasmWorker) {
    await installWasmWorkerMock(page, options.wasmWorker);
  }
  await installSpeechAndAudioMock(page, options.speechAndAudio);

  if (options.autoNavigate !== false) {
    await page.goto(
      `/reading/${sessionId}?state=${options.initialState ?? "reading"}`,
    );
    await expect(page.locator('[data-reading-shell="true"]')).toBeVisible();
  }

  return {
    api,
    bookId,
    sessionId,
    pages,
    voiceState,
    catalogTtsRequests,
    sttRequests,
    ttsRequests,
    comparisons,
    readingEvents,
    unexpectedReadingPaths,
    setCurrentPageIndex: (index: number) => {
      currentPageIndex = index;
    },
    inspectLeakage: () =>
      inspectPrivateAudioLeakage(page, {
        catalogTtsRequests,
        ttsRequests,
      }),
  };
}
