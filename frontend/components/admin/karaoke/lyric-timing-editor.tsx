"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdminSelect } from "@/components/admin/admin-ui";
import {
  KaraokeConfirmModal,
  type KaraokeConfirmRequest,
} from "@/components/admin/karaoke/karaoke-confirm-modal";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import {
  importLyrics,
  MAX_LYRICS_BYTES,
  MAX_LYRICS_JSON_BYTES,
} from "@/lib/karaoke/lyrics-import";
import {
  formatLyricTimestamp,
  timingIssues,
} from "@/lib/karaoke/lyrics-timeline";
import type { KaraokeLyrics, KaraokeLine } from "@/types/karaoke";
import {
  karaokeFileInputClass,
  karaokeInputClass,
  karaokeTextareaClass,
} from "@/components/admin/karaoke/song-metadata-form";
import {
  SyllableTimingEditor,
  type TimingControls,
  type TimingFocus,
} from "./syllable-timing-editor";
import {
  splitSyllables,
  syllableIssues,
  upgradeLyrics,
} from "@/lib/karaoke/syllable-timing";

type TimingEditorProps = {
  lyrics: KaraokeLyrics;
  duration: number | null;
  disabled: boolean;
  player?: TimingControls;
  onChange: (lyrics: KaraokeLyrics) => void;
  onSave?: () => void;
  focusTarget?: TimingFocus;
};
const LINES_PER_PAGE = 25;

export function LyricTimingEditor(props: TimingEditorProps) {
  const { player } = props;
  const ready = player?.ready;
  const play = player?.play;
  const getCurrentMs = player?.getCurrentMs;
  const pause = player?.pause,
    setRate = player?.setRate,
    rate = player?.rate,
    playing = player?.playing;
  // Audio time updates every animation frame; the form only needs these controls.
  const controls = useMemo(
    () =>
      ready !== undefined && play && getCurrentMs
        ? { ready, play, getCurrentMs, pause, setRate, rate, playing }
        : undefined,
    [ready, play, getCurrentMs, pause, setRate, rate, playing],
  );
  return <TimingEditorForm {...props} player={controls} />;
}

