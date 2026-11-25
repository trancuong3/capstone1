"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { karaokeInputClass } from "@/components/admin/karaoke/song-metadata-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminKaraoke } from "@/components/karaoke/karaoke-services-provider";
import { karaokeErrorMessage } from "@/lib/api/admin-karaoke-service";
import {
  createKaraokeSimpleImportService,
  type FlaggedLyricLine,
  type KaraokeSimpleImportService,
  type SimpleAudioType,
  type SimpleImportResult,
  type SimpleLyricsSource,
} from "@/lib/api/karaoke-simple-import-service";
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
const DEFAULT_SOURCE_NOTE =
  "Tài liệu nhạc thiếu nhi do Quản trị viên tải lên và kiểm duyệt";
const DEFAULT_USAGE_NOTE =
  "Sử dụng cho luyện đọc và hát karaoke giáo dục lớp 1–5 trên ViRead";

const AUDIO_TYPE_LABELS: Record<SimpleAudioType, string> = {
  VOCAL_FULL: "Có giọng hát (Vocal)",
  INSTRUMENTAL_ONLY: "Nhạc nền không lời (Instrumental)",
  DUAL_TRACK: "Song song giọng & nhạc nền",
  UNKNOWN: "Chưa xác định loại nhạc",
};

const LYRICS_SOURCE_LABELS: Record<SimpleLyricsSource, string> = {
  EMBEDDED_SYNCED: "Lời đồng bộ nhúng sẵn (ID3/LRC)",
  EMBEDDED_UNSYNCED: "Lời nhúng sẵn (USLT)",
  ADMIN_TEXT: "Lời Quản trị viên cung cấp",
  GROQ_WHISPER: "Nhận diện tự động (Groq Whisper)",
  NONE: "Chưa có lời bài hát",
};

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
      reason:
        "Mốc thời gian được ước lượng đều — bạn có thể nghe thử hoặc gõ phím Space 1 lượt.",
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
  const adminService = useAdminKaraoke();
  const importService = useMemo(
    () => simpleService ?? createKaraokeSimpleImportService(),
    [simpleService],
  );

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

  // Tap-to-sync mini-mode
  const [tapSyncActive, setTapSyncActive] = useState(false);
  const [tapIndex, setTapIndex] = useState(0);
  const [tapStarts, setTapStarts] = useState<number[]>([]);

  // Step 3 editable metadata & UNCHECKED-by-default safety compliance checkboxes
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [minGrade, setMinGrade] = useState(1);
  const [maxGrade, setMaxGrade] = useState(5);
  const [sourceNote, setSourceNote] = useState(DEFAULT_SOURCE_NOTE);
  const [usageNote, setUsageNote] = useState(DEFAULT_USAGE_NOTE);
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
  const classifyRunId = useRef(0);

  useEffect(() => {
    return () => {
      requestRef.current?.abort();
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

  async function handleFileSelection(file: File | null) {
    setError("");
    setNotice("");
    if (!file) return;
    if (!/\.mp3$/i.test(file.name)) {
      setError("Chỉ hỗ trợ file nhạc định dạng MP3 (.mp3).");
      return;
    }
    if (file.size <= 0) {
      setError("File MP3 đang rỗng. Hãy chọn file hợp lệ.");
      return;
    }
    if (file.size > MAX_AUDIO_BYTES) {
      setError("File MP3 vượt quá giới hạn tối đa 20 MiB.");
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
      setError("File lời (.lrc / .txt) vượt quá 256 KiB.");
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
      setError("Không đọc được file lời đã chọn.");
    }
  }

  async function handleAutoCreate() {
    if (!selectedFile || importing) return;
    if (step1MinGrade > step1MaxGrade) {
      setError("Lớp bắt đầu không được lớn hơn lớp kết thúc.");
      return;
    }
    requestRef.current?.abort();
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
          rights_confirmed: false,
          child_safe_confirmed: false,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;

      setImported(result);
      const draft = result.song.draft;
      setLyrics(draft?.lyrics ?? { format_version: 1, lines: [] });
      setFlaggedLines(result.flagged_lines);
      setTitle(result.title);
      setAuthor(result.author);
      setMinGrade(draft?.min_grade ?? step1MinGrade);
      setMaxGrade(draft?.max_grade ?? step1MaxGrade);
      setSourceNote(draft?.source_note?.trim() || DEFAULT_SOURCE_NOTE);
      setUsageNote(draft?.usage_note?.trim() || DEFAULT_USAGE_NOTE);
      // Always start UNCHECKED so admin makes an explicit safety & rights confirmation.
      setRightsConfirmed(false);
      setChildSafeConfirmed(false);
      setPublishedDetail(null);
      setTapSyncActive(false);
      setTapIndex(0);
      setTapStarts([]);
      setNotice(result.guidance_vi);

      // Load signed server preview in the background (cover art + signed playback URL).
      adminService
        .preview(
          result.song_id,
          result.revision,
          result.version_id,
          controller.signal,
        )
        .then((loadedPreview) => {
          if (!controller.signal.aborted) setPreview(loadedPreview);
        })
        .catch(() => {
          // Local blob preview remains usable if preview fetch is unavailable.
        });
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(karaokeErrorMessage(err));
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setImporting(false);
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
        setNotice(
          `Đã áp dụng ${nextLyrics.lines.length} dòng từ file .lrc thành công.`,
        );
        return;
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "Nội dung .lrc chưa đúng định dạng [mm:ss.xx].",
        );
        return;
      }
    }

    const distributed = distributePlainTextToLyrics(raw, imported.duration_ms);
    if (!distributed.lyrics.lines.length) {
      setError("Hãy nhập ít nhất 1 dòng lời hợp lệ.");
      return;
    }
    setLyrics(distributed.lyrics);
    setFlaggedLines(distributed.flagged);
    setNotice(
      `Đã tạo ${distributed.lyrics.lines.length} dòng lời và chia mốc tạm thời. Bạn có thể gõ phím Space 1 lượt để khớp nhịp chuẩn.`,
    );
  }

  function updateLineText(lineId: string, nextTextRaw: string) {
    const cleaned = nextTextRaw.normalize("NFC").replace(/\p{Cc}/gu, "");
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
    setNotice(
      "Chế độ gõ nhịp 1 lượt đang bật: bấm phím Space (hoặc nút Gõ nhịp) mỗi khi bắt đầu hát câu mới.",
    );
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
      setFlaggedLines((items) =>
        items.filter((item) => item.flag !== "NEEDS_TIMING_CHECK"),
      );
      setTapSyncActive(false);
      setTapStarts([]);
      setTapIndex(0);
      audioRef.current?.pause?.();
      setNotice("Đã hoàn tất căn nhịp 1 lượt bằng phím Space cho toàn bộ bài!");
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

  const canPublish = Boolean(
    imported &&
    !publishedDetail &&
    !publishing &&
    rightsConfirmed &&
    childSafeConfirmed &&
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
      const published = await importService.simplePublish(
        imported.song_id,
        {
          expected_revision: imported.revision,
          draft_version_id: imported.version_id,
          rights_confirmed: rightsConfirmed,
          child_safe_confirmed: childSafeConfirmed,
          title: title.trim(),
          author: author.trim(),
          min_grade: minGrade,
          max_grade: maxGrade,
          source_note: sourceNote.trim(),
          usage_note: usageNote.trim(),
          lyrics,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPublishedDetail(published);
      setNotice("Đã xuất bản bài hát thành công! Trẻ đã có thể hát bài này.");
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
    setImported(null);
    setPreview(null);
    setLyrics({ format_version: 1, lines: [] });
    setFlaggedLines([]);
    setInlineLyricsInput("");
    setTapSyncActive(false);
    setTapIndex(0);
    setTapStarts([]);
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
        eyebrow="Quản trị Karaoke · Chế độ đơn giản"
        title="Thêm nhanh 1 file MP3"
        description="Thả 1 file MP3 để tự động tách tên bài, tác giả, ảnh bìa, phân loại giọng hát/nhạc nền và tạo bản nháp karaoke trong vài giây."
        actions={
          <div className="flex flex-wrap gap-2">
            {onSwitchAdvanced ? (
              <Button
                variant="secondary"
                size="compact"
                className="sm:w-auto"
                onClick={() => onSwitchAdvanced(imported?.song_id)}
              >
                Chỉnh sửa nâng cao
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
                Chỉnh sửa nâng cao
              </ButtonLink>
            )}
            {onSwitchWizard ? (
              <Button
                variant="quiet"
                size="compact"
                className="sm:w-auto"
                onClick={onSwitchWizard}
              >
                Tách giọng nâng cao
              </Button>
            ) : null}
            <ButtonLink
              href="/admin/karaoke"
              variant="quiet"
              size="compact"
              className="sm:w-auto"
            >
              Về danh sách
            </ButtonLink>
          </div>
        }
      />

      <ol
        aria-label="Các bước thêm karaoke nhanh"
        className="grid gap-2 sm:grid-cols-3"
      >
        {[
          { step: 1, label: "1. Chọn 1 file MP3" },
          { step: 2, label: "2. Kiểm tra nhanh" },
          { step: 3, label: "3. Xác nhận & Xuất bản" },
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
          <StatusMessage tone="success" title="Đã xuất bản bài hát">
            Bài hát <strong>{publishedDetail.published?.title ?? title}</strong>{" "}
            đã sẵn sàng trong thư viện Karaoke cho học sinh lớp {minGrade}–
            {maxGrade}.
          </StatusMessage>
          <div className="flex flex-wrap gap-3">
            <Button className="sm:w-auto" onClick={resetForAnotherSong}>
              Thêm bài hát khác
            </Button>
            <ButtonLink
              href="/admin/karaoke"
              variant="secondary"
              className="sm:w-auto"
            >
              Về danh sách bài hát
            </ButtonLink>
          </div>
        </Card>
      ) : null}

      {!imported && !publishedDetail ? (
        <Card className="grid gap-5">
          <h2 className="text-xl font-extrabold">Bước 1 — Chọn 1 file MP3</h2>

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
                ? `Đã chọn: ${selectedFile.name}`
                : "Kéo thả 1 file MP3 vào đây hoặc bấm để chọn"}
            </p>
            <p className="text-sm text-muted">
              Hỗ trợ MP3 tối đa 20 MiB (≤ 5 phút). Tự động đọc thẻ ID3 (tên, tác
              giả, ảnh bìa, lời nhúng) và phân loại giọng hát ngay trên trình
              duyệt.
            </p>
            <div className="mx-auto">
              <label className="inline-flex min-h-12 cursor-pointer items-center justify-center rounded-control bg-white px-5 py-2.5 font-bold text-primary-hover shadow-sm ring-1 ring-border hover:bg-sky">
                <span>
                  {selectedFile ? "Chọn file MP3 khác" : "Chọn file nhạc MP3"}
                </span>
                <input
                  aria-label="Chọn file nhạc MP3"
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
                      ? "Đang phân tích loại nhạc…"
                      : AUDIO_TYPE_LABELS[effectiveAudioType]}
                  </span>
                  {classification?.estimatedBpm ? (
                    <span className="inline-flex items-center rounded-md bg-success-surface px-2.5 py-1 text-sm font-semibold text-success-ink">
                      ~{classification.estimatedBpm} BPM
                    </span>
                  ) : null}
                </div>
                <label className="flex items-center gap-2 text-sm font-semibold">
                  Loại nhạc:
                  <select
                    aria-label="Chọn loại nhạc"
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
                    <option value="AUTO">Tự động nhận diện</option>
                    <option value="VOCAL_FULL">Có giọng hát (Vocal)</option>
                    <option value="INSTRUMENTAL_ONLY">
                      Nhạc nền không lời (Instrumental)
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
                Tên bài hát gợi ý (tự đọc từ file / thẻ ID3)
                <input
                  aria-label="Tên bài hát gợi ý"
                  className={karaokeInputClass}
                  maxLength={200}
                  value={step1Title}
                  placeholder="Để trống để máy chủ tự đọc từ thẻ ID3"
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
              Tùy chọn nhanh: dán sẵn lời / tải file .lrc / chọn lớp & tác giả
            </summary>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="grid gap-1.5 font-bold">
                Tác giả / ca sĩ (tùy chọn)
                <input
                  aria-label="Tác giả (tùy chọn)"
                  className={karaokeInputClass}
                  maxLength={200}
                  value={step1Author}
                  placeholder="Tự đọc từ thẻ ID3 nếu có"
                  onChange={(e) =>
                    setStep1Author(e.target.value.normalize("NFC"))
                  }
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1.5 font-bold">
                  Từ lớp
                  <select
                    aria-label="Từ lớp bước 1"
                    className={karaokeInputClass}
                    value={step1MinGrade}
                    onChange={(e) => setStep1MinGrade(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((grade) => (
                      <option key={grade} value={grade}>
                        Lớp {grade}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1.5 font-bold">
                  Đến lớp
                  <select
                    aria-label="Đến lớp bước 1"
                    className={karaokeInputClass}
                    value={step1MaxGrade}
                    onChange={(e) => setStep1MaxGrade(Number(e.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map((grade) => (
                      <option key={grade} value={grade}>
                        Lớp {grade}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-2 md:col-span-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="simple-step1-lyrics" className="font-bold">
                    Lời bài hát hoặc nội dung .lrc (tùy chọn)
                  </label>
                  <label className="cursor-pointer text-sm font-semibold text-primary-hover underline">
                    Tải nhanh file .lrc / .txt
                    <input
                      aria-label="Tải nhanh file lời bước 1"
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
                  aria-label="Lời bài hát hoặc nội dung .lrc (tùy chọn)"
                  rows={4}
                  className={karaokeInputClass}
                  placeholder="[00:01.00] Cháu lên ba cháu đi mẫu giáo..."
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
                Tự nhận diện lời miễn phí (Groq Whisper) nếu MP3 có giọng hát
                nhưng không có lời nhúng
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
              Tự động tạo karaoke
            </Button>
          </div>
        </Card>
      ) : null}

      {imported && !publishedDetail ? (
        <>
          <Card aria-label="Bước 2: Kiểm tra nhanh" className="grid gap-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="grid gap-1">
                <h2 className="text-xl font-extrabold">
                  Bước 2 — Kiểm tra nhanh (Review by Exception)
                </h2>
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="rounded-md bg-sky px-2.5 py-1 text-sm font-bold text-primary-hover">
                    {AUDIO_TYPE_LABELS[imported.audio_type]}
                  </span>
                  <span className="rounded-md bg-sky px-2.5 py-1 text-sm font-semibold">
                    {LYRICS_SOURCE_LABELS[imported.lyrics_source]}
                  </span>
                  <span className="rounded-md border border-border px-2.5 py-1 text-sm font-semibold tabular-nums">
                    Thời lượng: {formatKaraokeTime(imported.duration_ms)}
                  </span>
                  {imported.has_cover ? (
                    <span className="rounded-md bg-success-surface px-2.5 py-1 text-sm font-semibold text-success-ink">
                      Đã tự tách ảnh bìa MP3
                    </span>
                  ) : null}
                </div>
              </div>
              {preview?.cover_url ? (
                <img
                  src={preview.cover_url}
                  alt={`Ảnh bìa ${title}`}
                  className="size-20 rounded-control border border-border object-cover"
                />
              ) : null}
            </div>

            {playbackUrl ? (
              <div className="grid gap-2 rounded-control border border-border bg-sky/40 p-3">
                <p className="text-sm font-bold">Nghe thử bài hát</p>
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
                  Chưa có lời bài hát — dán lời hoặc chọn file .lrc ngay trong 1
                  bước:
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-muted">
                    Hỗ trợ lời thường (mỗi câu 1 dòng) hoặc định dạng .lrc
                    [mm:ss.xx].
                  </span>
                  <label className="cursor-pointer text-sm font-bold text-primary-hover underline">
                    Chọn file .lrc / .txt
                    <input
                      aria-label="Chọn file lời bổ sung"
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
                  aria-label="Dán lời bài hát hoặc .lrc"
                  rows={5}
                  className={karaokeInputClass}
                  placeholder="Cháu lên ba cháu đi mẫu giáo&#10;Cô thương cháu vì cháu không khóc nhè"
                  value={inlineLyricsInput}
                  onChange={(e) => setInlineLyricsInput(e.target.value)}
                />
                <Button
                  className="sm:w-auto"
                  disabled={!inlineLyricsInput.trim()}
                  onClick={handleApplyInlineLyrics}
                >
                  Áp dụng lời & chia mốc nhanh
                </Button>
              </div>
            ) : (
              <div className="grid gap-4">
                {flaggedLines.length > 0 ? (
                  <div
                    aria-label="Các dòng cần kiểm tra nhanh"
                    className="grid gap-3 rounded-control border border-warning bg-warning-surface/40 p-4"
                  >
                    <p className="font-bold">
                      Có {flaggedLines.length} dòng cần kiểm tra nhanh (Review
                      by Exception):
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
                                Dòng {flag.line_index + 1} ·{" "}
                                <span className="text-warning">
                                  {flag.flag === "NEEDS_REVIEW"
                                    ? "Cần rà lại chính tả"
                                    : "Cần kiểm tra nhịp"}
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
                                    Nghe đoạn này
                                  </Button>
                                ) : null}
                              </div>
                            </div>
                            <input
                              aria-label={`Sửa nhanh dòng ${flag.line_index + 1}`}
                              className={karaokeInputClass}
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
                    Tất cả {lyrics.lines.length} dòng lời đã có mốc thời gian
                    hợp lệ và không có dòng nào bị đánh dấu bất thường.
                  </StatusMessage>
                )}

                <div className="grid gap-3 rounded-control border border-border bg-white p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-bold">
                        Căn nhịp 1 lượt bằng phím Space (không cần chỉnh từng
                        mili-giây)
                      </p>
                      <p className="text-sm text-muted">
                        Tùy chọn: nghe bài hát 1 lượt và nhấn Space ở đầu mỗi
                        câu để cập nhật mốc chuẩn tức thì.
                      </p>
                    </div>
                    {!tapSyncActive ? (
                      <Button
                        variant="secondary"
                        size="compact"
                        className="sm:w-auto"
                        onClick={startTapSync}
                      >
                        Căn nhịp nhanh bằng phím Space
                      </Button>
                    ) : (
                      <Button
                        variant="quiet"
                        size="compact"
                        className="sm:w-auto"
                        onClick={() => setTapSyncActive(false)}
                      >
                        Đóng chế độ gõ nhịp
                      </Button>
                    )}
                  </div>

                  {tapSyncActive && lyrics.lines[tapIndex] ? (
                    <div
                      ref={tapRegionRef}
                      tabIndex={0}
                      role="region"
                      aria-label="Vùng gõ nhịp Space 1 lượt"
                      onKeyDown={handleTapRegionKeyDown}
                      className="grid gap-3 rounded-control border-2 border-primary bg-sky p-4 focus-visible:outline-3 focus-visible:outline-primary"
                    >
                      <p className="text-sm font-bold text-primary-hover">
                        Câu {tapIndex + 1} / {lyrics.lines.length} — Nhấn phím
                        Space khi bắt đầu hát câu này:
                      </p>
                      <p className="text-xl font-extrabold">
                        “{lyrics.lines[tapIndex].text}”
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button className="sm:w-auto" onClick={recordTap}>
                          Gõ nhịp (Space) — Dòng tiếp theo
                        </Button>
                        <Button
                          variant="secondary"
                          className="sm:w-auto"
                          disabled={tapIndex === 0}
                          onClick={undoTap}
                        >
                          Hoàn tác 1 dòng
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <details className="rounded-control border border-border bg-white p-3">
                  <summary className="cursor-pointer text-sm font-bold text-primary-hover">
                    Xem / sửa toàn bộ lời ({lyrics.lines.length} dòng)
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
                          aria-label={`Lời dòng ${idx + 1}`}
                          className={karaokeInputClass}
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
            aria-label="Bước 3: Xác nhận an toàn và xuất bản"
            className="grid gap-5"
          >
            <h2 className="text-xl font-extrabold">
              Bước 3 — Xác nhận an toàn & Xuất bản
            </h2>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="grid gap-1.5 font-bold">
                Tên bài hát
                <input
                  aria-label="Tên bài hát"
                  className={karaokeInputClass}
                  maxLength={200}
                  value={title}
                  onChange={(e) => setTitle(e.target.value.normalize("NFC"))}
                />
              </label>
              <label className="grid gap-1.5 font-bold">
                Tác giả / người thể hiện
                <input
                  aria-label="Tác giả / người thể hiện"
                  className={karaokeInputClass}
                  maxLength={200}
                  value={author}
                  onChange={(e) => setAuthor(e.target.value.normalize("NFC"))}
                />
              </label>
              <label className="grid gap-1.5 font-bold">
                Từ lớp
                <select
                  aria-label="Từ lớp"
                  className={karaokeInputClass}
                  value={minGrade}
                  onChange={(e) => setMinGrade(Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((grade) => (
                    <option key={grade} value={grade}>
                      Lớp {grade}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 font-bold">
                Đến lớp
                <select
                  aria-label="Đến lớp"
                  className={karaokeInputClass}
                  value={maxGrade}
                  onChange={(e) => setMaxGrade(Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((grade) => (
                    <option key={grade} value={grade}>
                      Lớp {grade}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 font-bold">
                Nguồn nhạc và lời
                <input
                  aria-label="Nguồn nhạc và lời"
                  className={karaokeInputClass}
                  maxLength={1000}
                  value={sourceNote}
                  onChange={(e) =>
                    setSourceNote(e.target.value.normalize("NFC"))
                  }
                />
              </label>
              <label className="grid gap-1.5 font-bold">
                Quyền sử dụng nội dung
                <input
                  aria-label="Quyền sử dụng nội dung"
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
                Cần hoàn thiện mốc thời gian trước khi xuất bản:{" "}
                {localTimingProblems[0]}
              </StatusMessage>
            ) : null}

            <div className="grid gap-3 rounded-control border border-border bg-sky/40 p-4">
              <p className="text-sm font-extrabold">
                Xác nhận bắt buộc trước khi xuất bản cho học sinh:
              </p>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={rightsConfirmed}
                  onChange={(e) => setRightsConfirmed(e.target.checked)}
                />
                Tôi xác nhận quyền sử dụng bài hát phù hợp
              </label>
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={childSafeConfirmed}
                  onChange={(e) => setChildSafeConfirmed(e.target.checked)}
                />
                Tôi xác nhận nội dung phù hợp trẻ em lớp 1–5
              </label>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                disabled={!canPublish}
                isLoading={publishing}
                className="sm:w-auto"
                onClick={() => void handleSimplePublish()}
              >
                Xuất bản ngay
              </Button>
              {onSwitchAdvanced ? (
                <Button
                  variant="secondary"
                  className="sm:w-auto"
                  onClick={() => onSwitchAdvanced(imported.song_id)}
                >
                  Mở trình chỉnh sửa nâng cao
                </Button>
              ) : (
                <ButtonLink
                  href={`/admin/karaoke/${imported.song_id}/edit?mode=advanced`}
                  variant="secondary"
                  className="sm:w-auto"
                >
                  Mở trình chỉnh sửa nâng cao
                </ButtonLink>
              )}
            </div>
          </Card>
        </>
      ) : null}
    </div>
  );
}
