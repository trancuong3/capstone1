import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import type { BrowserRecognitionEventLike } from "@/lib/reading/browser-transcript-collector";
import { resolveLocalFirstSpeechRecognitionConstructor } from "@/lib/reading/local-segment-speech-recognition";
import {
  AndroidNativeSpeechRecognition,
  getCachedAndroidSpeechCapabilities,
  isAndroidNativeSpeechAvailable,
} from "@/lib/reading/native-speech-bridge";

export interface SingingRecognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  readonly managesOwnMicrophone?: boolean;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: BrowserRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
}

type SingingRecognizerConstructor = new () => SingingRecognizer;

function canUseAndroidNativeSingingRecognizer(): boolean {
  if (!isAndroidNativeSpeechAvailable()) return false;
  const caps = getCachedAndroidSpeechCapabilities();
  return caps ? caps.sttAvailable : true;
}

class AndroidNativeSingingRecognizer implements SingingRecognizer {
  continuous = true;
  interimResults = true;
  lang = "vi-VN";
  maxAlternatives = 3;
  readonly managesOwnMicrophone = true;

  onstart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  onresult: ((event: BrowserRecognitionEventLike) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;

  private readonly inner = new AndroidNativeSpeechRecognition();
  private startedEmitted = false;
  private speechStarted = false;

  start(): void {
    this.startedEmitted = false;
    this.speechStarted = false;
    this.inner.lang = this.lang;
    this.inner.continuous = this.continuous;
    this.inner.interimResults = this.interimResults;
    this.inner.maxAlternatives = Math.max(1, this.maxAlternatives);

    const emitStart = () => {
      if (this.startedEmitted) return;
      this.startedEmitted = true;
      this.onstart?.();
    };

    this.inner.onready = () => {
      emitStart();
    };
    this.inner.ononset = () => {
      emitStart();
      if (!this.speechStarted) {
        this.speechStarted = true;
        this.onspeechstart?.();
      }
    };
    this.inner.onresult = (event) => {
      emitStart();
      if (!this.speechStarted) {
        this.speechStarted = true;
        this.onspeechstart?.();
      }
      this.onresult?.(event as unknown as BrowserRecognitionEventLike);
    };
    this.inner.onerror = (event) => {
      this.onerror?.({ error: event.error });
    };
    this.inner.onend = () => {
      if (this.speechStarted) {
        this.speechStarted = false;
        this.onspeechend?.();
      }
      this.onend?.();
    };
    this.inner.start();
  }

  stop(): void {
    this.inner.stop();
  }

  abort(): void {
    this.inner.abort();
  }
}

let cachedKaraokeSpeechService: SpeechService | null = null;
function getKaraokeSpeechService(): SpeechService {
  if (!cachedKaraokeSpeechService) {
    cachedKaraokeSpeechService = createSpeechService();
  }
  return cachedKaraokeSpeechService;
}

function browserNativeRecognitionConstructor(): SingingRecognizerConstructor | null {
  if (typeof window === "undefined") return null;
  const browser = window as Window & {
    SpeechRecognition?: SingingRecognizerConstructor;
    webkitSpeechRecognition?: SingingRecognizerConstructor;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}

function recognitionConstructor(): SingingRecognizerConstructor | null {
  const nativeCtor = browserNativeRecognitionConstructor();
  if (nativeCtor) return nativeCtor;
  if (typeof window === "undefined") return null;
  const fallbackCtor = resolveLocalFirstSpeechRecognitionConstructor(
    window as unknown as Parameters<
      typeof resolveLocalFirstSpeechRecognitionConstructor
    >[0],
    getKaraokeSpeechService(),
    () => ({ sessionId: "karaoke" }),
  ) as SingingRecognizerConstructor | undefined;
  return fallbackCtor ?? null;
}

export interface SingingRecognitionProvider {
  readonly id: string;
  supported(): boolean;
  create(): SingingRecognizer | null;
}

export const browserSingingProvider: SingingRecognitionProvider = {
  id: "browser-vi-VN",
  supported: () =>
    canUseAndroidNativeSingingRecognizer() || Boolean(recognitionConstructor()),
  create: () => {
    if (canUseAndroidNativeSingingRecognizer()) {
      const recognition = new AndroidNativeSingingRecognizer();
      recognition.lang = "vi-VN";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 3;
      return recognition;
    }
    const Constructor = recognitionConstructor();
    if (!Constructor) return null;
    const recognition = new Constructor();
    recognition.lang = "vi-VN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    return recognition;
  },
};