const TimingEditorForm = memo(function TimingEditorForm({
  lyrics,
  duration,
  disabled,
  player,
  onChange,
  onSave,
  focusTarget,
}: TimingEditorProps) {
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const [page, setPage] = useState(0);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
  const [confirmRequest, setConfirmRequest] =
    useState<KaraokeConfirmRequest | null>(null);
  const [selection, setSelection] = useState<{
    id: string | null;
    request?: number;
  }>({ id: null });
  const generation = useRef(0);
  const fileRequest = useRef(0);
  const mounted = useRef(false);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  useEffect(() => {
    return invalidate;
  }, [lyrics, disabled, invalidate]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function commitImported(result: ReturnType<typeof importLyrics>) {
    onChange(result.lyrics);
    setPage(0);
    setError("");
    setNotice(
      result.suggestedEnds
        ? t("karaoke.lyricEditor.lrcNotice")
        : t("karaoke.lyricEditor.importedNotice"),
    );
  }

  function apply(text: string, format: "txt" | "lrc" | "json") {
    try {
      const result = importLyrics(text, format, duration);
      if (lyrics.lines.length) {
        setConfirmRequest({
          title: t(
            "karaoke.confirm.replaceLyricsTitle",
            undefined,
            "Thay thế toàn bộ lời hiện tại?",
          ),
          description: t("karaoke.lyricEditor.replaceConfirm"),
          confirmLabel: t(
            "karaoke.confirm.replaceLyricsAction",
            undefined,
            "Thay thế lời",
          ),
          variant: "destructive",
          onConfirm: () => commitImported(result),
        });
        return;
      }
      commitImported(result);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("karaoke.lyricEditor.readError"),
      );
    }
  }
  async function readFile(file?: File) {
    const ticket = ++generation.current;
    const request = ++fileRequest.current;
    setError("");
    setReading(false);
    if (!file || disabled) return;
    const extension = file.name.split(".").pop()?.toLowerCase();
    if (
      file.size >
        (extension === "json" ? MAX_LYRICS_JSON_BYTES : MAX_LYRICS_BYTES) ||
      !["txt", "lrc", "json"].includes(extension ?? "")
    ) {
      setError(t("karaoke.lyricEditor.fileLimitError"));
      return;
    }
    setReading(true);
    try {
      const bytes = await file.arrayBuffer();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      if (ticket === generation.current)
        apply(text, extension as "txt" | "lrc" | "json");
    } catch {
      if (ticket === generation.current)
        setError(t("karaoke.lyricEditor.utf8Error"));
    } finally {
      if (mounted.current && request === fileRequest.current) setReading(false);
    }
  }
  function update(id: string, patch: Partial<KaraokeLine>) {
    onChange({
      ...lyrics,
      lines: lyrics.lines.map((l) =>
        l.id === id
          ? {
              ...l,
              ...patch,
              ...(patch.text !== undefined && lyrics.format_version === 2
                ? { syllables: splitSyllables(patch.text) }
                : {}),
            }
          : l,
      ),
    });
  }
  const issues = timingIssues(lyrics.lines, duration);
  const pageCount = Math.max(
    1,
    Math.ceil(lyrics.lines.length / LINES_PER_PAGE),
  );
  const selectedId =
    focusTarget && focusTarget.request !== selection.request
      ? focusTarget.lineId
      : selection.id;
  const selectedIndex = lyrics.lines.findIndex((l) => l.id === selectedId);
  const currentPage =
    selectedIndex >= 0
      ? Math.floor(selectedIndex / LINES_PER_PAGE)
      : Math.min(page, pageCount - 1);
  const firstLine = currentPage * LINES_PER_PAGE;
  const unitIssues =
    lyrics.format_version === 2 ? syllableIssues(lyrics.lines, duration) : [];
  useEffect(() => {
    if (!focusTarget || lyrics.format_version === 2) return;
    const target = document.getElementById(`lyric-line-${focusTarget.lineId}`);
    target?.focus();
    target?.scrollIntoView({ block: "center" });
  }, [focusTarget, lyrics.format_version, currentPage]);
  return (
    <div className="grid gap-5">
      <fieldset disabled={disabled || reading} className="grid min-w-0 gap-4">
        <legend className="mb-2 text-sm font-bold text-ink">
          {t("karaoke.lyricEditor.importLegend")}
        </legend>
        <label className="grid gap-1.5 text-sm font-semibold text-ink">
          {t("karaoke.lyricEditor.pasteLabel")}
          <textarea
            rows={4}
            className={`${karaokeTextareaClass} viread-learning-content`}
            dir="ltr"
            lang="vi"
            value={paste}
            maxLength={100000}
            onChange={(e) => setPaste(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <Button
            disabled={!paste.trim()}
            fullWidth={false}
            onClick={() => apply(paste, "txt")}
            size="admin"
            variant="secondary"
          >
            {t("karaoke.lyricEditor.importPastedBtn")}
          </Button>
          <label className="grid min-w-0 flex-1 gap-1.5 text-xs font-semibold text-muted sm:max-w-md">
            {t("karaoke.lyricEditor.importFileLabel")}
            <input
              type="file"
              aria-label={t("karaoke.lyricEditor.importFileAria")}
              accept=".txt,.lrc,.json"
              className={karaokeFileInputClass}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                void readFile(file);
              }}
            />
          </label>
        </div>
      </fieldset>
      {reading && (
        <p role="status" className="text-sm text-muted">
          {t("karaoke.lyricEditor.readingFileStatus")}
        </p>
      )}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {notice && <StatusMessage>{notice}</StatusMessage>}
      <p className="text-sm text-muted">
        {t("karaoke.lyricEditor.timingHint")}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm font-medium text-ink" role="status">
          {lyrics.format_version === 2
            ? t("karaoke.lyricEditor.syllableAlignedSummary", {
                aligned: formatNumber(
                  lyrics.lines.filter(
                    (l) =>
                      l.syllables?.length &&
                      !unitIssues.some((e) => e.lineId === l.id),
                  ).length,
                ),
                total: formatNumber(lyrics.lines.length),
              })
            : t("karaoke.lyricEditor.lineByLineHint")}
        </p>
        <Button
          disabled={!lyrics.lines.length}
          fullWidth={false}
          onClick={() => {
            const blob = new Blob([JSON.stringify(lyrics, null, 2)], {
              type: "application/json;charset=utf-8",
            });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "karaoke-lyrics.json";
            link.click();
            URL.revokeObjectURL(url);
          }}
          size="admin"
          variant="outline"
        >
          {t("karaoke.lyricEditor.exportJsonBtn")}
        </Button>
      </div>
      <fieldset disabled={disabled || reading} className="grid min-w-0 gap-4">
        <legend className="sr-only">
          {t("karaoke.lyricEditor.editLegend")}
        </legend>
        {pageCount > 1 && (
          <div className="grid gap-1 sm:max-w-sm">
            <AdminSelect
              aria-label={t("karaoke.lyricEditor.pageNavLabel")}
              label={t("karaoke.lyricEditor.pageNavLabel")}
              onChange={(value) => {
                player?.pause?.();
                setSelection({ id: null, request: focusTarget?.request });
                setPage(Number(value));
              }}
              options={Array.from({ length: pageCount }, (_, index) => ({
                value: String(index),
                label: t("karaoke.lyricEditor.pageRangeWithTotal", {
                  start: formatNumber(index * LINES_PER_PAGE + 1),
                  end: formatNumber(
                    Math.min(
                      (index + 1) * LINES_PER_PAGE,
                      lyrics.lines.length,
                    ),
                  ),
                  total: formatNumber(lyrics.lines.length),
                }),
              }))}
              value={String(currentPage)}
            />
            <span className="text-xs font-normal text-muted">
              {t("karaoke.lyricEditor.paginationNote")}
            </span>
          </div>
        )}
        {lyrics.lines
          .slice(firstLine, firstLine + LINES_PER_PAGE)
          .map((item, offset) => {
            const i = firstLine + offset;
            const num = formatNumber(i + 1);
            return (
              <div
                key={item.id}
                id={`lyric-line-${item.id}`}
                tabIndex={-1}
                className="grid min-w-0 gap-3 rounded-xl border border-border bg-surface-subtle/30 p-4"
              >
                <label className="grid gap-1.5 text-sm font-semibold text-ink">
                  {t("karaoke.lyricEditor.lineTextLabel", { num })}
                  <input
                    className={`${karaokeInputClass} viread-learning-content`}
                    dir="ltr"
                    lang="vi"
                    value={item.text}
                    maxLength={300}
                    onChange={(e) =>
                      update(item.id, { text: e.target.value.normalize("NFC") })
                    }
                  />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ["start_ms", t("karaoke.lyricEditor.startLabel")],
                      ["end_ms", t("karaoke.lyricEditor.endLabel")],
                    ] as const
                  ).map(([key, label]) => (
                    <label
                      className="grid gap-1.5 text-sm font-semibold text-ink"
                      key={key}
                    >
                      {t("karaoke.lyricEditor.lineTimeInputLabel", {
                        label,
                        num,
                      })}
                      <input
                        type="number"
                        min={0}
                        max={duration ?? 300000}
                        step={1}
                        className={`${karaokeInputClass} tabular-nums`}
                        value={item[key] ?? ""}
                        onChange={(e) =>
                          update(item.id, {
                            [key]:
                              e.target.value === ""
                                ? null
                                : Number(e.target.value),
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <p className="text-xs tabular-nums text-muted">
                  {t("karaoke.lyricEditor.timestampPreview", {
                    start: formatLyricTimestamp(item.start_ms),
                    end: formatLyricTimestamp(item.end_ms),
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    fullWidth={false}
                    onClick={() => {
                      player?.pause?.();
                      if (lyrics.format_version === 1)
                        onChange(upgradeLyrics(lyrics));
                      setSelection({
                        id: item.id,
                        request: focusTarget?.request,
                      });
                    }}
                    size="admin"
                    variant="secondary"
                  >
                    {t("karaoke.lyricEditor.alignSyllablesBtn", { num })}
                  </Button>
                  <Button
                    disabled={!player?.ready}
                    fullWidth={false}
                    onClick={() => {
                      if (player)
                        update(item.id, { start_ms: player.getCurrentMs() });
                    }}
                    size="admin"
                    variant="outline"
                  >
                    {t("karaoke.lyricEditor.markStartBtn", { num })}
                  </Button>
                  <Button
                    disabled={!player?.ready}
                    fullWidth={false}
                    onClick={() => {
                      if (player)
                        update(item.id, { end_ms: player.getCurrentMs() });
                    }}
                    size="admin"
                    variant="outline"
                  >
                    {t("karaoke.lyricEditor.markEndBtn", { num })}
                  </Button>
                  <Button
                    disabled={
                      !player?.ready ||
                      item.start_ms === null ||
                      item.end_ms === null ||
                      item.end_ms <= item.start_ms
                    }
                    fullWidth={false}
                    onClick={() => {
                      if (item.start_ms !== null && item.end_ms !== null)
                        void player?.play(item.start_ms, item.end_ms);
                    }}
                    size="admin"
                    variant="outline"
                  >
                    {t("karaoke.lyricEditor.playLineBtn", { num })}
                  </Button>
                  <Button
                    fullWidth={false}
                    onClick={() =>
                      onChange({
                        ...lyrics,
                        lines: lyrics.lines.filter((l) => l.id !== item.id),
                      })
                    }
                    size="admin"
                    variant="destructive-outline"
                  >
                    {t("karaoke.lyricEditor.deleteLineBtn", { num })}
                  </Button>
                </div>
                {lyrics.format_version === 2 && selectedId === item.id && (
                  <SyllableTimingEditor
                    key={`${item.id}:${item.text}`}
                    line={item}
                    lineNumber={i + 1}
                    lines={lyrics.lines}
                    duration={duration}
                    disabled={disabled || reading}
                    player={player}
                    focusTarget={focusTarget}
                    onSave={onSave}
                    onChange={(line) =>
                      onChange({
                        ...lyrics,
                        lines: lyrics.lines.map((l) =>
                          l.id === line.id ? line : l,
                        ),
                      })
                    }
                  />
                )}
              </div>
            );
          })}
        <div>
          <Button
            disabled={lyrics.lines.length >= 300}
            fullWidth={false}
            onClick={() => {
              onChange({
                ...lyrics,
                lines: [
                  ...lyrics.lines,
                  {
                    id: crypto.randomUUID(),
                    text: "",
                    start_ms: null,
                    end_ms: null,
                    ...(lyrics.format_version === 2 ? { syllables: [] } : {}),
                  },
                ],
              });
              setPage(Math.floor(lyrics.lines.length / LINES_PER_PAGE));
              setSelection({ id: null, request: focusTarget?.request });
            }}
            size="admin"
            variant="secondary"
          >
            {t("karaoke.lyricEditor.addLineBtn")}
          </Button>
        </div>
      </fieldset>
      {issues.length > 0 && (
        <StatusMessage
          tone="warning"
          title={t("karaoke.lyricEditor.issuesTitle", {
            count: formatNumber(issues.length),
          })}
        >
          <ul className="list-inside list-disc">
            {issues.slice(0, 8).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          {issues.length > 8 && (
            <p>
              {t("karaoke.lyricEditor.moreIssues", {
                count: formatNumber(issues.length - 8),
              })}
            </p>
          )}
        </StatusMessage>
      )}
      {unitIssues.length > 0 && (
        <StatusMessage
          tone="warning"
          title={t("karaoke.lyricEditor.unitIssuesTitle", {
            count: formatNumber(unitIssues.length),
          })}
        >
          <ul>
            {unitIssues.slice(0, 12).map((issue, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="min-h-10 text-start underline"
                  onClick={() => {
                    player?.pause?.();
                    setSelection({
                      id: issue.lineId,
                      request: focusTarget?.request,
                    });
                    requestAnimationFrame(() =>
                      document
                        .getElementById(`lyric-line-${issue.lineId}`)
                        ?.scrollIntoView({ block: "start" }),
                    );
                  }}
                >
                  {t("karaoke.lyricEditor.lineIssuePrefix", {
                    num: formatNumber(
                      lyrics.lines.findIndex((l) => l.id === issue.lineId) + 1,
                    ),
                    message: issue.message,
                  })}
                </button>
              </li>
            ))}
          </ul>
        </StatusMessage>
      )}

      <KaraokeConfirmModal
        onClose={() => setConfirmRequest(null)}
        request={confirmRequest}
      />
    </div>
  );
});
