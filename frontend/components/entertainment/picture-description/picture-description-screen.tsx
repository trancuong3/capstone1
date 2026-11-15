"use client";

import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Eye,
  EyeOff,
  History,
  ImagePlus,
  Lightbulb,
  Mic,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Star,
  Upload,
  Volume2,
  VolumeX,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import { BookChildHeader } from "@/components/books/book-child-header";
import { Button } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { usePictureDescriptionService } from "@/hooks/use-picture-description-service";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechRecorder } from "@/hooks/use-speech-recorder";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { isServiceError } from "@/lib/api/service-error";
import { createSpeechService, type SpeechService } from "@/lib/api/speech-service";
import {
  BrowserTranscriptCollector,
  type BrowserRecognitionEventLike,
  resolveTranscriptForSegment,
} from "@/lib/reading/browser-transcript-collector";
import type {
  PictureAttemptDTO,
  PictureBookPageItemDTO,
  PictureCatalogDTO,
  PictureInputMode,
  PictureSampleItemDTO,
  PictureSessionDTO,
  PictureSessionSummaryDTO,
} from "@/types/picture-description";

type SourceTab = "SAMPLE" | "CUSTOM_UPLOAD" | "BOOK_PAGE";
type CatalogState =
  | { status: "loading" }
  | {
      status: "ready";
      catalog: PictureCatalogDTO;
      sessions: PictureSessionSummaryDTO[];
    }
  | { status: "error"; message: string };

interface BrowserSpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: BrowserRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type BrowserSpeechRecognitionCtor = new () => BrowserSpeechRecognitionLike;

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const defaultGameError =
  "Chưa kết nối được góc Kể chuyện qua tranh. Ba mẹ và bé hãy thử lại nhé.";

function getSpeechRecognitionCtor(): BrowserSpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const record = window as unknown as {
    SpeechRecognition?: BrowserSpeechRecognitionCtor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionCtor;
  };
  return record.SpeechRecognition ?? record.webkitSpeechRecognition ?? null;
}

function sourceLabel(source: PictureSessionSummaryDTO["source_type"]): string {
  switch (source) {
    case "BOOK_PAGE":
      return "Từ sách ViRead";
    case "CUSTOM_UPLOAD":
      return "Ảnh tải lên";
    default:
      return "Tranh chủ đề";
  }
}

function renderStars(count: number) {
  return (
    <span
      aria-label={`${count} trên 3 sao`}
      className="inline-flex items-center gap-1"
    >
      {[1, 2, 3].map((index) => (
        <Star
          aria-hidden="true"
          className={
            index <= count
              ? "size-5 fill-[#F4C430] text-[#E5A913]"
              : "size-5 text-border"
          }
          key={index}
        />
      ))}
    </span>
  );
}

