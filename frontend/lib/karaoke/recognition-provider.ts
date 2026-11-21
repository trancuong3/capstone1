import type { BrowserRecognitionEventLike } from "@/lib/reading/browser-transcript-collector";

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

function recognitionConstructor() {
  if (typeof window === "undefined") return null;
  const browser = window as Window & {
    SpeechRecognition?: new () => SingingRecognizer;
    webkitSpeechRecognition?: new () => SingingRecognizer;
  };
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
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
