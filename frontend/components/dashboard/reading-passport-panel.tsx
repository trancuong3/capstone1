"use client";

import { Award, Flame, Heart, Mic, Play, Square, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import {
  createFamilyPedagogyService,
  type ParentEncouragementNoteDTO,
  type ReadingPassportDTO,
} from "@/lib/api/family-pedagogy-service";

interface ReadingPassportPanelProps {
  readonly childId: string;
  readonly childAlias: string;
  readonly allowParentRecording?: boolean;
  readonly collapsible?: boolean;
  readonly defaultExpanded?: boolean;
}

export function ReadingPassportPanel({
  childId,
  childAlias,
  allowParentRecording = true,
  collapsible = false,
  defaultExpanded = true,
}: ReadingPassportPanelProps) {
  const t = useTranslations("parent");
  const tCommon = useTranslations("common");
  const service = useMemo(() => createFamilyPedagogyService(), []);
  const [isExpanded, setIsExpanded] = useState(
    collapsible ? defaultExpanded : true,
  );

  const [loadedState, setLoadedState] = useState<{
    readonly childId: string;
    readonly passport: ReadingPassportDTO | null;
    readonly note: ParentEncouragementNoteDTO | null;
  } | null>(null);
  const [noteOverride, setNoteOverride] = useState<{
    readonly childId: string;
    readonly value: ParentEncouragementNoteDTO | null;
  } | null>(null);
  const isLoading = loadedState?.childId !== childId;
  const passport =
    loadedState?.childId === childId ? loadedState.passport : null;
  const note =
    noteOverride?.childId === childId
      ? noteOverride.value
      : loadedState?.childId === childId
        ? loadedState.note
        : null;
  const [isUploading, setIsUploading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isPlayingNote, setIsPlayingNote] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordStartMsRef = useRef<number>(0);
  const recordStopTimerRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  const loadProgress = useAiProgress({
    active: isLoading,
    expectedDurationMs: 3_000,
    resetKey: childId,
  });

  const uploadProgress = useAiProgress({
    active: isUploading,
    expectedDurationMs: 3_500,
    resetKey: isUploading ? 1 : 0,
  });

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setIsPlayingNote(false);
  }, []);

  useEffect(() => {
    if (!isExpanded || loadedState?.childId === childId) return;
    let active = true;
    Promise.all([
      service.getReadingPassport(childId).catch(() => null),
      service.getEncouragementNote(childId).catch(() => null),
    ]).then(([passportRes, noteRes]) => {
      if (!active) return;
      setLoadedState({
        childId,
        passport: passportRes,
        note: noteRes,
      });
    });
    return () => {
      active = false;
      cleanupAudio();
      if (recordStopTimerRef.current !== null) {
        window.clearTimeout(recordStopTimerRef.current);
      }
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
  }, [childId, cleanupAudio, isExpanded, loadedState?.childId, service]);

  const handlePlayNote = useCallback(async () => {
    if (!note) return;
    if (isPlayingNote) {
      cleanupAudio();
      return;
    }
    setRecordError(null);
    try {
      const blob = await service.fetchEncouragementAudioBlob(note);
      cleanupAudio();
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;
      setIsPlayingNote(true);
      audio.onended = () => cleanupAudio();
      audio.onerror = () => cleanupAudio();
      await audio.play();
    } catch {
      cleanupAudio();
      setRecordError(t("passport.encouragementPlayError"));
    }
  }, [cleanupAudio, isPlayingNote, note, service, t]);

  const stopRecording = useCallback(() => {
    if (recordStopTimerRef.current !== null) {
      window.clearTimeout(recordStopTimerRef.current);
      recordStopTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  }, []);

  const startRecording = useCallback(async () => {
    setRecordError(null);
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    ) {
      setRecordError(t("passport.micUnsupported"));
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const preferredTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ];
      const mimeType = preferredTypes.find((candidate) =>
        MediaRecorder.isTypeSupported(candidate),
      );
      const recorder = mimeType
        ? new MediaRecorder(stream, {
            mimeType,
            audioBitsPerSecond: 32_000,
          })
        : new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recordStartMsRef.current = Date.now();
      recorderRef.current = recorder;

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunks.push(ev.data);
        }
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        setIsRecording(false);
        const durationMs = Math.min(
          10_000,
          Math.max(500, Date.now() - recordStartMsRef.current),
        );
        const blob = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm",
        });
        if (blob.size <= 0 || blob.size > 262_144) {
          setRecordError(t("passport.clipTooLarge"));
          return;
        }
        setIsUploading(true);
        service
          .uploadEncouragementNote(childId, {
            blob,
            durationMs,
            title: t("passport.defaultEncouragementTitle", {
              alias: childAlias,
            }),
          })
          .then((saved) => {
            setNoteOverride({ childId, value: saved });
          })
          .catch(() => {
            setRecordError(t("passport.uploadFailed"));
          })
          .finally(() => {
            setIsUploading(false);
          });
      };

      recorder.start();
      setIsRecording(true);
      // Auto-stop at 9.5s to stay safely under 10s / 256 KB!
      recordStopTimerRef.current = window.setTimeout(() => {
        stopRecording();
      }, 9_500);
    } catch {
      setRecordError(t("passport.micDenied"));
    }
  }, [childAlias, childId, service, stopRecording, t]);

  const handleDeleteNote = useCallback(async () => {
    if (!note) return;
    cleanupAudio();
    try {
      await service.deleteEncouragementNote(childId, note.id);
      setNoteOverride({ childId, value: null });
    } catch {
      setRecordError(t("passport.uploadFailed"));
    }
  }, [childId, cleanupAudio, note, service, t]);

  if (collapsible && !isExpanded) {
    return (
      <div className="flex justify-center">
        <Button
          data-testid="open-reading-passport-btn"
          onClick={() => setIsExpanded(true)}
          size="compact"
          type="button"
          variant="secondary"
        >
          <Award aria-hidden="true" className="size-4 text-primary" />
          {t("passport.passportTabLabel")}
        </Button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="mt-3 rounded-control border border-border bg-white/90 p-4">
        <AiProgressBar
          active
          elapsedSeconds={loadProgress.elapsedSeconds}
          label={loadProgress.stageLabel ?? tCommon("aiProgress.analyzing")}
          percent={loadProgress.percent}
          size="sm"
          testId="reading-passport-loading-progress"
        />
      </div>
    );
  }

  return (
    <div
      className="mt-3 space-y-3 rounded-control border border-primary/20 bg-white/95 p-4"
      data-testid="reading-passport-panel"
    >
      {passport ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex items-center gap-2 text-sm font-extrabold text-ink">
              <Award aria-hidden="true" className="size-4 text-primary" />
              <span>
                {t("passport.stampsSummary", {
                  unlocked: passport.unlocked_stamps_count,
                  total: passport.total_stamps_count,
                })}
              </span>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-extrabold text-amber-800">
              <Flame aria-hidden="true" className="size-3.5 text-amber-600" />
              {t("passport.streakBadge", { days: passport.streak_days })}
            </span>
          </div>

          <p
            className="viread-learning-content text-xs leading-relaxed text-muted"
            dir="ltr"
            lang="vi"
          >
            {passport.gentle_message_vi}
          </p>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {passport.stamps.map((stamp) => (
              <div
                className={`rounded-control border p-2.5 text-xs ${
                  stamp.unlocked
                    ? "border-emerald-300 bg-emerald-50/60 text-ink"
                    : "border-border bg-canvas/60 text-muted"
                }`}
                key={stamp.stamp_key}
              >
                <div className="flex items-center justify-between gap-2">
                  <strong
                    className="viread-learning-content font-extrabold text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    {stamp.unlocked ? "★ " : "○ "}
                    {stamp.title_vi}
                  </strong>
                  <span className="font-bold tabular-nums">
                    {stamp.progress_current}/{stamp.progress_target}
                  </span>
                </div>
                <p
                  className="viread-learning-content mt-0.5 text-[11px] leading-snug"
                  dir="ltr"
                  lang="vi"
                >
                  {stamp.description_vi}
                </p>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="space-y-2 border-t border-border/70 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-extrabold text-ink">
            <Heart aria-hidden="true" className="size-3.5 text-rose-500" />
            {t("passport.encouragementTitle")}
          </span>

          <div className="flex flex-wrap items-center gap-1.5">
            {note ? (
              <>
                <Button
                  data-testid="play-parent-encouragement-btn"
                  onClick={() => void handlePlayNote()}
                  size="compact"
                  type="button"
                  variant="secondary"
                >
                  {isPlayingNote ? (
                    <>
                      <Square aria-hidden="true" className="size-3.5" />
                      {t("passport.stopEncouragement")}
                    </>
                  ) : (
                    <>
                      <Play aria-hidden="true" className="size-3.5" />
                      {t("passport.playEncouragement")}
                    </>
                  )}
                </Button>
                {allowParentRecording ? (
                  <Button
                    aria-label={t("passport.deleteEncouragement")}
                    onClick={() => void handleDeleteNote()}
                    size="compact"
                    type="button"
                    variant="quiet"
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                  </Button>
                ) : null}
              </>
            ) : null}

            {allowParentRecording ? (
              <Button
                data-testid="record-parent-encouragement-btn"
                disabled={isUploading}
                onClick={() =>
                  isRecording ? stopRecording() : void startRecording()
                }
                size="compact"
                type="button"
                variant={isRecording ? "secondary" : "primary"}
              >
                {isRecording ? (
                  <>
                    <Square aria-hidden="true" className="size-3.5" />
                    {t("passport.stopRecordButton")}
                  </>
                ) : (
                  <>
                    <Mic aria-hidden="true" className="size-3.5" />
                    {t("passport.recordButton")}
                  </>
                )}
              </Button>
            ) : null}
          </div>
        </div>

        <p className="text-[11px] text-muted">
          {t("passport.encouragementPrivacyHint")}
        </p>

        {isUploading ? (
          <AiProgressBar
            active
            label={tCommon("aiProgress.uploading")}
            percent={uploadProgress.percent}
            size="compact"
            testId="parent-encouragement-upload-progress"
          />
        ) : null}

        {recordError ? (
          <p className="text-xs font-semibold text-danger" role="alert">
            {recordError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
