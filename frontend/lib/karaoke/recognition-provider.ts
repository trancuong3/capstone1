import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import type { BrowserRecognitionEventLike } from "@/lib/reading/browser-transcript-collector";
import { resolveLocalFirstSpeechRecognitionConstructor } from "@/lib/reading/local-segment-speech-recognition";

export interface SingingRecognizer {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
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
  supported: () => Boolean(recognitionConstructor()),
  create: () => {
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
