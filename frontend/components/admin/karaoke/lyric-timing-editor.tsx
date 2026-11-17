"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
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
import { karaokeInputClass } from "@/components/admin/karaoke/song-metadata-form";
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
  const [page, setPage] = useState(0);
  const [paste, setPaste] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reading, setReading] = useState(false);
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
  function apply(text: string, format: "txt" | "lrc" | "json") {
    try {
      const result = importLyrics(text, format, duration);
      if (
        lyrics.lines.length &&
        !window.confirm("Thay thế toàn bộ lời và mốc thời gian đang nhập?")
      )
        return;
      onChange(result.lyrics);
      setPage(0);
      setError("");
      setNotice(
        result.suggestedEnds
          ? "Mốc kết thúc LRC chỉ là gợi ý từ câu tiếp theo/thời lượng nhạc. Hãy nghe và chỉnh lại trước khi xuất bản."
          : "Đã nhập lời. Hãy kiểm tra và căn thời gian từng dòng.",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Không đọc được lời.");
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
      setError("Chọn TXT/LRC UTF-8 tối đa 256 KiB hoặc JSON tối đa 2 MiB.");
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
        setError(
          "Không đọc được file UTF-8. Nội dung hiện tại được giữ nguyên.",
        );
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
        <legend className="mb-3 font-bold">Nhập lời (tối đa 300 dòng)</legend>
        <label className="grid gap-2 font-bold">
          Dán lời thuần văn bản
          <textarea
            rows={4}
            className={karaokeInputClass}
            value={paste}
            maxLength={100000}
            onChange={(e) => setPaste(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            className="sm:w-auto"
            variant="secondary"
            disabled={!paste.trim()}
            onClick={() => apply(paste, "txt")}
          >
            Nhập lời đã dán
          </Button>
          <label className="grid min-w-0 gap-2 text-sm font-bold">
            Nhập file TXT / LRC / JSON
            <input
              type="file"
              aria-label="File lời bài hát"
              accept=".txt,.lrc,.json"
              className="max-w-full"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                void readFile(file);
              }}
            />
          </label>
        </div>
      </fieldset>
      {reading && <p role="status">Đang đọc file lời…</p>}
      {error && <StatusMessage tone="error">{error}</StatusMessage>}
      {notice && <StatusMessage>{notice}</StatusMessage>}
      <p className="text-sm text-muted">
        Thời gian dùng mili giây (1 giây = 1000 ms). Để trống khi chưa căn. Bật
        nghe thử để đánh dấu theo vị trí âm thanh thật.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm" role="status">
          {lyrics.format_version === 2
            ? `Chạy từng tiếng · ${lyrics.lines.filter((l) => l.syllables?.length && !unitIssues.some((e) => e.lineId === l.id)).length}/${lyrics.lines.length} câu đã căn tiếng`
            : "Lời theo câu · Chọn Căn từng tiếng để nâng cấp bản nháp"}
        </p>
        <Button
          className="sm:w-auto"
          variant="secondary"
          disabled={!lyrics.lines.length}
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
        >
          Xuất lời và mốc JSON
        </Button>
      </div>
      <fieldset disabled={disabled || reading} className="grid min-w-0 gap-4">
        <legend className="sr-only">Chỉnh lời và thời gian</legend>
        {pageCount > 1 && (
          <label className="grid gap-2 font-bold sm:max-w-sm">
            Trang chỉnh lời
            <select
              aria-label="Trang chỉnh lời"
              className={karaokeInputClass}
              value={currentPage}
              onChange={(event) => {
                player?.pause?.();
                setSelection({ id: null, request: focusTarget?.request });
                setPage(Number(event.target.value));
              }}
            >
              {Array.from({ length: pageCount }, (_, index) => (
                <option key={index} value={index}>
                  Dòng {index * LINES_PER_PAGE + 1}–
                  {Math.min((index + 1) * LINES_PER_PAGE, lyrics.lines.length)}{" "}
                  / {lyrics.lines.length}
                </option>
              ))}
            </select>
            <span className="text-sm font-normal text-muted">
              Chia trang để chỉnh lời mượt hơn; khi lưu vẫn lưu toàn bộ bài hát.
            </span>
          </label>
        )}
        {lyrics.lines
          .slice(firstLine, firstLine + LINES_PER_PAGE)
          .map((item, offset) => {
            const i = firstLine + offset;
            return (
              <div
                key={item.id}
                id={`lyric-line-${item.id}`}
                tabIndex={-1}
                className="grid min-w-0 gap-3 rounded-control border border-border p-4"
              >
                <label className="grid gap-2 font-bold">
                  Lời dòng {i + 1}
                  <input
                    className={karaokeInputClass}
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
                      ["start_ms", "Bắt đầu"],
                      ["end_ms", "Kết thúc"],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="grid gap-2 font-bold" key={key}>
                      {label} dòng {i + 1} (ms)
                      <input
                        type="number"
                        min={0}
                        max={duration ?? 300000}
                        step={1}
                        className={karaokeInputClass}
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
                <p className="text-sm tabular-nums text-muted">
                  Mốc phút:giây.mili-giây: {formatLyricTimestamp(item.start_ms)}{" "}
                  → {formatLyricTimestamp(item.end_ms)}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="sm:w-auto"
                    variant="secondary"
                    onClick={() => {
                      player?.pause?.();
                      if (lyrics.format_version === 1)
                        onChange(upgradeLyrics(lyrics));
                      setSelection({
                        id: item.id,
                        request: focusTarget?.request,
                      });
                    }}
                  >
                    Căn từng tiếng dòng {i + 1}
                  </Button>
                  <Button
                    className="sm:w-auto"
                    variant="secondary"
                    disabled={!player?.ready}
                    onClick={() => {
                      if (player)
                        update(item.id, { start_ms: player.getCurrentMs() });
                    }}
                  >
                    Đánh dấu đầu dòng {i + 1}
                  </Button>
                  <Button
                    className="sm:w-auto"
                    variant="secondary"
                    disabled={!player?.ready}
                    onClick={() => {
                      if (player)
                        update(item.id, { end_ms: player.getCurrentMs() });
                    }}
                  >
                    Đánh dấu cuối dòng {i + 1}
                  </Button>
                  <Button
                    className="sm:w-auto"
                    variant="quiet"
                    disabled={
                      !player?.ready ||
                      item.start_ms === null ||
                      item.end_ms === null ||
                      item.end_ms <= item.start_ms
                    }
                    onClick={() => {
                      if (item.start_ms !== null && item.end_ms !== null)
                        void player?.play(item.start_ms, item.end_ms);
                    }}
                  >
                    Nghe dòng {i + 1}
                  </Button>
                  <Button
                    className="sm:w-auto"
                    variant="destructive"
                    onClick={() =>
                      onChange({
                        ...lyrics,
                        lines: lyrics.lines.filter((l) => l.id !== item.id),
                      })
                    }
                  >
                    Xóa dòng {i + 1}
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
        <Button
          className="sm:w-auto"
          variant="secondary"
          disabled={lyrics.lines.length >= 300}
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
        >
          Thêm dòng lời
        </Button>
      </fieldset>
      {issues.length > 0 && (
        <StatusMessage
          tone="warning"
          title={`Cần căn lại ${issues.length} mục`}
        >
          <ul className="list-inside list-disc">
            {issues.slice(0, 8).map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
          {issues.length > 8 && <p>Và {issues.length - 8} mục khác.</p>}
        </StatusMessage>
      )}
      {unitIssues.length > 0 && (
        <StatusMessage
          tone="warning"
          title={`Cần kiểm tra ${unitIssues.length} mục tiếng`}
        >
          <ul>
            {unitIssues.slice(0, 12).map((issue, i) => (
              <li key={i}>
                <button
                  type="button"
                  className="min-h-11 text-left underline"
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
                  Dòng{" "}
                  {lyrics.lines.findIndex((l) => l.id === issue.lineId) + 1}:{" "}
                  {issue.message}
                </button>
              </li>
            ))}
          </ul>
        </StatusMessage>
      )}
    </div>
  );
});
