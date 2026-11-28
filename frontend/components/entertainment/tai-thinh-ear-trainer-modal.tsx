"use client";

import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Ear,
  Mic,
  RefreshCw,
  Sparkles,
  Square,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n } from "@/hooks/use-i18n";
import { useSpeechPlayer, type SpeechPlayer } from "@/hooks/use-speech-player";
import {
  useSpeechRecorder,
  type SpeechRecorder,
} from "@/hooks/use-speech-recorder";
import {
  defaultRegionalPhoneticService,
  type EarTrainer30sDTO,
  type EarTrainerCompleteDTO,
  type MinimalPairRoundDTO,
  type RegionalPhoneticService,
} from "@/lib/api/regional-phonetics-service";
import {
  createSpeechService,
  type SpeechService,
} from "@/lib/api/speech-service";
import { cn } from "@/lib/utils/cn";
import { useRegionalDialectTranslations } from "@/messages/features/regional_dialect";

type RoundPhase = "TAI_THINH" | "MIENG_XINH";

export interface TaiThinhEarTrainerModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly childId: string;
  readonly childAlias?: string | null;
  readonly service?: RegionalPhoneticService;
  readonly speechPlayer?: Pick<SpeechPlayer, "isPlaying" | "play" | "stop">;
  readonly speechRecorder?: Pick<
    SpeechRecorder,
    "isRecording" | "start" | "stop" | "cancel"
  >;
  readonly speechService?: Pick<SpeechService, "transcribe">;
  readonly onCompleted?: (summary: EarTrainerCompleteDTO) => void;
}

