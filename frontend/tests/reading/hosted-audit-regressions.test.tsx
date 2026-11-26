import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";

import { AppStoreProvider } from "@/components/providers/app-store-provider";
import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { ReadingVoiceSettings } from "@/components/reading/reading-voice-settings";
import * as voiceStudioServiceModule from "@/lib/api/voice-studio-service";
import { BookScannerScreen } from "@/components/reading/book-scanner-screen";
import { buildSpeechServiceError } from "@/lib/api/speech-error";
import {
  LocalSegmentSpeechRecognition,
  isPermanentLocalVoiceUnconfigured,
} from "@/lib/reading/local-segment-speech-recognition";
import { setVoicePolicyPreferences } from "@/lib/reading/session-voice-lock";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import {
  resetVoiceEngineStatus,
  getVoiceEngineStatus,
  setCachedVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import { resetBrowserWasmSttForTests } from "@/lib/reading/browser-wasm-stt";

const mockReplace = vi.fn();
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "https://capstone1-ssd8.onrender.com",
}));

describe("Hosted Audit Regressions (DEF-H01..DEF-H10)", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockReplace.mockReset();
    mockPush.mockReset();
    resetVoiceEngineStatus();
    resetBrowserWasmSttForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("DEF-H01: sherpa-stt-worker resolves top-level lexical class OfflineRecognizer (not self.OfflineRecognizer)", async () => {
    const workerSrc = fs.readFileSync(
      path.resolve(__dirname, "../../public/workers/sherpa-stt-worker.js"),
      "utf8",
    );
    const expectedSizes: Record<string, number> = {
      "encoder.int8.onnx": 27699063,
      "decoder.onnx": 5165084,
      "joiner.int8.onnx": 1033417,
      "tokens.txt": 23238,
    };
    const expectedHashes: Record<string, string> = {
      "encoder.int8.onnx":
        "8ef5286dd427eb108055c2ddc1982aa31e544706072d5ea228729292dacade68",
      "decoder.onnx":
        "cf2aa385b82c9d5d40cd29c3188af52d0249b3b78f0d4b7eb84ad502d50c7e7f",
      "joiner.int8.onnx":
        "7311d2e17b810ecea515d79c71cc4668af8759256a06fa01d27047772320c821",
      "tokens.txt":
        "ca8171f8bbd516c050b627582f2125c8f5f1f6ed967ab41b0fa9aae2cf61b492",
    };

    const posted: Array<{
      type?: string;
      id?: string;
      text?: string;
      message?: string;
    }> = [];
    const fakeSelf: Record<string, unknown> = {
      performance: { now: () => 10 },
      postMessage: (m: {
        type?: string;
        id?: string;
        text?: string;
        message?: string;
      }) => posted.push(m),
      crypto: {
        subtle: {
          digest: async (_alg: string, buf: ArrayBuffer) => {
            const entry = Object.entries(expectedSizes).find(
              ([, len]) => len === buf.byteLength,
            );
            const hex = entry
              ? expectedHashes[entry[0]]
              : crypto
                  .createHash("sha256")
                  .update(Buffer.from(buf))
                  .digest("hex");
            return Uint8Array.from(Buffer.from(hex, "hex")).buffer;
          },
        },
      },
      fetch: async (url: string) => {
        const fname = url.split("/").pop() ?? "";
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => new ArrayBuffer(expectedSizes[fname] ?? 4),
        };
      },
      onmessage: null,
    };

    // Simulate real browser importScripts where `class OfflineRecognizer` is a global lexical binding
    // and `self.OfflineRecognizer` is strictly `undefined`!
    const sandbox: Record<string, unknown> = {
      self: fakeSelf,
      fetch: fakeSelf.fetch,
      crypto: fakeSelf.crypto,
      importScripts: () => {
        const mod = fakeSelf.Module as Record<string, unknown>;
        mod.FS_unlink = vi.fn();
        mod.FS_createDataFile = vi.fn();
        (mod.onRuntimeInitialized as () => void)();
      },
    };
    const combinedSrc = `
      class OfflineRecognizer {
        createStream() { return { acceptWaveform() {}, free() {} }; }
        decode() {}
        getResult() { return { text: "xin chào việt nam" }; }
        free() {}
      }
      ${workerSrc}
    `;
    vm.runInNewContext(combinedSrc, sandbox);
    expect(fakeSelf.OfflineRecognizer).toBeUndefined();

    const onmessage = fakeSelf.onmessage as (ev: {
      data: unknown;
    }) => Promise<void>;
    await onmessage({ data: { type: "init", id: "init_1" } });
    expect(posted.some((m) => m.type === "ready" && m.id === "init_1")).toBe(
      true,
    );

    const voicedSamples = new Float32Array(8000);
    for (let i = 0; i < voicedSamples.length; i += 1) {
      voicedSamples[i] = 0.08 * Math.sin((2 * Math.PI * 320 * i) / 16000);
    }
    await onmessage({
      data: {
        type: "transcribe",
        id: "t_1",
        samples: voicedSamples,
        sampleRate: 16000,
      },
    });
    expect(
      posted.some(
        (m) =>
          m.type === "result" &&
          m.id === "t_1" &&
          m.text === "xin chào việt nam",
      ),
    ).toBe(true);
  });

  it("DEF-H04: Direct navigation to /books?childId=... does not wipe childId when auth hydrates", async () => {
    const childId = "3aaf937b-e9ef-42e7-86a0-8df060b162bd";
    window.history.pushState({}, "", `/books?childId=${childId}`);

    const childGet = vi.fn().mockResolvedValue({
      id: childId,
      parent_id: "parent-1",
      alias: "Bé An",
      grade: 2,
      settings: {},
      created_at: "2026-11-25T00:00:00Z",
    });

    function ChildProbe() {
      const { state } = useValidatedSelectedChild();
      return (
        <div data-testid="probe-status">
          {state.status}:{state.childId ?? "none"}
        </div>
      );
    }

    function Harness({ children }: { children?: ReactNode }) {
      const [authStatus, setAuthStatus] = useState<
        "initializing" | "authenticated"
      >("initializing");
      return (
        <AuthRuntimeContext.Provider
          value={
            {
              hasProvider: true,
              status: authStatus,
              session:
                authStatus === "authenticated"
                  ? { user: { id: "parent-1", email: "qa@example.invalid" } }
                  : null,
              lastEvent:
                authStatus === "authenticated" ? "INITIAL_SESSION" : null,
            } as never
          }
        >
          <AppServicesContext.Provider
            value={{ childService: { get: childGet } } as never}
          >
            <AppStoreProvider>
              <button
                type="button"
                onClick={() => setAuthStatus("authenticated")}
              >
                hydrate
              </button>
              <ChildProbe />
              {children}
            </AppStoreProvider>
          </AppServicesContext.Provider>
        </AuthRuntimeContext.Provider>
      );
    }

    render(<Harness />);
    expect(screen.getByTestId("probe-status").textContent).toBe("loading:none");

    fireEvent.click(screen.getByText("hydrate"));

    await waitFor(() => {
      expect(screen.getByTestId("probe-status").textContent).toBe(
        `ready:${childId}`,
      );
    });
    expect(childGet).toHaveBeenCalledWith(childId);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("DEF-H10: ReadingVoiceSettings renders footer buttons inside Modal footer slot", () => {
    render(
      <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Giọng đọc/i }));
    const modalFooter = document.querySelector('[data-modal-footer="true"]');
    expect(modalFooter).not.toBeNull();
    expect(modalFooter?.textContent).toContain("Dùng giọng mặc định");
    expect(modalFooter?.textContent).toContain("Nghe thử");
  });

  it("DEF-H09: BookScannerScreen renders offline OCR worker banner when /health reports ocr.ready=false", async () => {
    const childId = "3aaf937b-e9ef-42e7-86a0-8df060b162bd";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          ocr: { mode: "remote_worker", ready: false, workers: [] },
        }),
      }),
    );

    const childGet = vi.fn().mockResolvedValue({
      id: childId,
      parent_id: "parent-1",
      alias: "Bé An",
      grade: 2,
      settings: {},
      created_at: "2026-11-25T00:00:00Z",
    });

    render(
      <AuthRuntimeContext.Provider
        value={
          {
            hasProvider: true,
            status: "authenticated",
            session: { user: { id: "parent-1", email: "qa@example.invalid" } },
            lastEvent: "INITIAL_SESSION",
          } as never
        }
      >
        <AppServicesContext.Provider
          value={{ childService: { get: childGet } } as never}
        >
          <AppStoreProvider initialChildId={childId}>
            <BookScannerScreen />
          </AppStoreProvider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ocr-worker-offline-banner")).toBeTruthy();
    });
    expect(screen.getByTestId("ocr-worker-offline-banner").textContent).toMatch(
      /ngoại tuyến|đang tạm tắt/i,
    );
  });

  it("DEF-H07: real ServiceError from LOCAL_VOICE_UNCONFIGURED is detected and immediately switches to WASM", () => {
    vi.stubGlobal(
      "Worker",
      class {
        postMessage = vi.fn();
        terminate = vi.fn();
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
      },
    );
    vi.stubGlobal("WebAssembly", { validate: () => true });
    vi.stubGlobal("crypto", { subtle: { digest: vi.fn() } });

    const realServiceError = buildSpeechServiceError({
      capability: "STT_UNAVAILABLE",
      status: 503,
      requestId: "req-unconfigured-1",
      providerCode: "LOCAL_VOICE_UNCONFIGURED",
    });
    expect(realServiceError.provider_code).toBe("LOCAL_VOICE_UNCONFIGURED");
    expect(isPermanentLocalVoiceUnconfigured(realServiceError)).toBe(true);

    const transientError = buildSpeechServiceError({
      capability: "STT_UNAVAILABLE",
      status: 503,
      requestId: "req-busy-1",
      providerCode: "LOCAL_STT_BUSY",
    });
    expect(isPermanentLocalVoiceUnconfigured(transientError)).toBe(false);

    const rec = new LocalSegmentSpeechRecognition({
      synthesize: vi.fn(),
      transcribe: vi.fn(),
    } as never) as unknown as {
      recordTechnicalFailureAndMaybeFallback: (
        forceImmediate?: boolean,
      ) => boolean;
    };

    const switched = rec.recordTechnicalFailureAndMaybeFallback(
      isPermanentLocalVoiceUnconfigured(realServiceError),
    );
    expect(switched).toBe(true);
    expect(getVoiceEngineStatus().stt.tier).toBe("browser_wasm");
  });

  it("DEF-H09b: BookScannerScreen shows non-blocking waking/unreachable banner when /health returns 503", async () => {
    const childId = "3aaf937b-e9ef-42e7-86a0-8df060b162bd";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ detail: "Service Unavailable" }),
      }),
    );

    const childGet = vi.fn().mockResolvedValue({
      id: childId,
      parent_id: "parent-1",
      alias: "Bé An",
      grade: 2,
      settings: {},
      created_at: "2026-11-25T00:00:00Z",
    });

    render(
      <AuthRuntimeContext.Provider
        value={
          {
            hasProvider: true,
            status: "authenticated",
            session: { user: { id: "parent-1", email: "qa@example.invalid" } },
            lastEvent: "INITIAL_SESSION",
          } as never
        }
      >
        <AppServicesContext.Provider
          value={{ childService: { get: childGet } } as never}
        >
          <AppStoreProvider initialChildId={childId}>
            <BookScannerScreen />
          </AppStoreProvider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ocr-worker-offline-banner")).toBeTruthy();
    });
    expect(
      screen.getByTestId("ocr-worker-offline-banner").textContent,
    ).toContain("đang khởi động");
  });

  it("DEF-H03b: TtsPlayback still queries backend precomputed cache for COACHING even with Google/browser fallback enabled", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    setCachedVoiceEngineHealth({
      checkedAt: Date.now(),
      local: {
        configured: false,
        available: false,
        stt_ready: false,
        tts_ready: false,
        error_code: "LOCAL_VOICE_UNCONFIGURED",
        stt_error_code: "LOCAL_VOICE_UNCONFIGURED",
        tts_error_code: "LOCAL_VOICE_UNCONFIGURED",
      },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    } as never);
    const speakMock = vi.fn(
      (utt: { onstart?: () => void; onend?: () => void }) => {
        utt.onstart?.();
        utt.onend?.();
      },
    );
    vi.stubGlobal("speechSynthesis", {
      speak: speakMock,
      cancel: vi.fn(),
      getVoices: () => [{ lang: "vi-VN", name: "Vietnamese" }],
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        lang = "";
        rate = 1;
        voice: unknown = null;
        onstart?: () => void;
        onend?: () => void;
        onerror?: () => void;
        constructor(t: string) {
          this.text = t;
        }
      },
    );

    const synthesizeMock = vi.fn().mockRejectedValue(
      buildSpeechServiceError({
        capability: "TTS_UNAVAILABLE",
        status: 503,
        providerCode: "LOCAL_VOICE_UNCONFIGURED",
      }),
    );
    const playback = new TtsPlayback(
      {
        synthesize: synthesizeMock,
        transcribe: vi.fn(),
      } as never,
      {
        listVoices: vi.fn(),
        synthesizeTimed: vi.fn(),
      } as never,
    );

    await playback.play("Tuyệt vời!", { coaching: true });
    // Must query backend cache BEFORE falling back to browser speechSynthesis!
    expect(synthesizeMock).toHaveBeenCalledTimes(1);
    expect(speakMock).toHaveBeenCalledTimes(1);
  });

  it("Wi-Fi-only phonics TTS tries backend precomputed phonics & cached catalog word BEFORE browser SpeechSynthesis", async () => {
    setVoicePolicyPreferences({
      providerMode: "local_with_google_fallback",
      allowGoogleTtsFallback: true,
    });
    setCachedVoiceEngineHealth({
      local: {
        configured: false,
        available: false,
        stt_ready: false,
        tts_ready: false,
        error_code: "LOCAL_VOICE_UNCONFIGURED",
        stt_error_code: "LOCAL_VOICE_UNCONFIGURED",
        tts_error_code: "LOCAL_VOICE_UNCONFIGURED",
      },
      google: {
        stt_configured: false,
        tts_configured: false,
        stt_cooldown: false,
        tts_cooldown: false,
      },
    } as never);
    const speakMock = vi.fn(
      (utt: { onstart?: () => void; onend?: () => void }) => {
        utt.onstart?.();
        utt.onend?.();
      },
    );
    vi.stubGlobal("speechSynthesis", {
      speak: speakMock,
      cancel: vi.fn(),
      getVoices: () => [{ lang: "vi-VN", name: "Vietnamese" }],
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        text: string;
        lang = "";
        rate = 1;
        voice: unknown = null;
        onstart?: () => void;
        onend?: () => void;
        onerror?: () => void;
        constructor(t: string) {
          this.text = t;
        }
      },
    );

    const err503 = buildSpeechServiceError({
      capability: "TTS_UNAVAILABLE",
      status: 503,
      providerCode: "LOCAL_VOICE_UNCONFIGURED",
    });
    const synthesizePhonicsMock = vi.fn().mockRejectedValue(err503);
    const synthesizeMock = vi.fn().mockRejectedValue(err503);
    const playback = new TtsPlayback(
      {
        synthesize: synthesizeMock,
        synthesizePhonics: synthesizePhonicsMock,
        transcribe: vi.fn(),
      } as never,
      {
        listVoices: vi.fn(),
        synthesizeTimed: vi.fn(),
      } as never,
    );
    playback.setCacheContext({
      bookId: "11111111-1111-4111-8111-111111111111",
      pageId: "22222222-2222-4222-8222-222222222222",
    });

    await playback.playPhonicsLesson(
      {
        word: "mèo",
        focusSyllable: "mèo",
        syllables: ["mèo"],
        steps: [
          {
            id: "s1",
            index: 0,
            kind: "whole_syllable",
            displayText: "mèo",
            spokenText: "mèo",
            pauseAfterMs: 10,
          },
        ],
      } as never,
      {},
    );
    // Must NOT skip Render precomputed phonics & catalog word cache!
    expect(synthesizePhonicsMock).toHaveBeenCalledTimes(1);
    expect(synthesizeMock).toHaveBeenCalledTimes(1);
    expect(speakMock).toHaveBeenCalledTimes(1);
  });

  it("BookScannerScreen shows unreachable/waking banner (not offline) when /health returns probe_degraded=true", async () => {
    const childId = "3aaf937b-e9ef-42e7-86a0-8df060b162bd";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          ocr: {
            mode: "remote_worker",
            ready: false,
            probe_degraded: true,
            workers: [],
          },
        }),
      }),
    );

    const childGet = vi.fn().mockResolvedValue({
      id: childId,
      parent_id: "parent-1",
      alias: "Bé An",
      grade: 2,
      settings: {},
      created_at: "2026-11-25T00:00:00Z",
    });

    render(
      <AuthRuntimeContext.Provider
        value={
          {
            hasProvider: true,
            status: "authenticated",
            session: { user: { id: "parent-1", email: "qa@example.invalid" } },
            lastEvent: "INITIAL_SESSION",
          } as never
        }
      >
        <AppServicesContext.Provider
          value={{ childService: { get: childGet } } as never}
        >
          <AppStoreProvider initialChildId={childId}>
            <BookScannerScreen />
          </AppStoreProvider>
        </AppServicesContext.Provider>
      </AuthRuntimeContext.Provider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("ocr-worker-offline-banner")).toBeTruthy();
    });
    const text = screen.getByTestId("ocr-worker-offline-banner").textContent;
    expect(text).toContain("đang khởi động");
    expect(text).not.toContain("Máy trạm OCR hiện đang ngoại tuyến");
  });

  it("ReadingVoiceSettings shows offline cache notice when local_worker_ready=false", async () => {
    const listVoices = vi.fn().mockResolvedValue({
      voices: [
        {
          voice_id: "local_north_truc_ly",
          name: "Cô Trúc Ly",
          gender: "female",
          region: "north",
          provider: "local",
        },
        {
          voice_id: "local_south_thuc_doan",
          name: "Cô Thục Đoan",
          gender: "female",
          region: "south",
          provider: "local",
        },
      ],
      default_voice_id: "local_north_truc_ly",
      local_worker_ready: false,
      google_tts_available: false,
    });

    vi.spyOn(
      voiceStudioServiceModule,
      "createVoiceStudioService",
    ).mockReturnValue({
      listVoices,
      synthesizeTimed: vi.fn(),
    } as never);

    render(
      <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Giọng đọc/i }));

    await waitFor(() => {
      expect(screen.getByTestId("voice-offline-cache-notice")).toBeTruthy();
    });
    expect(
      screen.getByTestId("voice-offline-cache-notice").textContent,
    ).toContain("Wi-Fi tự lập");
  });

  it("ReadingVoiceSettings shows Wi-Fi badges and lists all cached regional voices when offline", async () => {
    const listVoices = vi.fn().mockResolvedValue({
      voices: [
        {
          voice_id: "local_north_truc_ly",
          name: "Cô Trúc Ly",
          gender: "female",
          region: "north",
          provider: "local",
        },
        {
          voice_id: "local_central_ngoc_tran",
          name: "Cô Ngọc Trân",
          gender: "female",
          region: "central",
          provider: "local",
        },
        {
          voice_id: "local_south_thuc_doan",
          name: "Cô Thục Đoan",
          gender: "female",
          region: "south",
          provider: "local",
        },
        {
          voice_id: "local_south_thai_son",
          name: "Thầy Thái Sơn",
          gender: "male",
          region: "south",
          provider: "local",
        },
      ],
      default_voice_id: "local_north_truc_ly",
      local_worker_ready: false,
      google_tts_available: false,
      cached_voice_ids: [
        "local_north_truc_ly",
        "local_central_ngoc_tran",
        "local_south_thuc_doan",
      ],
    });

    vi.spyOn(
      voiceStudioServiceModule,
      "createVoiceStudioService",
    ).mockReturnValue({
      listVoices,
      synthesizeTimed: vi.fn(),
    } as never);

    render(
      <ReadingVoiceSettings onPreview={vi.fn()} onStopPreview={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Giọng đọc/i }));

    await waitFor(() => {
      expect(screen.getByTestId("voice-offline-cache-notice")).toBeTruthy();
    });
    expect(
      screen.getByTestId("voice-wifi-ready-badge-local_north_truc_ly"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("voice-wifi-ready-badge-local_central_ngoc_tran"),
    ).toBeTruthy();
    expect(
      screen.getByTestId("voice-wifi-ready-badge-local_south_thuc_doan"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("voice-wifi-ready-badge-local_south_thai_son"),
    ).toBeNull();
    const notice = screen.getByTestId("voice-offline-cache-notice").textContent;
    expect(notice).toContain("Cô Trúc Ly");
    expect(notice).toContain("Cô Ngọc Trân");
    expect(notice).toContain("Cô Thục Đoan");
  });
});
