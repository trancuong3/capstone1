"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { karaokeInputClass } from "@/components/admin/karaoke/song-metadata-form";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminKaraoke } from "@/components/karaoke/karaoke-services-provider";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import { karaokeErrorMessage } from "@/lib/api/admin-karaoke-service";
import {
  createKaraokeSimpleImportService,
  type FlaggedLyricLine,
  type KaraokeSimpleImportService,
  type SimpleAudioType,
  type SimpleImportResult,
  type SimplePipelineLifecycleState,
  type SimpleProcessingStatus,
} from "@/lib/api/karaoke-simple-import-service";
import { isServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";
import {
  classifyAudioFile,
  cleanFilenameToTitle,
  type AudioClassificationResult,
} from "@/lib/karaoke/audio-type-classifier";
import { importLyrics } from "@/lib/karaoke/lyrics-import";
import {
  formatKaraokeTime,
  formatLyricTimestamp,
  timingIssues,
} from "@/lib/karaoke/lyrics-timeline";
import {
  canonicalLyricText,
  syllableIssues,
} from "@/lib/karaoke/syllable-timing";
import type {
  AdminKaraokeDetail,
  KaraokeLine,
  KaraokeLyrics,
  KaraokePreview,
  KaraokeSyllable,
} from "@/types/karaoke";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const PIPELINE_POLL_INTERVAL_MS = 3000;

const SIMPLE_JOB_STAGE_PCT: Record<string, number> = {
  QUEUED: 8,
  VALIDATING_INPUT: 20,
  PREPARING_AUDIO: 45,
  ALIGNING_LYRICS: 75,
  VALIDATING_RESULT: 92,
  COMPLETE: 100,
};

const SIMPLE_LIFECYCLE_PCT: Record<SimplePipelineLifecycleState, number> = {
  UPLOADED: 8,
  QUEUED: 10,
  SEPARATING_AUDIO: 32,
  TRANSCRIBING_LYRICS: 54,
  ALIGNING_LYRICS: 74,
  ANALYZING_RHYTHM: 86,
  ANALYZING_MELODY: 92,
  READY_FOR_REVIEW: 100,
  NEEDS_REVIEW: 100,
  FAILED: 0,
};

const ACTIVE_PIPELINE_STATES = new Set<SimplePipelineLifecycleState>([
  "QUEUED",
  "SEPARATING_AUDIO",
  "TRANSCRIBING_LYRICS",
  "ALIGNING_LYRICS",
  "ANALYZING_RHYTHM",
  "ANALYZING_MELODY",
]);

function buildProportionalSyllables(
  text: string,
  startMs: number,
  endMs: number,
): KaraokeSyllable[] | null {
  const normalized = canonicalLyricText(text);
  if (!normalized) return null;
  const tokens = normalized.split(" ");
  const count = tokens.length;
  const span = endMs - startMs;
  if (count === 0 || count > 150 || span < count) return null;

  const weights = tokens.map((tok) => Math.max(1, Array.from(tok).length));
  const totalWeight = weights.reduce((acc, value) => acc + value, 0);
  const extra = span - count;
  const durations = weights.map(
    (weight) => 1 + Math.floor((extra * weight) / totalWeight),
  );
  let remainder = span - durations.reduce((acc, value) => acc + value, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % count, remainder--) {
    durations[i] += 1;
  }

  let cursor = startMs;
  return tokens.map((token, idx) => {
    const start = cursor;
    const end = cursor + durations[idx];
    cursor = end;
    return {
      id: crypto.randomUUID(),
      text: token,
      start_ms: start,
      end_ms: end,
    };
  });
}

function distributePlainTextToLyrics(
  rawText: string,
  durationMs: number,
): { lyrics: KaraokeLyrics; flagged: FlaggedLyricLine[] } {
  const cleanedLines = rawText
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .split("\n")
    .map((line) =>
      line
        .replace(/\p{Cc}/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300),
    )
    .filter(Boolean)
    .slice(0, 300);

  if (!cleanedLines.length || durationMs < cleanedLines.length) {
    return {
      lyrics: { format_version: 1, lines: [] },
      flagged: [],
    };
  }

  const tokenCounts = cleanedLines.map((line) =>
    Math.max(1, canonicalLyricText(line).split(" ").length),
  );
  const totalTokens = tokenCounts.reduce((acc, value) => acc + value, 0);
  let useV2 =
    durationMs >= totalTokens &&
    totalTokens <= 10000 &&
    tokenCounts.every((count) => count <= 150);

  const baseSpans = useV2 ? tokenCounts : cleanedLines.map(() => 1);
  const extra = durationMs - baseSpans.reduce((acc, value) => acc + value, 0);
  const weights = cleanedLines.map((line) => Math.max(1, line.length));
  const totalWeight = weights.reduce((acc, value) => acc + value, 0);
  const spans = baseSpans.map(
    (base, idx) => base + Math.floor((extra * weights[idx]) / totalWeight),
  );
  let remainder = durationMs - spans.reduce((acc, value) => acc + value, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % spans.length, remainder--) {
    spans[i] += 1;
  }

  let cursor = 0;
  const lines: KaraokeLine[] = [];
  const flagged: FlaggedLyricLine[] = [];
  const estimatedReason = translateRuntime(
    "admin.karaoke.simpleUpload.estimatedTimingReason",
  );
  for (let idx = 0; idx < cleanedLines.length; idx++) {
    const text = cleanedLines[idx];
    const startMs = cursor;
    const endMs = cursor + spans[idx];
    cursor = endMs;
    const id = crypto.randomUUID();
    const syllables = useV2
      ? buildProportionalSyllables(text, startMs, endMs)
      : null;
    if (useV2 && !syllables) {
      useV2 = false;
    }
    lines.push({
      id,
      text,
      start_ms: startMs,
      end_ms: endMs,
      ...(useV2 && syllables ? { syllables } : {}),
    });
    flagged.push({
      line_id: id,
      line_index: idx,
      text,
      flag: "NEEDS_TIMING_CHECK",
      reason: estimatedReason,
    });
  }

  if (!useV2) {
    return {
      lyrics: {
        format_version: 1,
        lines: lines.map(({ id, text, start_ms, end_ms }) => ({
          id,
          text,
          start_ms,
          end_ms,
        })),
      },
      flagged,
    };
  }
  return {
    lyrics: { format_version: 2, lines },
    flagged,
  };
}

function applyTapStartsToLyrics(
  current: KaraokeLyrics,
  tappedStarts: number[],
  durationMs: number,
): KaraokeLyrics {
  const count = current.lines.length;
  if (!count || tappedStarts.length !== count || durationMs < count) {
    return current;
  }
  const starts = tappedStarts.map((value) =>
    Math.max(0, Math.min(durationMs - 1, Math.round(value))),
  );
  for (let i = 1; i < count; i++) {
    if (starts[i] <= starts[i - 1]) {
      starts[i] = starts[i - 1] + 1;
    }
  }
  if (starts[count - 1] >= durationMs) {
    starts[count - 1] = durationMs - 1;
    for (let i = count - 2; i >= 0; i--) {
      if (starts[i] >= starts[i + 1]) {
        starts[i] = Math.max(0, starts[i + 1] - 1);
      }
    }
  }

  let canV2 = current.format_version === 2;
  const nextLines: KaraokeLine[] = current.lines.map((line, idx) => {
    const startMs = starts[idx];
    const endMs =
      idx + 1 < count
        ? Math.max(startMs + 1, starts[idx + 1])
        : Math.max(startMs + 1, durationMs);
    const syllables = canV2
      ? buildProportionalSyllables(line.text, startMs, endMs)
      : null;
    if (canV2 && !syllables) canV2 = false;
    return {
      id: line.id,
      text: line.text,
      start_ms: startMs,
      end_ms: Math.min(durationMs, endMs),
      ...(canV2 && syllables ? { syllables } : {}),
    };
  });

  if (!canV2) {
    return {
      format_version: 1,
      lines: nextLines.map(({ id, text, start_ms, end_ms }) => ({
        id,
        text,
        start_ms,
        end_ms,
      })),
    };
  }
  return { format_version: 2, lines: nextLines };
}

function mapQualityFlagsToFlaggedLines(
  status: SimpleProcessingStatus,
  lines: KaraokeLine[],
  reasonFallback: (messageKey: string) => string,
): FlaggedLyricLine[] {
  const seen = new Set<string>();
  const mapped: FlaggedLyricLine[] = [];
  for (const qFlag of status.quality_flags) {
    if (!qFlag.line_id || seen.has(qFlag.line_id)) continue;
    const idx = lines.findIndex((line) => line.id === qFlag.line_id);
    if (idx < 0) continue;
    seen.add(qFlag.line_id);
    const flagType =
      qFlag.message_key === "LYRIC_MISMATCH"
        ? "NEEDS_REVIEW"
        : "NEEDS_TIMING_CHECK";
    mapped.push({
      line_id: qFlag.line_id,
      line_index: idx,
      text: lines[idx].text,
      flag: flagType,
      reason: reasonFallback(qFlag.message_key),
    });
  }
  return mapped;
}

export function KaraokeSimpleUploadScreen({
  simpleService,
  classifier = classifyAudioFile,
  onSwitchAdvanced,
  onSwitchWizard,
}: {
  simpleService?: KaraokeSimpleImportService;
  classifier?: (file: File) => Promise<AudioClassificationResult>;
  onSwitchAdvanced?: (songId?: string) => void;
  onSwitchWizard?: () => void;
}) {
  const t = useTranslations("admin");
  const adminService = useAdminKaraoke();
  const importService = useMemo(
    () => simpleService ?? createKaraokeSimpleImportService(),
    [simpleService],
  );

  const defaultSourceNote = t("karaoke.simpleUpload.defaultSourceNote");
  const defaultUsageNote = t("karaoke.simpleUpload.defaultUsageNote");

  // Step 1 state (MP3 selection + instant client classification)
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const localAudioUrl = useMemo(() => {
    if (
      !selectedFile ||
      typeof URL === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      return null;
    }
    return URL.createObjectURL(selectedFile);
  }, [selectedFile]);
  const [dragActive, setDragActive] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [classification, setClassification] =
    useState<AudioClassificationResult | null>(null);
  const [audioTypeOverride, setAudioTypeOverride] = useState<
    SimpleAudioType | "AUTO"
  >("AUTO");
  const [step1Title, setStep1Title] = useState("");
  const [step1TitleDirty, setStep1TitleDirty] = useState(false);
  const [step1Author, setStep1Author] = useState("");
  const [step1MinGrade, setStep1MinGrade] = useState(1);
  const [step1MaxGrade, setStep1MaxGrade] = useState(5);
  const [step1LyricsText, setStep1LyricsText] = useState("");
  const [autoTranscribe, setAutoTranscribe] = useState(true);
  const [enableBackgroundProcessing, setEnableBackgroundProcessing] =
    useState(true);

  // Import & Review (Steps 2–3) state
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<SimpleImportResult | null>(null);
  const [preview, setPreview] = useState<KaraokePreview | null>(null);
  const [lyrics, setLyrics] = useState<KaraokeLyrics>({
    format_version: 1,
    lines: [],
  });
  const [flaggedLines, setFlaggedLines] = useState<FlaggedLyricLine[]>([]);
  const [inlineLyricsInput, setInlineLyricsInput] = useState("");

  // Optional background pipeline state
  const [processingStatus, setProcessingStatus] =
    useState<SimpleProcessingStatus | null>(null);
  const [processingBusy, setProcessingBusy] = useState(false);
  const [processingReviewConfirmed, setProcessingReviewConfirmed] =
    useState(false);

  // Tap-to-sync mini-mode
  const [tapSyncActive, setTapSyncActive] = useState(false);
  const [tapIndex, setTapIndex] = useState(0);
  const [tapStarts, setTapStarts] = useState<number[]>([]);

  // Step 3 editable metadata & UNCHECKED-by-default safety compliance checkboxes
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [minGrade, setMinGrade] = useState(1);
  const [maxGrade, setMaxGrade] = useState(5);
  const [sourceNote, setSourceNote] = useState(defaultSourceNote);
  const [usageNote, setUsageNote] = useState(defaultUsageNote);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [childSafeConfirmed, setChildSafeConfirmed] = useState(false);

  // Publish & messages
  const [publishing, setPublishing] = useState(false);
  const [publishedDetail, setPublishedDetail] =
    useState<AdminKaraokeDetail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tapRegionRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const pipelineRequestRef = useRef<AbortController | null>(null);
  const classifyRunId = useRef(0);

  useEffect(() => {
    return () => {
      requestRef.current?.abort();
      pipelineRequestRef.current?.abort();
    };
  }, []);

  // Pause preview / tap-sync audio when Android app or browser tab goes to background.
  useEffect(() => {
    function pauseAudioOnHide() {
      audioRef.current?.pause?.();
    }
    function onVisibilityChange() {
      if (document.hidden) pauseAudioOnHide();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("viread:android-background", pauseAudioOnHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener(
        "viread:android-background",
        pauseAudioOnHide,
      );
    };
  }, []);

  useEffect(() => {
    if (!localAudioUrl) return;
    return () => {
      try {
        URL.revokeObjectURL(localAudioUrl);
      } catch {
        // Ignore already-revoked object URLs.
      }
    };
  }, [localAudioUrl]);

  const effectiveAudioType: SimpleAudioType =
    audioTypeOverride === "AUTO"
      ? (classification?.audioType ?? "UNKNOWN")
      : audioTypeOverride;

  const effectiveLifecycle: SimplePipelineLifecycleState =
    processingStatus?.lifecycle_state ??
    imported?.lifecycle_state ??
    "UPLOADED";
  const effectiveWorkerOnline =
    processingStatus?.worker_online ?? imported?.worker_online ?? false;
  const effectiveBpm = processingStatus?.bpm ?? imported?.bpm ?? null;
  const isPipelineRunning = ACTIVE_PIPELINE_STATES.has(effectiveLifecycle);
  const tCommon = useTranslations("common");
  const backendPipelinePct = (
    processingStatus as { progress_pct?: number | null } | null
  )?.progress_pct;
  const hasBackendPipelinePct =
    typeof backendPipelinePct === "number" &&
    Number.isFinite(backendPipelinePct);
  const pipelineBasePct = hasBackendPipelinePct
    ? backendPipelinePct
    : processingStatus?.job_stage &&
        SIMPLE_JOB_STAGE_PCT[processingStatus.job_stage] !== undefined
      ? SIMPLE_JOB_STAGE_PCT[processingStatus.job_stage]
      : (SIMPLE_LIFECYCLE_PCT[effectiveLifecycle] ?? 10);
  const importProgress = useAiProgress({
    active: importing,
    expectedDurationMs: 18_000,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.uploading") },
      { atPct: 28, label: tCommon("aiProgress.processingKaraoke") },
      { atPct: 62, label: tCommon("aiProgress.transcribing") },
      { atPct: 86, label: tCommon("aiProgress.finalizing") },
    ],
  });
  const pipelineProgress = useAiProgress({
    active: isPipelineRunning || processingBusy,
    realPercent: isPipelineRunning ? pipelineBasePct : null,
    progressMode: hasBackendPipelinePct ? "measured" : "staged",
    expectedDurationMs: 25_000,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 30, label: tCommon("aiProgress.processingKaraoke") },
      { atPct: 80, label: tCommon("aiProgress.finalizing") },
    ],
  });

  const loadDraftPreview = useCallback(
    (
      songId: string,
      revision: number,
      versionId: string,
      signal?: AbortSignal,
    ) => {
      adminService
        .preview(songId, revision, versionId, signal)
        .then((loadedPreview) => {
          if (!signal?.aborted) setPreview(loadedPreview);
        })
        .catch(() => {
          // Local blob preview remains usable if preview fetch is unavailable.
        });
    },
    [adminService],
  );

  // Poll background processing cleanly only while an asynchronous job is active.
  useEffect(() => {
    const songId = imported?.song_id;
    const getStatus = importService.getSimpleProcessingStatus;
    if (!songId || publishedDetail || typeof getStatus !== "function") return;
    const shouldPoll =
      processingStatus !== null
        ? ACTIVE_PIPELINE_STATES.has(processingStatus.lifecycle_state)
        : Boolean(imported.processing_queued);
    if (!shouldPoll) return;

    let stopped = false;
    let activeController: AbortController | null = null;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    async function pollOnce() {
      if (stopped || !songId || typeof getStatus !== "function") return;
      if (typeof document !== "undefined" && document.hidden) {
        scheduleNext();
        return;
      }
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      try {
        const nextStatus = await getStatus(songId, controller.signal);
        if (stopped || controller.signal.aborted) return;
        setProcessingStatus(nextStatus);
        if (ACTIVE_PIPELINE_STATES.has(nextStatus.lifecycle_state)) {
          scheduleNext();
        }
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        if (
          isServiceError(err) &&
          (err.status === 401 || err.status === 403 || err.status === 404)
        ) {
          stopped = true;
          return;
        }
        scheduleNext();
      }
    }

    function scheduleNext() {
      if (stopped) return;
      if (timerId !== null) clearTimeout(timerId);
      timerId = setTimeout(() => {
        void pollOnce();
      }, PIPELINE_POLL_INTERVAL_MS);
    }

    function handleVisible() {
      if (typeof document !== "undefined" && !document.hidden && !stopped) {
        if (timerId !== null) clearTimeout(timerId);
        void pollOnce();
      }
    }

    scheduleNext();
    document.addEventListener("visibilitychange", handleVisible);
    return () => {
      stopped = true;
      if (timerId !== null) clearTimeout(timerId);
      activeController?.abort();
      document.removeEventListener("visibilitychange", handleVisible);
    };
  }, [
    importService,
    imported?.song_id,
    imported?.processing_queued,
    processingStatus,
    publishedDetail,
  ]);

  async function handleFileSelection(file: File | null) {
    setError("");
    setNotice("");
    if (!file) return;
    if (!/\.mp3$/i.test(file.name)) {
      setError(t("karaoke.simpleUpload.errors.mp3Only"));
      return;
    }
    if (file.size <= 0) {
      setError(t("karaoke.simpleUpload.errors.emptyFile"));
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      setError(t("karaoke.simpleUpload.errors.maxAudioSize"));
      return;
    }

    setSelectedFile(file);
    if (!step1TitleDirty) {
      setStep1Title(cleanFilenameToTitle(file.name));
    }

    const runId = ++classifyRunId.current;
    setClassifying(true);
    setClassification(null);
    try {
      const result = await classifier(file);
      if (classifyRunId.current === runId) {
        setClassification(result);
        if (result.audioType === "INSTRUMENTAL_ONLY") {
          setAutoTranscribe(false);
        } else if (result.audioType === "VOCAL_FULL") {
          setAutoTranscribe(true);
        }
      }
    } finally {
      if (classifyRunId.current === runId) {
        setClassifying(false);
      }
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files?.[0] ?? null;
    void handleFileSelection(file);
  }

  async function handleOptionalLyricsFile(
    file: File | null,
    target: "step1" | "step2",
  ) {
    if (!file) return;
    setError("");
    if (file.size > 256 * 1024) {
      setError(t("karaoke.simpleUpload.errors.lyricsFileTooLarge"));
      return;
    }
    try {
      const text = await file.text();
      if (target === "step1") {
        setStep1LyricsText(text);
      } else {
        setInlineLyricsInput(text);
      }
    } catch {
      setError(t("karaoke.simpleUpload.errors.lyricsFileUnreadable"));
    }
  }

  async function handleAutoCreate() {
    if (!selectedFile || importing) return;
    if (step1MinGrade > step1MaxGrade) {
      setError(t("karaoke.simpleUpload.errors.invalidGradeRange"));
      return;
    }
    requestRef.current?.abort();
    pipelineRequestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setImporting(true);
    setError("");
    setNotice("");

    try {
      const result = await importService.simpleImport(
        {
          audio: selectedFile,
          title: step1Title.trim() || undefined,
          author: step1Author.trim() || undefined,
          min_grade: step1MinGrade,
          max_grade: step1MaxGrade,
          lyrics_text: step1LyricsText.trim() || undefined,
          audio_type: effectiveAudioType,
          bpm: classification?.estimatedBpm ?? null,
          auto_transcribe:
            effectiveAudioType === "INSTRUMENTAL_ONLY" ? false : autoTranscribe,
          enable_background_processing: enableBackgroundProcessing,
          rights_confirmed: false,
          child_safe_confirmed: false,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;

      setImported(result);
      setProcessingStatus(null);
      setProcessingReviewConfirmed(false);
      const draft = result.song.draft;
      setLyrics(draft?.lyrics ?? { format_version: 1, lines: [] });
      setFlaggedLines(result.flagged_lines);
      setTitle(result.title);
      setAuthor(result.author);
      setMinGrade(draft?.min_grade ?? step1MinGrade);
      setMaxGrade(draft?.max_grade ?? step1MaxGrade);
      setSourceNote(draft?.source_note?.trim() || defaultSourceNote);
      setUsageNote(draft?.usage_note?.trim() || defaultUsageNote);
      // Always start UNCHECKED so admin makes an explicit safety & rights confirmation.
      setRightsConfirmed(false);
      setChildSafeConfirmed(false);
      setPublishedDetail(null);
      setTapSyncActive(false);
      setTapIndex(0);
      setTapStarts([]);
      setNotice(result.guidance_vi);

      loadDraftPreview(
        result.song_id,
        result.revision,
        result.version_id,
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(karaokeErrorMessage(err));
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setImporting(false);
    }
  }

  async function handleStartBackgroundProcessing() {
    if (
      !imported ||
      processingBusy ||
      typeof importService.startSimpleProcessing !== "function"
    ) {
      return;
    }
    pipelineRequestRef.current?.abort();
    const controller = new AbortController();
    pipelineRequestRef.current = controller;
    setProcessingBusy(true);
    setError("");

    try {
      const draftId = imported.song.draft?.id ?? imported.version_id;
      const status = await importService.startSimpleProcessing(
        imported.song_id,
        {
          expected_revision: imported.revision,
          draft_version_id: draftId,
          idempotency_key: crypto.randomUUID(),
          audio_type: imported.audio_type,
          bpm: effectiveBpm,
          lyrics: lyrics.lines.length > 0 ? lyrics : undefined,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setProcessingStatus(status);
      setNotice(status.guidance_vi);
    } catch (err) {
      if (!controller.signal.aborted) {
        if (isServiceError(err) && err.status === 503) {
          setNotice(t("karaoke.simpleUpload.workerOfflineFallbackNotice"));
        } else {
          setError(karaokeErrorMessage(err));
        }
      }
    } finally {
      if (pipelineRequestRef.current === controller) {
        pipelineRequestRef.current = null;
      }
      if (!controller.signal.aborted) setProcessingBusy(false);
    }
  }

  async function handleApplyProcessingResult() {
    if (
      !imported ||
      !processingStatus?.can_apply ||
      !processingStatus.job_id ||
      processingBusy ||
      typeof importService.applySimpleProcessing !== "function"
    ) {
      return;
    }
    pipelineRequestRef.current?.abort();
    const controller = new AbortController();
    pipelineRequestRef.current = controller;
    setProcessingBusy(true);
    setError("");

    try {
      const draftId =
        processingStatus.draft_version_id ??
        imported.song.draft?.id ??
        imported.version_id;
      const applied = await importService.applySimpleProcessing(
        imported.song_id,
        {
          expected_revision: processingStatus.revision,
          draft_version_id: draftId,
          job_id: processingStatus.job_id,
          audio_type: imported.audio_type,
          bpm: effectiveBpm,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;

      const updatedDraft = applied.song.draft;
      const updatedLyrics = updatedDraft?.lyrics ?? lyrics;
      const nextVersionId = updatedDraft?.id ?? draftId;
      setProcessingStatus(applied);
      setProcessingReviewConfirmed(Boolean(applied.reviewed));
      setImported((prev) =>
        prev
          ? {
              ...prev,
              revision: applied.revision,
              version_id: nextVersionId,
              bpm: applied.bpm ?? prev.bpm,
              lifecycle_state: applied.lifecycle_state,
              worker_online: applied.worker_online,
              processing_queued: false,
              processing_job_id: applied.job_id ?? prev.processing_job_id,
              lyrics_line_count: updatedLyrics.lines.length,
              song: applied.song,
            }
          : prev,
      );
      if (updatedLyrics.lines.length > 0) {
        setLyrics(updatedLyrics);
        setFlaggedLines(
          mapQualityFlagsToFlaggedLines(applied, updatedLyrics.lines, (key) =>
            t(`karaoke.review.flags.${key}`),
          ),
        );
      }
      setNotice(t("karaoke.simpleUpload.pipelineAppliedNotice"));
      loadDraftPreview(
        applied.song_id,
        applied.revision,
        nextVersionId,
        controller.signal,
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(karaokeErrorMessage(err));
      }
    } finally {
      if (pipelineRequestRef.current === controller) {
        pipelineRequestRef.current = null;
      }
      if (!controller.signal.aborted) setProcessingBusy(false);
    }
  }

  function handleApplyInlineLyrics() {
    if (!imported || !inlineLyricsInput.trim()) return;
    setError("");
    const raw = inlineLyricsInput.trim();
    const looksLikeLrc = /\[\d{1,3}:[0-5]\d/.test(raw);
    if (looksLikeLrc) {
      try {
        const parsed = importLyrics(raw, "lrc", imported.duration_ms);
        const v2Lines: KaraokeLine[] = [];
        let canV2 = true;
        for (const line of parsed.lyrics.lines) {
          if (line.start_ms === null || line.end_ms === null) {
            canV2 = false;
            break;
          }
          const syllables = buildProportionalSyllables(
            line.text,
            line.start_ms,
            line.end_ms,
          );
          if (!syllables) {
            canV2 = false;
            break;
          }
          v2Lines.push({ ...line, syllables });
        }
        const nextLyrics: KaraokeLyrics = canV2
          ? { format_version: 2, lines: v2Lines }
          : parsed.lyrics;
        setLyrics(nextLyrics);
        setFlaggedLines([]);
        setProcessingReviewConfirmed(false);
        setNotice(
          t("karaoke.simpleUpload.lrcAppliedNotice", {
            count: nextLyrics.lines.length,
          }),
        );
        return;
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("karaoke.simpleUpload.errors.lrcFormat"),
        );
        return;
      }
    }

    const distributed = distributePlainTextToLyrics(raw, imported.duration_ms);
    if (!distributed.lyrics.lines.length) {
      setError(t("karaoke.simpleUpload.errors.minOneLyricLine"));
      return;
    }
    setLyrics(distributed.lyrics);
    setFlaggedLines(distributed.flagged);
    setProcessingReviewConfirmed(false);
    setNotice(
      t("karaoke.simpleUpload.plainLyricsAppliedNotice", {
        count: distributed.lyrics.lines.length,
      }),
    );
  }

  function updateLineText(lineId: string, nextTextRaw: string) {
    const cleaned = nextTextRaw.normalize("NFC").replace(/\p{Cc}/gu, "");
    setProcessingReviewConfirmed(false);
    setLyrics((current) => {
      let downgradeToV1 = current.format_version === 1;
      const updatedLines = current.lines.map((line) => {
        if (line.id !== lineId) return line;
        if (!downgradeToV1 && line.start_ms !== null && line.end_ms !== null) {
          const syllables = buildProportionalSyllables(
            cleaned,
            line.start_ms,
            line.end_ms,
          );
          if (syllables) {
            return { ...line, text: cleaned, syllables };
          }
          downgradeToV1 = true;
        }
        return { ...line, text: cleaned };
      });
      if (downgradeToV1) {
        return {
          format_version: 1,
          lines: updatedLines.map(({ id, text, start_ms, end_ms }) => ({
            id,
            text,
            start_ms,
            end_ms,
          })),
        };
      }
      return { format_version: 2, lines: updatedLines };
    });
    setFlaggedLines((items) =>
      items.map((item) =>
        item.line_id === lineId ? { ...item, text: cleaned } : item,
      ),
    );
  }

  function seekAndPlay(ms: number | null) {
    const audio = audioRef.current;
    if (!audio || ms === null) return;
    audio.currentTime = Math.max(0, ms / 1000);
    void Promise.resolve(audio.play?.()).catch(() => {});
  }

  function startTapSync() {
    if (!lyrics.lines.length) return;
    setTapSyncActive(true);
    setTapIndex(0);
    setTapStarts([]);
    setNotice(t("karaoke.simpleUpload.tapSyncStartedNotice"));
    const audio = audioRef.current;
    if (audio) {
      audio.currentTime = 0;
      void Promise.resolve(audio.play?.()).catch(() => {});
    }
    setTimeout(() => tapRegionRef.current?.focus(), 0);
  }

  function recordTap() {
    if (!imported || !tapSyncActive || tapIndex >= lyrics.lines.length) return;
    const rawMs = Math.round((audioRef.current?.currentTime ?? 0) * 1000);
    const prevMs = tapStarts.length > 0 ? tapStarts[tapStarts.length - 1] : -1;
    const stampedMs = Math.min(
      imported.duration_ms - (lyrics.lines.length - tapIndex),
      Math.max(prevMs + 50, rawMs),
    );
    const nextStarts = [...tapStarts, Math.max(0, stampedMs)];
    const nextIdx = tapIndex + 1;

    if (nextIdx >= lyrics.lines.length) {
      const updated = applyTapStartsToLyrics(
        lyrics,
        nextStarts,
        imported.duration_ms,
      );
      setLyrics(updated);
      setProcessingReviewConfirmed(false);
      setFlaggedLines((items) =>
        items.filter((item) => item.flag !== "NEEDS_TIMING_CHECK"),
      );
      setTapSyncActive(false);
      setTapStarts([]);
      setTapIndex(0);
      audioRef.current?.pause?.();
      setNotice(t("karaoke.simpleUpload.tapSyncCompletedNotice"));
    } else {
      setTapStarts(nextStarts);
      setTapIndex(nextIdx);
    }
  }

  function undoTap() {
    if (tapIndex <= 0) return;
    setTapStarts((items) => items.slice(0, -1));
    setTapIndex((idx) => Math.max(0, idx - 1));
  }

  function handleTapRegionKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!tapSyncActive || event.repeat) return;
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input,textarea,select,button")
    ) {
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      recordTap();
    }
  }

  const playbackUrl = preview?.audio_url ?? localAudioUrl;

  const localTimingProblems = useMemo(() => {
    if (!imported) return [];
    const lineProblems = timingIssues(lyrics.lines, imported.duration_ms);
    if (lyrics.format_version === 2) {
      const sylProblems = syllableIssues(
        lyrics.lines,
        imported.duration_ms,
      ).map((item) => item.message);
      return [...lineProblems, ...sylProblems];
    }
    return lineProblems;
  }, [imported, lyrics]);

  const hasEmptyLineText = lyrics.lines.some((line) => !line.text.trim());

  const activeReviewMeta =
    processingStatus?.song.processing_review ??
    imported?.song.processing_review ??
    null;
  const requiresProcessingReview = Boolean(
    (processingStatus?.review_required ?? activeReviewMeta?.required) &&
    !(processingStatus?.reviewed ?? activeReviewMeta?.reviewed),
  );

  const canPublish = Boolean(
    imported &&
    !publishedDetail &&
    !publishing &&
    !processingBusy &&
    !isPipelineRunning &&
    rightsConfirmed &&
    childSafeConfirmed &&
    (!requiresProcessingReview || processingReviewConfirmed) &&
    title.trim() &&
    sourceNote.trim() &&
    usageNote.trim() &&
    minGrade <= maxGrade &&
    lyrics.lines.length > 0 &&
    !hasEmptyLineText &&
    localTimingProblems.length === 0,
  );

  async function handleSimplePublish() {
    if (!imported || !canPublish) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setPublishing(true);
    setError("");
    setNotice("");

    try {
      const draft = imported.song.draft;
      let publishRevision = imported.revision;
      const draftVersionId = draft?.id ?? imported.version_id;
      const trimmedTitle = title.trim();
      const trimmedAuthor = author.trim();
      const trimmedSourceNote = sourceNote.trim();
      const trimmedUsageNote = usageNote.trim();

      if (requiresProcessingReview && draft) {
        const draftChanged =
          draft.title !== trimmedTitle ||
          draft.author !== trimmedAuthor ||
          draft.min_grade !== minGrade ||
          draft.max_grade !== maxGrade ||
          draft.source_note !== trimmedSourceNote ||
          draft.usage_note !== trimmedUsageNote ||
          JSON.stringify(draft.lyrics) !== JSON.stringify(lyrics);

        let reviewedSource = imported.song;
        if (draftChanged) {
          reviewedSource = await adminService.save(
            imported.song_id,
            {
              expected_revision: publishRevision,
              draft_version_id: draftVersionId,
              title: trimmedTitle,
              author: trimmedAuthor,
              min_grade: minGrade,
              max_grade: maxGrade,
              source_note: trimmedSourceNote,
              usage_note: trimmedUsageNote,
              lyrics,
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          publishRevision = reviewedSource.revision;
        }

        const reviewInfo = reviewedSource.processing_review;
        if (reviewInfo?.required && !reviewInfo.reviewed) {
          const fingerprint = reviewInfo.current_content_fingerprint;
          if (!fingerprint) {
            throw new Error(
              t("karaoke.simpleUpload.errors.reviewFingerprintMissing"),
            );
          }
          const confirmed = await adminService.confirmReview(
            imported.song_id,
            {
              expected_revision: publishRevision,
              draft_version_id: draftVersionId,
              content_fingerprint: fingerprint,
              confirmed_listened: true,
              acknowledged_flag_ids: reviewInfo.quality_flags.map((f) => f.id),
            },
            controller.signal,
          );
          if (controller.signal.aborted) return;
          publishRevision = confirmed.revision;
        }

        // Draft changes & review confirmation already committed cleanly above; publish directly.
        const published = await importService.simplePublish(
          imported.song_id,
          {
            expected_revision: publishRevision,
            draft_version_id: draftVersionId,
            rights_confirmed: rightsConfirmed,
            child_safe_confirmed: childSafeConfirmed,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setPublishedDetail(published);
        setNotice(t("karaoke.simpleUpload.publishedNotice"));
        return;
      }

      const published = await importService.simplePublish(
        imported.song_id,
        {
          expected_revision: publishRevision,
          draft_version_id: draftVersionId,
          rights_confirmed: rightsConfirmed,
          child_safe_confirmed: childSafeConfirmed,
          title: trimmedTitle,
          author: trimmedAuthor,
          min_grade: minGrade,
          max_grade: maxGrade,
          source_note: trimmedSourceNote,
          usage_note: trimmedUsageNote,
          lyrics,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPublishedDetail(published);
      setNotice(t("karaoke.simpleUpload.publishedNotice"));
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(karaokeErrorMessage(err));
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setPublishing(false);
    }
  }

  function resetForAnotherSong() {
    pipelineRequestRef.current?.abort();
    setSelectedFile(null);
    setClassification(null);
    setAudioTypeOverride("AUTO");
    setStep1Title("");
    setStep1TitleDirty(false);
    setStep1Author("");
    setStep1MinGrade(1);
    setStep1MaxGrade(5);
    setStep1LyricsText("");
    setAutoTranscribe(true);
    setEnableBackgroundProcessing(true);
    setImported(null);
    setProcessingStatus(null);
    setProcessingBusy(false);
    setProcessingReviewConfirmed(false);
    setPreview(null);
    setLyrics({ format_version: 1, lines: [] });
    setFlaggedLines([]);
    setInlineLyricsInput("");
    setTapSyncActive(false);
    setTapIndex(0);
    setTapStarts([]);
    setSourceNote(defaultSourceNote);
    setUsageNote(defaultUsageNote);
    setRightsConfirmed(false);
    setChildSafeConfirmed(false);
    setPublishedDetail(null);
    setError("");
    setNotice("");
  }

  const currentStep = publishedDetail ? 3 : imported ? 2 : 1;

  return (
    <div className="grid gap-6">
      <AdminPageHeader
        eyebrow={t("karaoke.simpleUpload.eyebrow")}
        title={t("karaoke.simpleUpload.title")}
        description={t("karaoke.simpleUpload.description")}
        actions={
          <div className="flex flex-wrap gap-2">
            {onSwitchAdvanced ? (
              <Button
                variant="secondary"
                size="compact"
                className="sm:w-auto"
                onClick={() => onSwitchAdvanced(imported?.song_id)}
              >
                {t("karaoke.simpleUpload.advancedEditBtn")}
              </Button>
            ) : (
              <ButtonLink
                href={
                  imported
                    ? `/admin/karaoke/${imported.song_id}/edit?mode=advanced`
                    : "/admin/karaoke/new?mode=advanced"
                }
                variant="secondary"
                size="compact"
                className="sm:w-auto"
              >
                {t("karaoke.simpleUpload.advancedEditBtn")}
              </ButtonLink>
            )}
            {onSwitchWizard ? (
              <Button
                variant="quiet"
                size="compact"
                className="sm:w-auto"
                onClick={onSwitchWizard}
              >
                {t("karaoke.simpleUpload.wizardSwitchBtn")}
              </Button>
            ) : null}
            <ButtonLink
              href="/admin/karaoke"
              variant="quiet"
              size="compact"
              className="sm:w-auto"
            >
              {t("karaoke.simpleUpload.backToListBtn")}
            </ButtonLink>
          </div>
        }
      />

      <ol
        aria-label={t("karaoke.simpleUpload.stepsAria")}
        className="grid gap-2 sm:grid-cols-3"
      >
        {[
          { step: 1, label: t("karaoke.simpleUpload.steps.step1") },
          { step: 2, label: t("karaoke.simpleUpload.steps.step2") },
          { step: 3, label: t("karaoke.simpleUpload.steps.step3") },
        ].map(({ step, label }) => {
          const active = currentStep === step;
          const completed = currentStep > step || Boolean(publishedDetail);
          return (
            <li
              key={step}
              aria-current={active ? "step" : undefined}
              className={`rounded-control border px-4 py-3 text-sm font-bold ${
                active
                  ? "border-primary bg-sky text-primary-hover"
                  : completed
                    ? "border-success-surface bg-success-surface text-success-ink"
                    : "border-border bg-white text-muted"
              }`}
            >
              {label}
            </li>
          );
        })}
      </ol>

      {error ? <StatusMessage tone="error">{error}</StatusMessage> : null}
      {notice ? <StatusMessage tone="info">{notice}</StatusMessage> : null}

      {publishedDetail ? (
        <Card className="grid gap-4">
          <StatusMessage
            tone="success"
            title={t("karaoke.simpleUpload.publishedTitle")}
          >
            {t("karaoke.simpleUpload.publishedDescPrefix")}{" "}
            <strong className="viread-learning-content" dir="ltr" lang="vi">
              {publishedDetail.published?.title ?? title}
            </strong>{" "}
            {t("karaoke.simpleUpload.publishedDescSuffix", {
              min: minGrade,
              max: maxGrade,
            })}
          </StatusMessage>
          <div className="flex flex-wrap gap-3">
            <Button className="sm:w-auto" onClick={resetForAnotherSong}>
              {t("karaoke.simpleUpload.addAnotherBtn")}
            </Button>
            <ButtonLink
              href="/admin/karaoke"
              variant="secondary"
              className="sm:w-auto"
            >
              {t("karaoke.simpleUpload.goToListBtn")}
            </ButtonLink>
          </div>
        </Card>
      ) : null}

      {!imported && !publishedDetail ? (
        <Card className="grid gap-5">
          <h2 className="text-xl font-extrabold">
            {t("karaoke.simpleUpload.step1Heading")}
          </h2>

          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            className={`grid gap-3 rounded-card border-2 border-dashed p-6 text-center transition-colors ${
              dragActive
                ? "border-primary bg-sky"
                : "border-border bg-sky/40 hover:border-primary/60"
            }`}
          >
            <p className="text-lg font-bold">
              {selectedFile
                ? t("karaoke.simpleUpload.selectedFile", {
                    name: selectedFile.name,
                  })
                : t("karaoke.simpleUpload.dropzonePrompt")}
            </p>
            <p className="text-sm text-muted">
              {t("karaoke.simpleUpload.dropzoneHint")}
            </p>
            <div className="mx-auto">
              <label className="inline-flex min-h-12 cursor-pointer items-center justify-center rounded-control bg-white px-5 py-2.5 font-bold text-primary-hover shadow-sm ring-1 ring-border hover:bg-sky">
                <span>
                  {selectedFile
                    ? t("karaoke.simpleUpload.chooseOtherMp3Btn")
                    : t("karaoke.simpleUpload.chooseMp3Btn")}
                </span>
                <input
                  aria-label={t("karaoke.simpleUpload.chooseMp3Aria")}
                  type="file"
                  accept=".mp3,audio/mpeg"
                  className="sr-only"
                  onChange={(e) =>
                    void handleFileSelection(e.target.files?.[0] ?? null)
                  }
                />
              </label>
            </div>
          </div>

          {selectedFile ? (
            <div className="grid gap-3 rounded-control border border-border bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="audio-type-badge"
                    className="inline-flex items-center rounded-md bg-sky px-3 py-1 text-sm font-bold text-primary-hover"
                  >
                    {classifying
                      ? t("karaoke.simpleUpload.analyzingAudio")
                      : t(
                          `karaoke.simpleUpload.audioTypes.${effectiveAudioType}`,
                        )}
                  </span>
                  {classification?.estimatedBpm ? (
                    <span className="inline-flex items-center rounded-md bg-success-surface px-2.5 py-1 text-sm font-semibold text-success-ink">
                      ~{classification.estimatedBpm} BPM
                    </span>
                  ) : null}
                </div>
                <label className="flex items-center gap-2 text-sm font-semibold">
                  {t("karaoke.simpleUpload.audioTypeLabel")}
                  <select
                    aria-label={t("karaoke.simpleUpload.audioTypeAria")}
                    className="min-h-10 rounded-control border border-border bg-white px-2.5 py-1 text-sm"
                    value={audioTypeOverride}
                    onChange={(e) => {
                      const next = e.target.value as SimpleAudioType | "AUTO";
                      setAudioTypeOverride(next);
                      if (next === "INSTRUMENTAL_ONLY") {
                        setAutoTranscribe(false);
                      }
                    }}
                  >
                    <option value="AUTO">
                      {t("karaoke.simpleUpload.audioTypes.AUTO")}
                    </option>
                    <option value="VOCAL_FULL">
                      {t("karaoke.simpleUpload.audioTypes.VOCAL_FULL")}
                    </option>
                    <option value="INSTRUMENTAL_ONLY">
                      {t("karaoke.simpleUpload.audioTypes.INSTRUMENTAL_ONLY")}
                    </option>
                  </select>
                </label>
              </div>
              {classification?.guidanceVi ? (
                <p className="text-sm text-muted">
                  {classification.guidanceVi}
                </p>
              ) : null}
              <label className="grid gap-1.5 text-sm font-bold">
                {t("karaoke.simpleUpload.suggestedTitleLabel")}
                <input
                  aria-label={t("karaoke.simpleUpload.suggestedTitleAria")}
                  className={`${karaokeInputClass} viread-learning-content`}
                  dir="ltr"
                  lang="vi"
                  maxLength={200}
                  value={step1Title}
                  placeholder={t(
                    "karaoke.simpleUpload.suggestedTitlePlaceholder",
                  )}
                  onChange={(e) => {
                    setStep1TitleDirty(true);
                    setStep1Title(e.target.value.normalize("NFC"));
                  }}
                />
              </label>
            </div>
          ) : null}

          <details className="rounded-control border border-border bg-white p-4">
            <summary className="cursor-pointer font-bold text-primary-hover">
              {t("karaoke.simpleUpload.step1OptionsSummary")}
            </summary>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="grid gap-1.5 font-bold">
                {t("karaoke.simpleUpload.step1AuthorLabel")}
                <input
                  aria-label={t("karaoke.simpleUpload.step1AuthorAria")}
                  className={`${karaokeInputClass} viread-learning-content`}
                  dir="ltr"
                  lang="vi"
                  maxLength={200}
                  value={step1Author}
                  placeholder={t("karaoke.simpleUpload.step1AuthorPlaceholder")}
                  onChange={(e) =>
                    setStep1Author(e.target.value.normalize("NFC"))
                  }
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1.5 font-bold">
                  {t("karaoke.simpleUpload.minGradeLabel")}
                  <select
                    aria-label={t("karaoke.simpleUpload.step1MinGradeAria")}
                    className={karaokeInputClass}
                    value={step1MinGrade}
                    onChange={(e) => setStep1MinGrade(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((grade) => (
                      <option key={grade} value={grade}>
                        {t("karaoke.simpleUpload.gradeOption", { grade })}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 font-bold">
                  {t("karaoke.simpleUpload.maxGradeLabel")}
                  <select
                    aria-label={t("karaoke.simpleUpload.step1MaxGradeAria")}
                    className={karaokeInputClass}
                    value={step1MaxGrade}
                    onChange={(e) => setStep1MaxGrade(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((grade) => (
                      <option key={grade} value={grade}>
                        {t("karaoke.simpleUpload.gradeOption", { grade })}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-2 md:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="simple-step1-lyrics" className="font-bold">
                    {t("karaoke.simpleUpload.step1LyricsLabel")}
                  </label>
                  <label className="cursor-pointer text-sm font-semibold text-primary-hover underline">
                    {t("karaoke.simpleUpload.uploadLyricsQuickBtn")}
                    <input
                      aria-label={t("karaoke.simpleUpload.step1LyricsFileAria")}
                      type="file"
                      accept=".lrc,.txt,text/plain"
                      className="sr-only"
                      onChange={(e) =>
                        void handleOptionalLyricsFile(
                          e.target.files?.[0] ?? null,
                          "step1",
                        )
                      }
                    />
                  </label>
                </div>
                <textarea
                  id="simple-step1-lyrics"
                  aria-label={t("karaoke.simpleUpload.step1LyricsLabel")}
                  rows={4}
                  className={`${karaokeInputClass} viread-learning-content`}
                  dir="ltr"
                  lang="vi"
                  placeholder={t("karaoke.simpleUpload.step1LyricsPlaceholder")}
                  value={step1LyricsText}
                  onChange={(e) => setStep1LyricsText(e.target.value)}
                />
              </div>
              <label className="flex items-center gap-2 text-sm font-semibold md:col-span-2">
                <input
                  type="checkbox"
                  checked={autoTranscribe}
                  disabled={effectiveAudioType === "INSTRUMENTAL_ONLY"}
                  onChange={(e) => setAutoTranscribe(e.target.checked)}
                />
                {t("karaoke.simpleUpload.autoTranscribeLabel")}
              </label>
              <label className="flex items-center gap-2 text-sm font-semibold md:col-span-2">
                <input
                  type="checkbox"
                  checked={enableBackgroundProcessing}
                  onChange={(e) =>
                    setEnableBackgroundProcessing(e.target.checked)
                  }
                />
                {t("karaoke.simpleUpload.enableBackgroundProcessingLabel")}
              </label>
            </div>
          </details>

          <div className="flex flex-wrap gap-3">
            <Button
              disabled={!selectedFile || importing}
              isLoading={importing}
              className="sm:w-auto"
              onClick={() => void handleAutoCreate()}
            >
              {t("karaoke.simpleUpload.autoCreateBtn")}
            </Button>
          </div>
          {importing ? (
            <AiProgressBar
              active
              elapsedSeconds={importProgress.elapsedSeconds}
              label={
                importProgress.stageLabel ??
                tCommon("aiProgress.processingKaraoke")
              }
              percent={importProgress.percent}
              size="sm"
              testId="karaoke-simple-import-progress"
            />
          ) : null}
        </Card>
      ) : null}

      {imported && !publishedDetail ? (
        <>
          <Card
            aria-label={t("karaoke.simpleUpload.step2Aria")}
            className="grid gap-5"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="grid gap-1">
                <h2 className="text-xl font-extrabold">
                  {t("karaoke.simpleUpload.step2Heading")}
                </h2>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="rounded-md bg-sky px-2.5 py-1 text-sm font-bold text-primary-hover">
                    {t(
                      `karaoke.simpleUpload.audioTypes.${imported.audio_type}`,
                    )}
                  </span>
                  <span className="rounded-md bg-sky px-2.5 py-1 text-sm font-semibold">
                    {t(
                      `karaoke.simpleUpload.lyricsSources.${imported.lyrics_source}`,
                    )}
                  </span>
                  <span className="rounded-md border border-border px-2.5 py-1 text-sm font-semibold tabular-nums">
                    {t("karaoke.simpleUpload.durationBadge", {
                      duration: formatKaraokeTime(imported.duration_ms),
                    })}
                  </span>
                  {imported.has_cover ? (
                    <span className="rounded-md bg-success-surface px-2.5 py-1 text-sm font-semibold text-success-ink">
                      {t("karaoke.simpleUpload.extractedCoverBadge")}
                    </span>
                  ) : null}
                </div>
              </div>
              {preview?.cover_url ? (
                <img
                  src={preview.cover_url}
                  alt={t("karaoke.simpleUpload.coverAlt", { title })}
                  className="size-20 rounded-control border border-border object-cover"
                />
              ) : null}
            </div>

            <div
              data-testid="simple-pipeline-card"
              className="grid gap-3 rounded-control border border-border bg-white p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="simple-pipeline-lifecycle"
                    className="rounded-md bg-sky px-2.5 py-1 text-xs font-extrabold text-primary-hover"
                  >
                    {t(`karaoke.simpleUpload.lifecycle.${effectiveLifecycle}`)}
                  </span>
                  <span className="rounded-md border border-border px-2.5 py-1 text-xs font-semibold text-muted">
                    {effectiveWorkerOnline
                      ? t("karaoke.simpleUpload.workerOnlineBadge")
                      : t("karaoke.simpleUpload.workerOfflineBadge")}
                  </span>
                  {processingStatus?.has_beat_grid ? (
                    <span className="rounded-md bg-success-surface px-2.5 py-1 text-xs font-bold text-success-ink">
                      {t("karaoke.simpleUpload.beatGridReady")}
                      {effectiveBpm ? ` · ${effectiveBpm} BPM` : ""}
                    </span>
                  ) : null}
                  {processingStatus?.has_pitch_contour ? (
                    <span className="rounded-md bg-success-surface px-2.5 py-1 text-xs font-bold text-success-ink">
                      {t("karaoke.simpleUpload.pitchContourReady")}
                    </span>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  {processingStatus?.can_apply && processingStatus.job_id ? (
                    <Button
                      size="compact"
                      className="sm:w-auto"
                      disabled={processingBusy}
                      isLoading={processingBusy}
                      onClick={() => void handleApplyProcessingResult()}
                    >
                      {t("karaoke.simpleUpload.applyPipelineBtn")}
                    </Button>
                  ) : typeof importService.startSimpleProcessing ===
                      "function" &&
                    !isPipelineRunning &&
                    (effectiveWorkerOnline ||
                      effectiveLifecycle === "FAILED") ? (
                    <Button
                      variant="secondary"
                      size="compact"
                      className="sm:w-auto"
                      disabled={processingBusy}
                      isLoading={processingBusy}
                      onClick={() => void handleStartBackgroundProcessing()}
                    >
                      {effectiveLifecycle === "FAILED"
                        ? t("karaoke.simpleUpload.retryPipelineBtn")
                        : t("karaoke.simpleUpload.startPipelineBtn")}
                    </Button>
                  ) : null}
                </div>
              </div>

              {isPipelineRunning || processingBusy ? (
                <AiProgressBar
                  active
                  elapsedSeconds={pipelineProgress.elapsedSeconds}
                  label={
                    isPipelineRunning
                      ? t(
                          `karaoke.simpleUpload.lifecycle.${effectiveLifecycle}`,
                        )
                      : (pipelineProgress.stageLabel ??
                        tCommon("aiProgress.processingKaraoke"))
                  }
                  percent={pipelineProgress.percent}
                  size="sm"
                  testId="karaoke-simple-pipeline-progress"
                />
              ) : null}

              {processingStatus?.safe_error_code ? (
                <p className="text-sm font-semibold text-warning">
                  {t(
                    `karaoke.processing.errorHints.${processingStatus.safe_error_code}`,
                  )}
                </p>
              ) : processingStatus?.guidance_vi ||
                imported.processing_notice ? (
                <p className="text-sm text-muted">
                  {processingStatus?.guidance_vi ?? imported.processing_notice}
                </p>
              ) : null}
            </div>

            {playbackUrl ? (
              <div className="grid gap-2 rounded-control border border-border bg-sky/40 p-3">
                <p className="text-sm font-bold">
                  {t("karaoke.simpleUpload.audioPreviewTitle")}
                </p>
                <audio
                  ref={audioRef}
                  controls
                  src={playbackUrl}
                  className="w-full"
                />
              </div>
            ) : null}

            {lyrics.lines.length === 0 ? (
              <div className="grid gap-3 rounded-control border-2 border-warning bg-warning-surface/40 p-4">
                <p className="font-bold">
                  {t("karaoke.simpleUpload.missingLyricsPrompt")}
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-muted">
                    {t("karaoke.simpleUpload.missingLyricsHint")}
                  </span>
                  <label className="cursor-pointer text-sm font-bold text-primary-hover underline">
                    {t("karaoke.simpleUpload.chooseLyricsFileBtn")}
                    <input
                      aria-label={t(
                        "karaoke.simpleUpload.chooseLyricsFileAria",
                      )}
                      type="file"
                      accept=".lrc,.txt,text/plain"
                      className="sr-only"
                      onChange={(e) =>
                        void handleOptionalLyricsFile(
                          e.target.files?.[0] ?? null,
                          "step2",
                        )
                      }
                    />
                  </label>
                </div>
                <textarea
                  aria-label={t("karaoke.simpleUpload.pasteLyricsAria")}
                  rows={5}
                  className={`${karaokeInputClass} viread-learning-content`}
                  dir="ltr"
                  lang="vi"
                  placeholder={t("karaoke.simpleUpload.pasteLyricsPlaceholder")}
                  value={inlineLyricsInput}
                  onChange={(e) => setInlineLyricsInput(e.target.value)}
                />
                <Button
                  className="sm:w-auto"
                  disabled={!inlineLyricsInput.trim()}
                  onClick={handleApplyInlineLyrics}
                >
                  {t("karaoke.simpleUpload.applyInlineLyricsBtn")}
                </Button>
              </div>
            ) : (
              <div className="grid gap-4">
                {flaggedLines.length > 0 ? (
                  <div
                    aria-label={t("karaoke.simpleUpload.flaggedLinesAria")}
                    className="grid gap-3 rounded-control border border-warning bg-warning-surface/40 p-4"
                  >
                    <p className="font-bold">
                      {t("karaoke.simpleUpload.flaggedLinesTitle", {
                        count: flaggedLines.length,
                      })}
                    </p>
                    <ul className="grid gap-3">
                      {flaggedLines.map((flag) => {
                        const line = lyrics.lines.find(
                          (item) => item.id === flag.line_id,
                        );
                        return (
                          <li
                            key={flag.line_id}
                            className="grid gap-2 rounded-control border border-border bg-white p-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                              <span className="font-bold">
                                {t("karaoke.simpleUpload.flaggedLinePrefix", {
                                  number: flag.line_index + 1,
                                })}{" "}
                                ·{" "}
                                <span className="text-warning">
                                  {flag.flag === "NEEDS_REVIEW"
                                    ? t("karaoke.simpleUpload.flagNeedsReview")
                                    : t(
                                        "karaoke.simpleUpload.flagNeedsTimingCheck",
                                      )}
                                </span>
                              </span>
                              <div className="flex items-center gap-2">
                                <span className="tabular-nums text-muted">
                                  {formatLyricTimestamp(line?.start_ms ?? null)}{" "}
                                  – {formatLyricTimestamp(line?.end_ms ?? null)}
                                </span>
                                {line?.start_ms !== null &&
                                line?.start_ms !== undefined ? (
                                  <Button
                                    variant="quiet"
                                    size="compact"
                                    className="sm:w-auto"
                                    onClick={() => seekAndPlay(line.start_ms)}
                                  >
                                    {t("karaoke.simpleUpload.playSegmentBtn")}
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                            <input
                              aria-label={t(
                                "karaoke.simpleUpload.quickEditLineAria",
                                { number: flag.line_index + 1 },
                              )}
                              className={`${karaokeInputClass} viread-learning-content`}
                              dir="ltr"
                              lang="vi"
                              maxLength={300}
                              value={line?.text ?? flag.text}
                              onChange={(e) =>
                                updateLineText(flag.line_id, e.target.value)
                              }
                            />
                            <p className="text-xs text-muted">{flag.reason}</p>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : (
                  <StatusMessage tone="success">
                    {t("karaoke.simpleUpload.allLinesCleanStatus", {
                      count: lyrics.lines.length,
                    })}
                  </StatusMessage>
                )}

                <div className="grid gap-3 rounded-control border border-border bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-bold">
                        {t("karaoke.simpleUpload.tapSyncTitle")}
                      </p>
                      <p className="text-sm text-muted">
                        {t("karaoke.simpleUpload.tapSyncHint")}
                      </p>
                    </div>
                    {!tapSyncActive ? (
                      <Button
                        variant="secondary"
                        size="compact"
                        className="sm:w-auto"
                        onClick={startTapSync}
                      >
                        {t("karaoke.simpleUpload.startTapSyncBtn")}
                      </Button>
                    ) : (
                      <Button
                        variant="quiet"
                        size="compact"
                        className="sm:w-auto"
                        onClick={() => setTapSyncActive(false)}
                      >
                        {t("karaoke.simpleUpload.closeTapSyncBtn")}
                      </Button>
                    )}
                  </div>

                  {tapSyncActive && lyrics.lines[tapIndex] ? (
                    <div
                      ref={tapRegionRef}
                      tabIndex={0}
                      role="region"
                      aria-label={t("karaoke.simpleUpload.tapSyncRegionAria")}
                      onKeyDown={handleTapRegionKeyDown}
                      className="grid gap-3 rounded-control border-2 border-primary bg-sky p-4 focus-visible:outline-3 focus-visible:outline-primary"
                    >
                      <p className="text-sm font-bold text-primary-hover">
                        {t("karaoke.simpleUpload.tapSyncProgress", {
                          current: tapIndex + 1,
                          total: lyrics.lines.length,
                        })}
                      </p>
                      <p
                        className="viread-learning-content text-xl font-extrabold"
                        dir="ltr"
                        lang="vi"
                      >
                        “{lyrics.lines[tapIndex].text}”
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button className="sm:w-auto" onClick={recordTap}>
                          {t("karaoke.simpleUpload.tapNextLineBtn")}
                        </Button>
                        <Button
                          variant="secondary"
                          className="sm:w-auto"
                          disabled={tapIndex === 0}
                          onClick={undoTap}
                        >
                          {t("karaoke.simpleUpload.undoTapBtn")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <details className="rounded-control border border-border bg-white p-3">
                  <summary className="cursor-pointer text-sm font-bold text-primary-hover">
                    {t("karaoke.simpleUpload.editAllLyricsSummary", {
                      count: lyrics.lines.length,
                    })}
                  </summary>
                  <ul className="mt-3 grid gap-2">
                    {lyrics.lines.map((line, idx) => (
                      <li
                        key={line.id}
                        className="grid gap-1 sm:grid-cols-[120px_1fr] sm:items-center"
                      >
                        <span className="text-xs font-semibold tabular-nums text-muted">
                          #{idx + 1} · {formatLyricTimestamp(line.start_ms)}
                        </span>
                        <input
                          aria-label={t("karaoke.simpleUpload.lineTextAria", {
                            number: idx + 1,
                          })}
                          className={`${karaokeInputClass} viread-learning-content`}
                          dir="ltr"
                          lang="vi"
                          maxLength={300}
                          value={line.text}
                          onChange={(e) =>
                            updateLineText(line.id, e.target.value)
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </Card>

          <Card
            aria-label={t("karaoke.simpleUpload.step3Aria")}
            className="grid gap-5"
          >
            <h2 className="text-xl font-extrabold">
              {t("karaoke.simpleUpload.step3Heading")}
            </h2>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-1.5 font-bold">
                {t("karaoke.simpleUpload.songTitleLabel")}
                <input
                  aria-label={t("karaoke.simpleUpload.songTitleLabel")}
                  className={`${karaokeInputClass} viread-learning-content`}
                  dir="ltr"
                  lang="vi"
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value.normalize("NFC"))}
                />
              </label>
              <label className="grid gap-1.5 font-bold">
                {t("karaoke.simpleUpload.songAuthorLabel")}
                <input
                  aria-label={t("karaoke.simpleUpload.songAuthorLabel")}
                  className={`${karaokeInputClass} viread-learning-content`}
                  dir="ltr"
                  lang="vi"
                  maxLength={200}
                  value={author}
                  onChange={(e) => setAuthor(e.target.value.normalize("NFC"))}
                />
              </label>
              <label className="grid gap-1.5 font-bold">
                {t("karaoke.simpleUpload.minGradeLabel")}
                <select
                  aria-label={t("karaoke.simpleUpload.minGradeLabel")}
                  className={karaokeInputClass}
                  value={minGrade}
                  onChange={(e) => setMinGrade(Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((grade) => (
                    <option key={grade} value={grade}>
                      {t("karaoke.simpleUpload.gradeOption", { grade })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 font-bold">
                {t("karaoke.simpleUpload.maxGradeLabel")}
                <select
                  aria-label={t("karaoke.simpleUpload.maxGradeLabel")}
                  className={karaokeInputClass}
                  value={maxGrade}
                  onChange={(e) => setMaxGrade(Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((grade) => (
                    <option key={grade} value={grade}>
                      {t("karaoke.simpleUpload.gradeOption", { grade })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 font-bold">
                {t("karaoke.simpleUpload.sourceNoteLabel")}
                <input
                  aria-label={t("karaoke.simpleUpload.sourceNoteLabel")}
                  className={karaokeInputClass}
                  maxLength={1000}
                  value={sourceNote}
                  onChange={(e) =>
                    setSourceNote(e.target.value.normalize("NFC"))
                  }
                />
              </label>
              <label className="grid gap-1.5 font-bold">
                {t("karaoke.simpleUpload.usageNoteLabel")}
                <input
                  aria-label={t("karaoke.simpleUpload.usageNoteLabel")}
                  className={karaokeInputClass}
                  maxLength={1000}
                  value={usageNote}
                  onChange={(e) =>
                    setUsageNote(e.target.value.normalize("NFC"))
                  }
                />
              </label>
            </div>

            {localTimingProblems.length > 0 ? (
              <StatusMessage tone="warning">
                {t("karaoke.simpleUpload.timingProblemsPrefix")}{" "}
                {localTimingProblems[0]}
              </StatusMessage>
            ) : null}

            <div className="grid gap-3 rounded-control border border-border bg-sky/40 p-4">
              <p className="text-sm font-extrabold">
                {t("karaoke.simpleUpload.complianceHeading")}
              </p>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={rightsConfirmed}
                  onChange={(e) => setRightsConfirmed(e.target.checked)}
                />
                {t("karaoke.simpleUpload.rightsConfirmLabel")}
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={childSafeConfirmed}
                  onChange={(e) => setChildSafeConfirmed(e.target.checked)}
                />
                {t("karaoke.simpleUpload.childSafeConfirmLabel")}
              </label>
              {requiresProcessingReview ? (
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={processingReviewConfirmed}
                    onChange={(e) =>
                      setProcessingReviewConfirmed(e.target.checked)
                    }
                  />
                  {t("karaoke.simpleUpload.processingReviewConfirmLabel")}
                </label>
              ) : null}
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                disabled={!canPublish}
                isLoading={publishing}
                size="compact"
                className="sm:w-auto"
                onClick={() => void handleSimplePublish()}
              >
                {t("karaoke.simpleUpload.publishBtn")}
              </Button>
              {onSwitchAdvanced ? (
                <Button
                  variant="secondary"
                  size="compact"
                  className="sm:w-auto"
                  onClick={() => onSwitchAdvanced(imported.song_id)}
                >
                  {t("karaoke.simpleUpload.openAdvancedEditorBtn")}
                </Button>
              ) : (
                <ButtonLink
                  href={`/admin/karaoke/${imported.song_id}/edit?mode=advanced`}
                  variant="secondary"
                  size="compact"
                  className="sm:w-auto"
                >
                  {t("karaoke.simpleUpload.openAdvancedEditorBtn")}
                </ButtonLink>
              )}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