export function PictureDescriptionScreen() {
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const pictureService = usePictureDescriptionService();
  const speechService = useMemo<SpeechService>(() => createSpeechService(), []);
  const speechPlayer = useSpeechPlayer();
  const recorder = useSpeechRecorder();

  const [catalogState, setCatalogState] = useState<CatalogState>({
    status: "loading",
  });
  const [catalogRefreshKey, setCatalogRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState<SourceTab>("SAMPLE");
  const [session, setSession] = useState<PictureSessionDTO | null>(null);
  const [selectedVocabWord, setSelectedVocabWord] = useState<string | null>(null);
  const [showSampleSentences, setShowSampleSentences] = useState(false);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreviewUrl, setUploadPreviewUrl] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  const [playingSpeechKey, setPlayingSpeechKey] = useState<string | null>(null);

  const [descriptionText, setDescriptionText] = useState("");
  const [inputMode, setInputMode] = useState<PictureInputMode>("TEXT");
  const [latestAttempt, setLatestAttempt] = useState<PictureAttemptDTO | null>(
    null,
  );

  const browserRecognitionRef = useRef<BrowserSpeechRecognitionLike | null>(null);
  const collectorRef = useRef<BrowserTranscriptCollector>(
    new BrowserTranscriptCollector(),
  );
  const requestControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const unmountActionsRef = useRef({
    cancelRecorder: recorder.cancel,
    stopSpeech: speechPlayer.stop,
  });

  const childId = childState.status === "ready" ? childState.child.id : null;

  useEffect(() => {
    if (!uploadPreviewUrl) return;
    return () => {
      URL.revokeObjectURL(uploadPreviewUrl);
    };
  }, [uploadPreviewUrl]);

  useEffect(() => {
    unmountActionsRef.current = {
      cancelRecorder: recorder.cancel,
      stopSpeech: speechPlayer.stop,
    };
  });

  useEffect(() => {
    return () => {
      requestControllerRef.current?.abort();
      browserRecognitionRef.current?.abort();
      unmountActionsRef.current.stopSpeech();
      unmountActionsRef.current.cancelRecorder();
    };
  }, []);

  useEffect(() => {
    if (!childId) return;

    const controller = new AbortController();
    let active = true;

    void Promise.all([
      pictureService.getCatalog(childId, controller.signal),
      pictureService.listSessions(childId, controller.signal),
    ])
      .then(([catalog, sessions]) => {
        if (!active) return;
        setCatalogState({ status: "ready", catalog, sessions });
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return;
        const message = isServiceError(error) ? error.message : defaultGameError;
        setCatalogState({ status: "error", message });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [catalogRefreshKey, childId, pictureService]);

  const stopSpeechPlayback = useCallback(() => {
    speechPlayer.stop();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setPlayingSpeechKey(null);
  }, [speechPlayer]);

  const speakVietnamese = useCallback(
    async (text: string, key: string) => {
      const cleaned = text.trim();
      if (!cleaned) return;
      if (playingSpeechKey === key) {
        stopSpeechPlayback();
        return;
      }

      stopSpeechPlayback();
      setPlayingSpeechKey(key);

      try {
        await speechPlayer.play(cleaned);
        setPlayingSpeechKey((current) => (current === key ? null : current));
      } catch {
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
          const utterance = new SpeechSynthesisUtterance(cleaned);
          utterance.lang = "vi-VN";
          utterance.onend = () => {
            setPlayingSpeechKey((current) => (current === key ? null : current));
          };
          utterance.onerror = () => {
            setPlayingSpeechKey((current) => (current === key ? null : current));
          };
          window.speechSynthesis.speak(utterance);
        } else {
          setPlayingSpeechKey(null);
        }
      }
    },
    [playingSpeechKey, speechPlayer, stopSpeechPlayback],
  );

  const openSession = useCallback(
    (loaded: PictureSessionDTO) => {
      stopSpeechPlayback();
      setSession(loaded);
      setLatestAttempt(loaded.attempts[0] ?? null);
      setSelectedVocabWord(null);
      setShowSampleSentences((loaded.best_stars ?? 0) >= 1);
      setDescriptionText("");
      setInputMode("TEXT");
      setActionError(null);
      setVoiceMessage(null);
    },
    [stopSpeechPlayback],
  );

  const handleStartSample = async (sample: PictureSampleItemDTO) => {
    if (!childId || !pictureService || isAnalyzing) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setIsAnalyzing(true);
    try {
      const created = await pictureService.createSession(
        {
          child_id: childId,
          source_type: "SAMPLE",
          sample_key: sample.sample_key,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      openSession(created);
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleStartBookPage = async (page: PictureBookPageItemDTO) => {
    if (!childId || !pictureService || isAnalyzing) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setIsAnalyzing(true);
    try {
      const created = await pictureService.createSession(
        {
          child_id: childId,
          source_type: "BOOK_PAGE",
          book_page_id: page.page_id,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      openSession(created);
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    const chosen = event.target.files?.[0] ?? null;
    if (!chosen) {
      setUploadFile(null);
      setUploadPreviewUrl(null);
      return;
    }
    if (!ACCEPTED_TYPES.has(chosen.type)) {
      setUploadFile(null);
      setUploadPreviewUrl(null);
      setUploadError(
        "Chỉ hỗ trợ ảnh định dạng JPG, PNG hoặc WebP. Ba mẹ hãy chọn lại ảnh nhé.",
      );
      return;
    }
    if (chosen.size > MAX_UPLOAD_BYTES) {
      setUploadFile(null);
      setUploadPreviewUrl(null);
      setUploadError("Ảnh hơi nặng (tối đa 5 MB). Hãy chọn ảnh nhẹ hơn nhé.");
      return;
    }
    setUploadFile(chosen);
    setUploadPreviewUrl(URL.createObjectURL(chosen));
  };

  const handleStartUpload = async () => {
    if (!childId || !pictureService || !uploadFile || isAnalyzing) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setUploadError(null);
    setIsAnalyzing(true);
    try {
      const created = await pictureService.createSession(
        {
          child_id: childId,
          source_type: "CUSTOM_UPLOAD",
          image_file: uploadFile,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      openSession(created);
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleResumeSession = async (sessionId: string) => {
    if (!pictureService || isAnalyzing) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setIsAnalyzing(true);
    try {
      const loaded = await pictureService.getSession(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      openSession(loaded);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const startVoiceRecording = async () => {
    if (isRecordingVoice || isTranscribing || isEvaluating) return;
    stopSpeechPlayback();
    setVoiceMessage(null);
    setActionError(null);
    collectorRef.current.reset();

    const SpeechRecognition = getSpeechRecognitionCtor();
    if (SpeechRecognition) {
      try {
        const recognition = new SpeechRecognition();
        recognition.lang = "vi-VN";
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.onresult = (event) => {
          collectorRef.current.addResults(event);
        };
        recognition.onend = () => {
          collectorRef.current.completeRecognitionCycle();
        };
        recognition.onerror = () => {
          // Server STT handles audio transcription even if Web Speech fails.
        };
        browserRecognitionRef.current = recognition;
        recognition.start();
      } catch {
        browserRecognitionRef.current = null;
      }
    }

    try {
      await recorder.start();
      setIsRecordingVoice(true);
      setVoiceMessage("Đang lắng nghe bé nói mô tả bức tranh...");
    } catch {
      browserRecognitionRef.current?.abort();
      browserRecognitionRef.current = null;
      setIsRecordingVoice(false);
      setVoiceMessage(
        "Không mở được micro trên thiết bị này. Bé có thể gõ câu mô tả vào ô bên dưới nhé.",
      );
    }
  };

  const stopVoiceRecording = async () => {
    if (!isRecordingVoice) return;
    setIsRecordingVoice(false);
    setIsTranscribing(true);
    setVoiceMessage("Đang chuyển giọng nói của bé thành chữ...");

    try {
      browserRecognitionRef.current?.stop();
    } catch {
      // Ignore browser recognition stop errors.
    }

    try {
      const audioBlob = await recorder.stop();
      const browserText = collectorRef.current.getTranscript();
      let providerText: string | null = null;

      if (audioBlob && audioBlob.size > 0) {
        const keyterms = session
          ? session.guide.suggested_vocabulary
              .map((item) => item.word)
              .slice(0, 10)
          : [];
        try {
          const sttResult = await speechService.transcribe(audioBlob, {
            languageCode: "vi",
            keyterms,
          });
          providerText = sttResult.text;
        } catch {
          providerText = null;
        }
      }

      const finalTranscript = resolveTranscriptForSegment(
        providerText,
        browserText,
      );
      if (!finalTranscript) {
        setVoiceMessage(
          "Cô chưa nghe rõ tiếng bé nói. Bé hãy bấm micro nói lại hoặc gõ chữ nhé!",
        );
        return;
      }

      setDescriptionText((previous) => {
        const prefix = previous.trim();
        return prefix ? `${prefix} ${finalTranscript}` : finalTranscript;
      });
      setInputMode("VOICE");
      setVoiceMessage(
        "Đã ghi lại lời kể của bé! Bé có thể đọc lại hoặc sửa trước khi gửi chấm bài nhé.",
      );
    } finally {
      setIsTranscribing(false);
      browserRecognitionRef.current = null;
    }
  };

  const handleEvaluate = async () => {
    if (!session || !pictureService || isEvaluating) return;
    const trimmed = descriptionText.trim();
    if (!trimmed) {
      setActionError("Bé hãy nói hoặc viết ít nhất 1 câu mô tả bức tranh nhé.");
      return;
    }

    stopSpeechPlayback();
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;

    setActionError(null);
    setIsEvaluating(true);
    try {
      const response = await pictureService.evaluate(
        session.session_id,
        {
          transcript_text: trimmed,
          input_mode: inputMode,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setSession(response.session);
      setLatestAttempt(response.latest_attempt);
      setShowSampleSentences(true);
      setCatalogRefreshKey((value) => value + 1);
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      setActionError(isServiceError(error) ? error.message : defaultGameError);
    } finally {
      setIsEvaluating(false);
    }
  };

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section className="mx-auto flex w-full max-w-[1130px] flex-col gap-6">
        <Skeleton className="h-24 w-full rounded-card" />
        <Skeleton className="h-96 w-full rounded-card" />
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[780px] flex-col gap-4">
        <StatusMessage tone="error">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>Chưa tải được hồ sơ của bé. Ba mẹ hãy thử lại nhé.</span>
            <Button
              className="w-auto"
              onClick={retryChild}
              size="compact"
              variant="secondary"
            >
              Thử lại
            </Button>
          </div>
        </StatusMessage>
      </section>
    );
  }

  const selectedChild = childState.child;
  const activeAttempt = latestAttempt ?? session?.attempts[0] ?? null;

  return (
    <section className="mx-auto flex w-full max-w-[1130px] flex-col gap-6 pb-8">
      <BookChildHeader child={selectedChild} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            className="inline-flex items-center gap-2 text-sm font-extrabold text-primary hover:underline"
            href="/entertainment"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Quay lại góc Giải trí
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-heading font-extrabold text-ink">
            <Sparkles aria-hidden="true" className="size-7 text-[#E5A913]" />
            Kể chuyện qua tranh
          </h1>
          <p className="text-body text-muted">
            Quan sát bức tranh thật kỹ, kể lại bằng lời của bé để nhận sao từ cô
            giáo AI nhé!
          </p>
        </div>

        {session ? (
          <Button
            onClick={() => {
              stopSpeechPlayback();
              setSession(null);
              setLatestAttempt(null);
              setActionError(null);
            }}
            size="compact"
            type="button"
            variant="secondary"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Chọn bức tranh khác
          </Button>
        ) : null}
      </div>

      {actionError ? (
        <StatusMessage tone="error">{actionError}</StatusMessage>
      ) : null}

      {isAnalyzing ? (
        <div
          aria-live="polite"
          className="flex flex-col items-center justify-center gap-4 rounded-card border border-border bg-white p-10 text-center shadow-sm"
        >
          <Sparkles
            aria-hidden="true"
            className="size-10 animate-pulse text-primary"
          />
          <h2 className="text-xl font-extrabold text-ink">
            Cô giáo AI đang ngắm tranh cùng bé...
          </h2>
          <p className="max-w-md text-body text-muted">
            Hệ thống đang chuẩn bị câu hỏi gợi ý và bộ từ vựng phù hợp cho Lớp{" "}
            {selectedChild.grade}. Đợi một chút xíu nhé!
          </p>
        </div>
      ) : null}

      {!session && !isAnalyzing ? (
        <>
          <div className="rounded-card border border-border bg-white p-5 shadow-sm sm:p-7">
            <div
              aria-label="Chọn nguồn tranh"
              className="flex flex-wrap gap-2 border-b border-border pb-4"
              role="tablist"
            >
              {(
                [
                  {
                    id: "SAMPLE",
                    label: "Tranh chủ đề ViRead",
                    icon: Sparkles,
                  },
                  {
                    id: "CUSTOM_UPLOAD",
                    label: "Tải ảnh từ máy",
                    icon: ImagePlus,
                  },
                  {
                    id: "BOOK_PAGE",
                    label: "Tranh từ sách ViRead",
                    icon: BookOpen,
                  },
                ] as const
              ).map(({ id, label, icon: Icon }) => {
                const selected = activeTab === id;
                return (
                  <button
                    aria-selected={selected}
                    className={
                      "inline-flex min-h-11 items-center gap-2 rounded-control px-4 py-2 text-sm font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary " +
                      (selected
                        ? "bg-primary text-white shadow-sm"
                        : "bg-sky/50 text-ink hover:bg-sky")
                    }
                    key={id}
                    onClick={() => setActiveTab(id)}
                    role="tab"
                    type="button"
                  >
                    <Icon aria-hidden="true" className="size-4" />
                    {label}
                  </button>
                );
              })}
            </div>

            {catalogState.status === "loading" ? (
              <div className="mt-6 grid gap-5 md:grid-cols-3">
                {[1, 2, 3].map((item) => (
                  <Skeleton className="h-72 rounded-card" key={item} />
                ))}
              </div>
            ) : catalogState.status === "error" ? (
              <div className="mt-6">
                <StatusMessage tone="error">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <span>{catalogState.message}</span>
                    <Button
                      className="w-auto"
                      onClick={() => {
                        setCatalogState({ status: "loading" });
                        setCatalogRefreshKey((value) => value + 1);
                      }}
                      size="compact"
                      variant="secondary"
                    >
                      <RefreshCw aria-hidden="true" className="size-4" />
                      Thử lại
                    </Button>
                  </div>
                </StatusMessage>
              </div>
            ) : (
              <div className="mt-6">
                {activeTab === "SAMPLE" ? (
                  <div className="grid gap-5 md:grid-cols-3">
                    {catalogState.catalog.samples.map((sample) => (
                      <article
                        className="flex flex-col overflow-hidden rounded-card border border-border bg-white shadow-sm transition-transform hover:-translate-y-0.5"
                        key={sample.sample_key}
                      >
                        <div className="relative aspect-[4/3] w-full overflow-hidden bg-sky/40">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            alt={sample.title}
                            className="h-full w-full object-cover"
                            src={sample.image_url}
                          />
                          <span className="absolute left-3 top-3 rounded-full bg-white/95 px-3 py-1 text-xs font-extrabold text-primary shadow-sm">
                            {sample.theme}
                          </span>
                        </div>
                        <div className="flex flex-1 flex-col justify-between gap-4 p-4">
                          <div>
                            <h2 className="text-lg font-extrabold text-ink">
                              {sample.title}
                            </h2>
                            <p className="mt-1 text-sm text-muted">
                              {sample.description}
                            </p>
                          </div>
                          <Button
                            onClick={() => void handleStartSample(sample)}
                            type="button"
                          >
                            Khám phá tranh này
                          </Button>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}

                {activeTab === "CUSTOM_UPLOAD" ? (
                  <div className="grid items-start gap-6 lg:grid-cols-[1.05fr_0.95fr]">
                    <div className="flex flex-col gap-4 rounded-card border-2 border-dashed border-primary/40 bg-sky/20 p-6">
                      <div className="flex items-start gap-3">
                        <Upload
                          aria-hidden="true"
                          className="mt-1 size-6 shrink-0 text-primary"
                        />
                        <div>
                          <h2 className="text-lg font-extrabold text-ink">
                            Chọn một bức ảnh hoặc tranh vẽ từ máy
                          </h2>
                          <p className="mt-1 text-sm text-muted">
                            Hỗ trợ ảnh JPG, PNG, WebP tối đa 5 MB. AI sẽ kiểm tra
                            độ an toàn cho bé và tạo câu hỏi gợi ý riêng cho bức
                            ảnh này.
                          </p>
                        </div>
                      </div>

                      <input
                        accept="image/jpeg,image/png,image/webp"
                        aria-label="Chọn tệp ảnh để mô tả"
                        className="sr-only"
                        onChange={handleFileChange}
                        ref={fileInputRef}
                        type="file"
                      />

                      <div className="flex flex-wrap gap-3">
                        <Button
                          onClick={() => fileInputRef.current?.click()}
                          type="button"
                          variant="secondary"
                        >
                          <ImagePlus aria-hidden="true" className="size-4" />
                          {uploadFile ? "Đổi ảnh khác" : "Chọn ảnh từ thiết bị"}
                        </Button>
                        {uploadFile ? (
                          <Button
                            onClick={() => void handleStartUpload()}
                            type="button"
                          >
                            <Sparkles aria-hidden="true" className="size-4" />
                            Phân tích tranh & Bắt đầu
                          </Button>
                        ) : null}
                      </div>

                      {uploadFile ? (
                        <p className="text-sm font-bold text-primary">
                          Đã chọn: {uploadFile.name}
                        </p>
                      ) : null}
                      {uploadError ? (
                        <StatusMessage tone="error">{uploadError}</StatusMessage>
                      ) : null}
                    </div>

                    <div className="flex min-h-[240px] items-center justify-center overflow-hidden rounded-card border border-border bg-white p-3">
                      {uploadPreviewUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          alt="Ảnh xem trước của bé"
                          className="max-h-72 w-full rounded-control object-contain"
                          src={uploadPreviewUrl}
                        />
                      ) : (
                        <p className="text-center text-sm font-semibold text-muted">
                          Ảnh ba mẹ và bé chọn sẽ hiện xem trước ở đây.
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}

                {activeTab === "BOOK_PAGE" ? (
                  catalogState.catalog.book_pages.length > 0 ? (
                    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                      {catalogState.catalog.book_pages.map((page) => (
                        <article
                          className="flex flex-col overflow-hidden rounded-card border border-border bg-white shadow-sm"
                          key={page.page_id}
                        >
                          <div className="relative aspect-[4/3] w-full overflow-hidden bg-sky/30">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              alt={`${page.book_title} - Trang ${page.page_number}`}
                              className="h-full w-full object-cover"
                              src={page.image_url}
                            />
                          </div>
                          <div className="flex flex-1 flex-col justify-between gap-3 p-4">
                            <div>
                              <h2 className="line-clamp-1 text-base font-extrabold text-ink">
                                {page.book_title}
                              </h2>
                              <p className="text-sm font-semibold text-muted">
                                Trang {page.page_number}
                              </p>
                            </div>
                            <Button
                              onClick={() => void handleStartBookPage(page)}
                              type="button"
                            >
                              Mô tả trang này
                            </Button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <EmptyState
                      description="Hiện chưa có trang sách có tranh cho khối lớp này. Bé hãy thử chọn Tranh chủ đề ViRead hoặc Tải ảnh từ máy nhé!"
                      title="Chưa có trang sách phù hợp"
                    />
                  )
                ) : null}
              </div>
            )}
          </div>

          {catalogState.status === "ready" && catalogState.sessions.length > 0 ? (
            <section className="rounded-card border border-border bg-white p-5 shadow-sm sm:p-7">
              <h2 className="flex items-center gap-2 text-lg font-extrabold text-ink">
                <History aria-hidden="true" className="size-5 text-primary" />
                Những bức tranh bé đã kể gần đây
              </h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {catalogState.sessions.map((item) => (
                  <button
                    className="flex items-center gap-3 rounded-control border border-border bg-white p-3 text-left transition-colors hover:border-primary hover:bg-sky/20 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    key={item.session_id}
                    onClick={() => void handleResumeSession(item.session_id)}
                    type="button"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      alt={item.scene_title}
                      className="size-16 shrink-0 rounded-control object-cover"
                      src={item.image_url}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-extrabold text-ink">
                        {item.scene_title}
                      </p>
                      <p className="text-xs font-semibold text-muted">
                        {sourceLabel(item.source_type)} • {item.attempts_count}{" "}
                        lượt kể
                      </p>
                      <div className="mt-1 flex items-center gap-2">
                        {renderStars(item.best_stars)}
                        {item.best_score > 0 ? (
                          <span className="text-xs font-extrabold text-primary">
                            {item.best_score}/10 điểm
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {session && !isAnalyzing ? (
        <div className="grid items-start gap-6 lg:grid-cols-[1fr_1.15fr]">
          {/* Picture Frame */}
          <div className="flex flex-col gap-4 rounded-card border border-border bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="rounded-full bg-sky px-3 py-1 text-xs font-extrabold text-primary">
                  {sourceLabel(session.source_type)} • Lớp {session.child_grade}
                </span>
                <h2 className="mt-2 text-xl font-extrabold text-ink">
                  {session.scene_title}
                </h2>
              </div>
              <div className="flex flex-col items-end gap-1">
                {renderStars(session.best_stars)}
                <span className="text-xs font-bold text-muted">
                  Đã kể {session.attempts_count} lượt
                </span>
              </div>
            </div>

            <div className="overflow-hidden rounded-control border border-border bg-sky/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={session.scene_title}
                className="max-h-[420px] w-full object-contain"
                src={session.image_url}
              />
            </div>

            <p className="rounded-control bg-sky/30 px-4 py-3 text-sm font-semibold text-ink">
              {session.guide.scene_summary}
            </p>
          </div>

          {/* Interactive Guiding + Recording + Evaluation Column */}
          <div className="flex flex-col gap-5">
            {/* Guiding Questions & Vocabulary */}
            <section className="rounded-card border border-border bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="flex items-center gap-2 text-lg font-extrabold text-ink">
                  <Lightbulb
                    aria-hidden="true"
                    className="size-5 text-[#E5A913]"
                  />
                  Gợi ý quan sát cho bé
                </h2>
                <Button
                  onClick={() =>
                    void speakVietnamese(
                      `${session.scene_title}. ${session.guide.guiding_questions.join(" ")}`,
                      "guide",
                    )
                  }
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  {playingSpeechKey === "guide" ? (
                    <>
                      <VolumeX aria-hidden="true" className="size-4" />
                      Dừng đọc
                    </>
                  ) : (
                    <>
                      <Volume2 aria-hidden="true" className="size-4" />
                      Nghe gợi ý
                    </>
                  )}
                </Button>
              </div>

              <ol className="mt-3 flex flex-col gap-2">
                {session.guide.guiding_questions.map((question, index) => (
                  <li
                    className="flex items-start gap-2 rounded-control bg-sky/30 px-3 py-2 text-sm font-bold text-ink"
                    key={question}
                  >
                    <span className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-extrabold text-white">
                      {index + 1}
                    </span>
                    <span>{question}</span>
                  </li>
                ))}
              </ol>

              <div className="mt-4">
                <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                  Từ vựng gợi ý (nhấn vào từ để nghe)
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {session.guide.suggested_vocabulary.map((item) => {
                    const active = selectedVocabWord === item.word;
                    return (
                      <button
                        className={
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-extrabold transition-colors focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary " +
                          (active
                            ? "border-primary bg-primary text-white"
                            : "border-border bg-white text-ink hover:border-primary hover:bg-sky/30")
                        }
                        key={item.word}
                        onClick={() => {
                          setSelectedVocabWord(item.word);
                          void speakVietnamese(item.word, `vocab:${item.word}`);
                        }}
                        type="button"
                      >
                        <Volume2 aria-hidden="true" className="size-3.5" />
                        {item.word}
                      </button>
                    );
                  })}
                </div>
                {selectedVocabWord ? (
                  <p className="mt-2 rounded-control bg-warning-surface/60 px-3 py-2 text-sm font-semibold text-ink">
                    <strong>{selectedVocabWord}:</strong>{" "}
                    {
                      session.guide.suggested_vocabulary.find(
                        (item) => item.word === selectedVocabWord,
                      )?.hint
                    }
                  </p>
                ) : null}
              </div>

              <div className="mt-4 border-t border-border pt-3">
                <button
                  className="inline-flex items-center gap-2 text-sm font-extrabold text-primary hover:underline"
                  onClick={() => setShowSampleSentences((value) => !value)}
                  type="button"
                >
                  {showSampleSentences ? (
                    <>
                      <EyeOff aria-hidden="true" className="size-4" />
                      Ẩn câu mẫu tham khảo
                    </>
                  ) : (
                    <>
                      <Eye aria-hidden="true" className="size-4" />
                      Xem câu mẫu tham khảo
                    </>
                  )}
                </button>
                {showSampleSentences ? (
                  <ul className="mt-2 flex flex-col gap-2">
                    {session.guide.model_sample_sentences.map((sentence) => (
                      <li
                        className="rounded-control bg-success-surface/50 px-3 py-2 text-sm font-semibold text-success-ink"
                        key={sentence}
                      >
                        “{sentence}”
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </section>

            {/* Child Input Area (Mic OR Text) */}
            <section className="rounded-card border border-border bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-extrabold text-ink">
                  Phần mô tả của bé
                </h2>
                <div className="flex items-center gap-2">
                  {!isRecordingVoice ? (
                    <Button
                      disabled={isTranscribing || isEvaluating}
                      onClick={() => void startVoiceRecording()}
                      size="compact"
                      type="button"
                      variant="secondary"
                    >
                      <Mic aria-hidden="true" className="size-4" />
                      Nói bằng Micro
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void stopVoiceRecording()}
                      size="compact"
                      type="button"
                      variant="destructive"
                    >
                      <Square aria-hidden="true" className="size-4" />
                      Dừng ghi âm
                    </Button>
                  )}
                </div>
              </div>

              {voiceMessage ? (
                <div className="mt-3">
                  <StatusMessage
                    tone={isRecordingVoice ? "warning" : "info"}
                  >
                    {voiceMessage}
                  </StatusMessage>
                </div>
              ) : null}

              <label className="mt-3 block" htmlFor="picture-description-input">
                <span className="sr-only">Nội dung bé mô tả bức tranh</span>
                <textarea
                  className="min-h-32 w-full rounded-control border border-border bg-white p-3.5 text-base font-medium text-ink focus:border-primary focus:outline-none"
                  id="picture-description-input"
                  maxLength={2000}
                  onChange={(event) => {
                    setDescriptionText(event.target.value);
                    if (inputMode !== "VOICE") setInputMode("TEXT");
                  }}
                  placeholder="Bé hãy nói qua Micro hoặc viết 1–3 câu kể lại những gì bé nhìn thấy trong bức tranh nhé..."
                  value={descriptionText}
                />
              </label>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs font-semibold text-muted">
                  {descriptionText.trim().length}/2000 ký tự
                </span>
                <Button
                  disabled={
                    isEvaluating || isRecordingVoice || isTranscribing || !descriptionText.trim()
                  }
                  onClick={() => void handleEvaluate()}
                  type="button"
                >
                  <Send aria-hidden="true" className="size-4" />
                  {isEvaluating
                    ? "Cô giáo AI đang chấm bài..."
                    : "Gửi cô giáo AI chấm bài"}
                </Button>
              </div>
            </section>

            {/* Gemini Feedback Card */}
            {activeAttempt ? (
              <section
                aria-live="polite"
                className="rounded-card border-2 border-primary/25 bg-white p-5 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
                  <div className="flex items-center gap-3">
                    {renderStars(activeAttempt.stars)}
                    <span className="rounded-full bg-success-surface px-3 py-1 text-sm font-extrabold text-success-ink">
                      {activeAttempt.score_out_of_10}/10 điểm
                    </span>
                    <span className="text-xs font-bold text-muted">
                      Lượt #{activeAttempt.attempt_number}
                    </span>
                  </div>
                  <Button
                    onClick={() =>
                      void speakVietnamese(
                        `${activeAttempt.feedback.praise_message} ${activeAttempt.feedback.improvement_tip}`,
                        `feedback:${activeAttempt.attempt_id}`,
                      )
                    }
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    {playingSpeechKey === `feedback:${activeAttempt.attempt_id}` ? (
                      <>
                        <VolumeX aria-hidden="true" className="size-4" />
                        Dừng nghe
                      </>
                    ) : (
                      <>
                        <Volume2 aria-hidden="true" className="size-4" />
                        Nghe nhận xét
                      </>
                    )}
                  </Button>
                </div>

                <p className="mt-4 rounded-control bg-warning-surface/50 px-4 py-3 text-base font-extrabold text-ink">
                  {activeAttempt.feedback.praise_message}
                </p>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div className="rounded-control bg-success-surface/40 p-3.5">
                    <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-success-ink">
                      <CheckCircle2 aria-hidden="true" className="size-4" />
                      Chi tiết bé kể đúng
                    </h3>
                    <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink">
                      {activeAttempt.feedback.matched_details.map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded-control bg-sky/40 p-3.5">
                    <h3 className="flex items-center gap-1.5 text-sm font-extrabold text-primary">
                      <Lightbulb aria-hidden="true" className="size-4" />
                      Chi tiết bé có thể kể thêm
                    </h3>
                    <ul className="mt-2 flex flex-col gap-1.5 text-sm text-ink">
                      {activeAttempt.feedback.missed_details.map((item) => (
                        <li key={item}>• {item}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-4 rounded-control border border-border p-3.5">
                  <p className="text-sm font-bold text-ink">
                    Mẹo cho lượt kể sau:{" "}
                    <span className="font-semibold text-muted">
                      {activeAttempt.feedback.improvement_tip}
                    </span>
                  </p>
                  {activeAttempt.feedback.upgraded_sentences.length > 0 ? (
                    <div className="mt-3">
                      <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                        Gợi ý câu diễn đạt hay hơn cho bé
                      </p>
                      <ul className="mt-1.5 flex flex-col gap-1.5">
                        {activeAttempt.feedback.upgraded_sentences.map(
                          (sentence) => (
                            <li
                              className="rounded-control bg-sky/25 px-3 py-2 text-sm font-bold text-ink"
                              key={sentence}
                            >
                              “{sentence}”
                            </li>
                          ),
                        )}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