export function TaiThinhEarTrainerModal({
  isOpen,
  onClose,
  childId,
  childAlias,
  service = defaultRegionalPhoneticService,
  speechPlayer: injectedPlayer,
  speechRecorder: injectedRecorder,
  speechService: injectedSpeechService,
  onCompleted,
}: TaiThinhEarTrainerModalProps) {
  const t = useRegionalDialectTranslations();
  const { locale } = useI18n();

  const defaultPlayer = useSpeechPlayer();
  const defaultRecorder = useSpeechRecorder();
  const defaultSpeechApi = useMemo(() => createSpeechService(), []);

  const player = injectedPlayer ?? defaultPlayer;
  const recorder = injectedRecorder ?? defaultRecorder;
  const speechApi = injectedSpeechService ?? defaultSpeechApi;

  const [drill, setDrill] = useState<EarTrainer30sDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);

  const [roundIndex, setRoundIndex] = useState(0);
  const [phase, setPhase] = useState<RoundPhase>("TAI_THINH");
  const [pickedOption, setPickedOption] = useState<string | null>(null);
  const [correctRounds, setCorrectRounds] = useState(0);
  const [usedVoiceEcho, setUsedVoiceEcho] = useState(false);
  const [isRecordingEcho, setIsRecordingEcho] = useState(false);
  const [isTranscribingEcho, setIsTranscribingEcho] = useState(false);
  const [echoFeedback, setEchoFeedback] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(30);
  const [completionSummary, setCompletionSummary] =
    useState<EarTrainerCompleteDTO | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);

  const loadSeqRef = useRef(0);
  const playerRef = useRef(player);
  const recorderRef = useRef(recorder);

  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  useEffect(() => {
    recorderRef.current = recorder;
  }, [recorder]);

  const stopActiveMedia = useCallback(() => {
    try {
      playerRef.current.stop();
    } catch {
      // Ignore cleanup errors
    }
    try {
      recorderRef.current.cancel();
    } catch {
      // Ignore cleanup errors
    }
    setIsRecordingEcho(false);
    setIsTranscribingEcho(false);
  }, []);

  const playTargetSample = useCallback((round: MinimalPairRoundDTO) => {
    void playerRef.current
      .play(round.tts_text, {
        coaching: true,
        cacheScope: "COACHING",
      })
      .catch(() => {
        // Autoplay or offline TTS failures stay calm; child can replay anytime
      });
  }, []);

  // Load 30s drill whenever modal opens or user clicks Play Again
  useEffect(() => {
    if (!isOpen || !childId) {
      return;
    }

    const seq = ++loadSeqRef.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setLoadError(false);
    setDrill(null);
    setCompletionSummary(null);
    setRoundIndex(0);
    setPhase("TAI_THINH");
    setPickedOption(null);
    setCorrectRounds(0);
    setUsedVoiceEcho(false);
    setEchoFeedback(null);

    void service
      .getEarTrainer(childId)
      .then((res) => {
        if (loadSeqRef.current !== seq) return;
        setDrill(res);
        setSecondsLeft(res.duration_seconds || 30);
        setLoading(false);
        if (res.rounds[0]) {
          playTargetSample(res.rounds[0]);
        }
      })
      .catch(() => {
        if (loadSeqRef.current !== seq) return;
        setLoading(false);
        setLoadError(true);
      });

    return () => {
      stopActiveMedia();
    };
  }, [
    childId,
    isOpen,
    playTargetSample,
    reloadCounter,
    service,
    stopActiveMedia,
  ]);

  // Calm 30s countdown timer (never aborts or penalizes when hitting 0)
  useEffect(() => {
    if (!isOpen || !drill || completionSummary || secondsLeft <= 0) {
      return;
    }
    const timer = setInterval(() => {
      setSecondsLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [completionSummary, drill, isOpen, secondsLeft]);

  const currentRound: MinimalPairRoundDTO | null =
    drill && drill.rounds[roundIndex] ? drill.rounds[roundIndex] : null;

  const roundOptions = useMemo(() => {
    if (!currentRound) return [];
    if (currentRound.options && currentRound.options.length >= 2) {
      return currentRound.options.slice(0, 2);
    }
    return [currentRound.target_word, currentRound.distractor_word];
  }, [currentRound]);

  async function finalizeDrill(
    finalCorrect: number,
    finalVoiceUsed: boolean,
    activeDrill: EarTrainer30sDTO,
  ) {
    setIsCompleting(true);
    stopActiveMedia();
    const totalRounds = Math.max(1, activeDrill.rounds.length);
    const practicedWords = activeDrill.rounds.map((r) => r.target_word);

    try {
      const summary = await service.completeEarTrainer(childId, {
        rounds_attempted: totalRounds,
        rounds_correct: finalCorrect,
        phase_b_spoken: finalVoiceUsed,
        practiced_words: practicedWords,
      });
      setCompletionSummary(summary);
      onCompleted?.(summary);
    } catch {
      // Deterministic calm fallback summary if network drops on completion
      const fallback: EarTrainerCompleteDTO = {
        child_id: childId,
        phonetic_profile: activeDrill.phonetic_profile,
        rounds_attempted: totalRounds,
        rounds_correct: finalCorrect,
        accuracy: Number((finalCorrect / totalRounds).toFixed(4)),
        phase_b_spoken: finalVoiceUsed,
        completion_mode: finalVoiceUsed ? "VOICE_ECHO" : "CALM_TAP",
        xp_earned: finalCorrect * 10 + (finalVoiceUsed ? 5 : 0),
        message_vi:
          "Tuyệt vời! Bé đã hoàn thành lượt luyện Tai Thính Miệng Xinh!",
        message_en: "Great job completing the Ear-Before-Voice drill!",
        visibility: "PARENT_PRIVATE",
      };
      setCompletionSummary(fallback);
      onCompleted?.(fallback);
    } finally {
      setIsCompleting(false);
    }
  }

  function handleSelectCard(word: string) {
    if (!currentRound || phase !== "TAI_THINH") return;
    const isCorrect = word === currentRound.target_word;
    setPickedOption(word);
    if (isCorrect) {
      setCorrectRounds((prev) => prev + 1);
    }
    setEchoFeedback(null);
    setPhase("MIENG_XINH");
  }

  async function handleAdvanceFromPhaseB(voiceUsedNow = false) {
    if (!drill) return;
    stopActiveMedia();
    const nextVoiceUsed = usedVoiceEcho || voiceUsedNow;
    if (voiceUsedNow) {
      setUsedVoiceEcho(true);
    }

    const nextIdx = roundIndex + 1;
    if (nextIdx < drill.rounds.length) {
      setRoundIndex(nextIdx);
      setPhase("TAI_THINH");
      setPickedOption(null);
      setEchoFeedback(null);
      const nextRound = drill.rounds[nextIdx];
      if (nextRound) {
        playTargetSample(nextRound);
      }
      return;
    }

    await finalizeDrill(correctRounds, nextVoiceUsed, drill);
  }

  async function handleToggleEchoSpeak() {
    if (!currentRound || isTranscribingEcho) return;

    if (!isRecordingEcho) {
      setEchoFeedback(null);
      try {
        player.stop();
        await recorder.start({ mode: "short-word" });
        setIsRecordingEcho(true);
      } catch {
        // No mic available — record calm fallback message so child is never blocked
        setEchoFeedback(t("earTrainerEchoFallbackFeedback"));
      }
      return;
    }

    setIsRecordingEcho(false);
    setIsTranscribingEcho(true);
    try {
      const blob = await recorder.stop();
      if (blob && blob.size > 0) {
        const transcript = await speechApi.transcribe(blob, {
          keyterms: currentRound.contrastive_keyterms,
          source: "tai_thinh_ear_trainer",
        });
        const cleanText = transcript.text.trim();
        setUsedVoiceEcho(true);
        setEchoFeedback(
          cleanText
            ? t("earTrainerEchoFeedback", { transcript: cleanText })
            : t("earTrainerEchoFallbackFeedback"),
        );
      } else {
        setEchoFeedback(t("earTrainerEchoFallbackFeedback"));
      }
    } catch {
      setEchoFeedback(t("earTrainerEchoFallbackFeedback"));
    } finally {
      setIsTranscribingEcho(false);
    }
  }

  function handleCloseModal() {
    stopActiveMedia();
    onClose();
  }

  const isLastRound =
    drill !== null && roundIndex >= Math.max(0, drill.rounds.length - 1);

  return (
    <Modal
      closeOnBackdropClick={false}
      isOpen={isOpen}
      onClose={handleCloseModal}
      title={t("earTrainerTitle")}
    >
      <div
        className="flex flex-col gap-4"
        data-testid="tai-thinh-ear-trainer-modal"
      >
        <p className="text-sm leading-relaxed text-muted">
          {childAlias ? `${childAlias} · ` : ""}
          {t("earTrainerSubtitle")}
        </p>

        {loading ? (
          <div
            className="flex items-center justify-center rounded-2xl border border-border bg-white p-8 text-sm font-bold text-muted"
            data-testid="ear-trainer-loading"
          >
            {t("earTrainerLoading")}
          </div>
        ) : loadError ? (
          <div className="space-y-3">
            <StatusMessage tone="error">{t("earTrainerError")}</StatusMessage>
            <Button
              data-testid="ear-trainer-retry-btn"
              fullWidth={false}
              onClick={() => setReloadCounter((c) => c + 1)}
              size="compact"
              type="button"
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {t("earTrainerRetry")}
            </Button>
          </div>
        ) : completionSummary ? (
          <div
            className="space-y-4 rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50/90 via-white to-amber-50/80 p-5"
            data-testid="ear-trainer-complete-summary"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-xs font-extrabold text-white">
                <CheckCircle2 aria-hidden="true" className="size-3.5" />
                {t("earTrainerCompleteTitle")}
              </span>
              <span
                className="rounded-full bg-white px-3 py-1 text-xs font-bold text-emerald-900"
                data-testid="ear-trainer-completion-mode-badge"
              >
                {completionSummary.completion_mode === "VOICE_ECHO"
                  ? t("earTrainerModeVoiceBadge")
                  : t("earTrainerModeCalmBadge")}
              </span>
            </div>

            <p
              className="text-2xl font-extrabold text-ink"
              data-testid="ear-trainer-final-score"
            >
              {t("earTrainerScore", {
                correct: completionSummary.rounds_correct,
                total: completionSummary.rounds_attempted,
              })}
            </p>

            <p className="text-sm leading-relaxed text-ink">
              {locale === "en"
                ? completionSummary.message_en
                : completionSummary.message_vi}
            </p>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              <Button
                className="min-h-12"
                data-testid="ear-trainer-play-again-btn"
                fullWidth={false}
                onClick={() => setReloadCounter((c) => c + 1)}
                size="compact"
                type="button"
                variant="secondary"
              >
                <Sparkles aria-hidden="true" className="size-4 text-primary" />
                {t("earTrainerPlayAgain")}
              </Button>
              <Button
                className="min-h-12"
                data-testid="ear-trainer-close-btn"
                fullWidth={false}
                onClick={handleCloseModal}
                size="compact"
                type="button"
              >
                {t("earTrainerClose")}
              </Button>
            </div>
          </div>
        ) : drill && currentRound ? (
          <div className="space-y-4">
            {/* Header Bar: Round Counter + Calm 30s Timer + Phonics Category */}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="rounded-full bg-primary/12 px-3 py-1 text-xs font-extrabold text-primary"
                  data-testid="ear-trainer-round-indicator"
                >
                  {t("earTrainerRound", {
                    current: roundIndex + 1,
                    total: drill.rounds.length,
                  })}
                </span>
                <span
                  className="viread-learning-content rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900"
                  dir="ltr"
                  lang="vi"
                >
                  {currentRound.phonics_category_label_vi}
                </span>
              </div>

              <span
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-white px-3 py-1 text-xs font-bold text-muted"
                data-testid="ear-trainer-countdown"
              >
                <Clock aria-hidden="true" className="size-3.5 text-primary" />
                {secondsLeft > 0
                  ? t("earTrainerTimeLeft", { seconds: secondsLeft })
                  : t("earTrainerTimeGentleDone")}
              </span>
            </div>

            {/* Phase A: Tai Thính (100% STT-free Minimal-Pair Card Tap) */}
            <div
              className="space-y-3 rounded-2xl border border-sky-200 bg-sky-50/55 p-4"
              data-testid="ear-trainer-phase-a"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="inline-flex items-center gap-1.5 text-xs font-extrabold tracking-wide text-sky-900 uppercase">
                    <Ear aria-hidden="true" className="size-3.5" />
                    {t("earTrainerPhaseALabel")}
                  </p>
                  <p className="mt-0.5 text-sm text-ink">
                    {t("earTrainerPhaseAInstruction")}
                  </p>
                </div>

                <Button
                  className="min-h-11"
                  data-testid="ear-trainer-listen-btn"
                  fullWidth={false}
                  onClick={() => playTargetSample(currentRound)}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  <Volume2 aria-hidden="true" className="size-4 text-primary" />
                  {player.isPlaying
                    ? t("earTrainerListening")
                    : t("earTrainerListenBtn")}
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-1">
                {roundOptions.map((optionWord) => {
                  const isPicked = pickedOption === optionWord;
                  const isTarget = optionWord === currentRound.target_word;
                  const revealed = phase === "MIENG_XINH";
                  return (
                    <button
                      aria-label={t("earTrainerCardAria", { word: optionWord })}
                      className={cn(
                        "flex min-h-24 cursor-pointer flex-col items-center justify-center rounded-2xl border-2 p-4 text-center transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                        !revealed &&
                          "border-sky-200 bg-white hover:border-primary hover:bg-amber-50/50",
                        revealed &&
                          isTarget &&
                          "border-emerald-500 bg-emerald-50 text-emerald-950",
                        revealed &&
                          isPicked &&
                          !isTarget &&
                          "border-amber-400 bg-amber-50 text-amber-950",
                        revealed &&
                          !isTarget &&
                          !isPicked &&
                          "border-border bg-white/70 opacity-75",
                      )}
                      data-testid={`ear-trainer-option-${optionWord}`}
                      disabled={revealed}
                      key={optionWord}
                      onClick={() => handleSelectCard(optionWord)}
                      type="button"
                    >
                      <span
                        className="viread-learning-content text-2xl font-extrabold sm:text-3xl"
                        dir="ltr"
                        lang="vi"
                      >
                        {optionWord}
                      </span>
                    </button>
                  );
                })}
              </div>

              {pickedOption ? (
                <p
                  className={cn(
                    "rounded-xl px-3 py-2 text-sm font-bold",
                    pickedOption === currentRound.target_word
                      ? "bg-emerald-100/90 text-emerald-950"
                      : "bg-amber-100/90 text-amber-950",
                  )}
                  data-testid="ear-trainer-phase-a-feedback"
                >
                  {pickedOption === currentRound.target_word
                    ? t("earTrainerCorrect", { word: currentRound.target_word })
                    : t("earTrainerGentleRetry", {
                        word: currentRound.target_word,
                      })}
                </p>
              ) : null}
            </div>

            {/* Phase B: Miệng Xinh (Optional Quick Spoken Echo OR Calm No-Mic Completion) */}
            {phase === "MIENG_XINH" ? (
              <div
                className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/60 p-4"
                data-testid="ear-trainer-phase-b"
              >
                <div>
                  <p className="inline-flex items-center gap-1.5 text-xs font-extrabold tracking-wide text-amber-900 uppercase">
                    <Mic aria-hidden="true" className="size-3.5" />
                    {t("earTrainerPhaseBLabel")}
                  </p>
                  <p className="mt-0.5 text-sm text-ink">
                    {t("earTrainerPhaseBInstruction", {
                      word: currentRound.target_word,
                    })}
                  </p>
                </div>

                {echoFeedback ? (
                  <p
                    className="rounded-xl bg-white px-3 py-2 text-xs font-bold text-emerald-900"
                    data-testid="ear-trainer-echo-feedback"
                  >
                    {echoFeedback}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    className="min-h-12"
                    data-testid="ear-trainer-echo-btn"
                    disabled={isTranscribingEcho || isCompleting}
                    fullWidth={false}
                    onClick={() => void handleToggleEchoSpeak()}
                    size="compact"
                    type="button"
                    variant="secondary"
                  >
                    {isRecordingEcho ? (
                      <>
                        <Square
                          aria-hidden="true"
                          className="size-4 text-rose-600"
                        />
                        {t("earTrainerStopSpeakBtn")}
                      </>
                    ) : (
                      <>
                        <Mic
                          aria-hidden="true"
                          className="size-4 text-primary"
                        />
                        {isTranscribingEcho
                          ? t("earTrainerTranscribing")
                          : t("earTrainerSpeakBtn", {
                              word: currentRound.target_word,
                            })}
                      </>
                    )}
                  </Button>

                  <Button
                    className="min-h-12"
                    data-testid="ear-trainer-calm-next-btn"
                    disabled={
                      isRecordingEcho || isTranscribingEcho || isCompleting
                    }
                    fullWidth={false}
                    isLoading={isCompleting}
                    onClick={() => void handleAdvanceFromPhaseB(false)}
                    size="compact"
                    type="button"
                  >
                    {isLastRound
                      ? t("earTrainerCalmFinishBtn")
                      : t("earTrainerCalmNextBtn")}
                    <ArrowRight
                      aria-hidden="true"
                      className="viread-rtl-flip size-4"
                    />
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
