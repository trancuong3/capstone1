"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/common/button";
import { SyllableLyrics } from "@/components/karaoke/syllable-lyrics";
import { formatLyricTimestamp } from "@/lib/karaoke/lyrics-timeline";
import {
  canonicalLyricText,
  copySyllableTiming,
  markSyllable,
  splitSyllables,
  syllableIssues,
} from "@/lib/karaoke/syllable-timing";
import type { KaraokeLine, KaraokeSyllable } from "@/types/karaoke";
import type { KaraokePlayerController } from "@/hooks/use-karaoke-player";
import { karaokeInputClass } from "./song-metadata-form";

export type TimingControls = Pick<
  KaraokePlayerController,
  "ready" | "play" | "getCurrentMs"
> &
  Partial<
    Pick<KaraokePlayerController, "pause" | "setRate" | "rate" | "playing">
  >;
export type TimingFocus = {
  lineId: string;
  syllableId?: string;
  request: number;
};

export function SyllableTimingEditor({
  line,
  lineNumber,
  lines,
  duration,
  disabled,
  player,
  focusTarget,
  onChange,
  onSave,
}: {
  line: KaraokeLine;
  lineNumber: number;
  lines: KaraokeLine[];
  duration: number | null;
  disabled: boolean;
  player?: TimingControls;
  focusTarget?: TimingFocus;
  onChange: (line: KaraokeLine) => void;
  onSave?: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const [undo, setUndo] = useState<{ line: KaraokeLine; selected: number }[]>(
    [],
  );
  const [repeat, setRepeat] = useState(false);
  const [time, setTime] = useState(0);
  const [notice, setNotice] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const units = line.syllables ?? [];
  const index = Math.min(selected, Math.max(0, units.length - 1));
  const unit = units[index];
  const getCurrentMs = player?.getCurrentMs;
  const isPlaying = Boolean(player?.playing);
  const pause = player?.pause;
  useEffect(() => () => pause?.(), [pause]);
  useEffect(() => {
    if (!getCurrentMs || !isPlaying) return;
    let frame = 0;
    const tick = () => {
      setTime(getCurrentMs());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getCurrentMs, isPlaying]);
  useEffect(() => {
    if (focusTarget?.lineId !== line.id) return;
    const target = root.current?.querySelector<HTMLButtonElement>(
      `[data-unit-id="${focusTarget.syllableId ?? ""}"]`,
    );
    (target ?? root.current)?.focus();
    (target ?? root.current)?.scrollIntoView({ block: "center" });
  }, [focusTarget, line.id]);
  function commit(next: KaraokeLine, message = "") {
    setUndo((history) => [...history.slice(-49), { line, selected: index }]);
    onChange(next);
    setNotice(message);
  }
  function undoLast() {
    const previous = undo.at(-1);
    if (!previous) return;
    player?.pause?.();
    onChange(previous.line);
    setSelected(previous.selected);
    setUndo((items) => items.slice(0, -1));
    setNotice("Đã hoàn tác lần chỉnh trước.");
  }
  function mark(edge: "start_ms" | "end_ms", advance = false) {
    if (!player?.ready || !unit) return;
    const at = player.getCurrentMs();
    setTime(at);
    if (
      line.start_ms === null ||
      line.end_ms === null ||
      at < line.start_ms ||
      at > line.end_ms
    ) {
      setNotice(
        "Đặt mốc câu và phát trong khoảng câu trước khi đánh dấu tiếng.",
      );
      return;
    }
    commit(
      markSyllable(line, index, edge, at, advance),
      advance
        ? "Mốc cuối tiếng trước là gợi ý. Nghe lại và chỉnh khoảng nghỉ/ngân nếu cần."
        : "Đã đánh dấu theo vị trí nhạc.",
    );
    if (advance && index < units.length - 1) setSelected(index + 1);
  }
  function changeUnit(patch: Partial<KaraokeSyllable>) {
    commit({
      ...line,
      syllables: units.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    });
  }
  function keyboard(event: KeyboardEvent) {
    if (
      disabled ||
      event.repeat ||
      event.altKey ||
      event.metaKey ||
      event.ctrlKey ||
      (event.target instanceof HTMLElement &&
        event.target.closest(
          "input,textarea,select,[contenteditable=true],button,[role=dialog]",
        ))
    )
      return;
    if (event.code === "Space") {
      event.preventDefault();
      mark("start_ms", true);
    } else if (event.key.toLowerCase() === "e") {
      event.preventDefault();
      mark("end_ms");
    } else if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      undoLast();
    }
  }
  const validSegment =
    line.start_ms !== null &&
    line.end_ms !== null &&
    line.end_ms > line.start_ms;
  const issues = syllableIssues([line], duration);
  const completed = units.filter(
    (s) =>
      s.start_ms !== null &&
      s.end_ms !== null &&
      s.start_ms < s.end_ms &&
      !issues.some((e) => e.syllableId === s.id),
  ).length;
  return (
    <div
      ref={root}
      tabIndex={0}
      role="region"
      aria-label={`Căn tiếng dòng ${lineNumber}`}
      onKeyDown={keyboard}
      className="grid min-w-0 gap-4 rounded-control border-2 border-primary bg-white p-4 focus-visible:outline-3 focus-visible:outline-primary"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xl font-extrabold">
          Căn tiếng · Dòng {lineNumber}
        </h3>
        <p role="status">
          {completed}/{units.length} tiếng đã căn ·{" "}
          {issues.length ? "Cần kiểm tra" : "Hợp lệ"}
        </p>
      </div>
      <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-control border border-border bg-white p-3 shadow-sm">
        <Button
          className="sm:w-auto"
          disabled={disabled || !player?.ready || !validSegment}
          onClick={() => {
            if (player?.playing) player.pause?.();
            else if (line.start_ms !== null && line.end_ms !== null)
              void player?.play(line.start_ms, line.end_ms, repeat);
          }}
        >
          {player?.playing ? "Dừng nghe câu" : "Nghe câu từ đầu"}
        </Button>
        <label className="flex min-h-11 items-center gap-2">
          <input
            type="checkbox"
            checked={repeat}
            disabled={disabled}
            onChange={(e) => {
              player?.pause?.();
              setRepeat(e.target.checked);
            }}
          />
          Lặp câu
        </label>
        <label className="flex items-center gap-2">
          Tốc độ căn
          <select
            aria-label="Tốc độ căn"
            className="min-h-11 rounded border border-border px-2"
            value={player?.rate ?? 1}
            disabled={disabled || !player?.setRate}
            onChange={(e) => player?.setRate?.(Number(e.target.value))}
          >
            <option value={0.75}>Chậm 0.75×</option>
            <option value={1}>Bình thường 1×</option>
          </select>
        </label>
        <span className="text-sm tabular-nums" aria-label="Thời gian căn tiếng">
          {formatLyricTimestamp(time)}
        </span>
        {onSave && (
          <Button
            variant="secondary"
            className="sm:w-auto"
            disabled={disabled}
            onClick={onSave}
          >
            Lưu nháp khi căn
          </Button>
        )}
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="grid min-w-0 content-start gap-4 rounded-control bg-sky p-4 lg:sticky lg:top-28 lg:self-start">
          <p className="text-sm font-bold">Xem chữ chạy theo nhạc</p>
          <p
            className="break-words text-2xl font-extrabold"
            data-testid="syllable-editor-preview"
          >
            <SyllableLyrics line={line} currentMs={time} />
          </p>
          <div className="flex flex-wrap gap-2" aria-label="Chọn tiếng để căn">
            {units.map((s, i) => (
              <button
                type="button"
                key={s.id}
                data-unit-id={s.id}
                aria-label={`Chọn tiếng ${i + 1}: ${s.text}`}
                aria-pressed={index === i}
                className={`min-h-11 min-w-11 max-w-full break-words rounded-control border-2 px-3 py-2 ${index === i ? "border-primary bg-white font-bold" : "border-transparent bg-white/70"}`}
                disabled={disabled}
                onFocus={() => setSelected(i)}
                onClick={() => setSelected(i)}
              >
                {s.text}
              </button>
            ))}
          </div>
          <p className="text-sm">
            Chọn vùng căn tiếng này để dùng Space đánh dấu đầu tiếng rồi chuyển
            tiếp; E đặt cuối tiếng, Z hoàn tác. Cuối tiếng trước được gợi ý từ
            đầu tiếng sau; hãy nghe duyệt lại.
          </p>
        </div>
        <fieldset disabled={disabled} className="grid min-w-0 gap-3">
          <legend className="mb-3 font-bold">
            {unit
              ? `Tiếng ${index + 1}/${units.length}: ${unit.text}`
              : "Chưa có tiếng"}
          </legend>
          {unit && (
            <>
              <label className="grid gap-2">
                Nội dung tiếng đang chọn
                <input
                  aria-label="Nội dung tiếng đang chọn"
                  className={karaokeInputClass}
                  value={unit.text}
                  maxLength={300}
                  onChange={(e) =>
                    changeUnit({
                      text: e.target.value.normalize("NFC"),
                      start_ms: null,
                      end_ms: null,
                    })
                  }
                />
              </label>
              {(
                [
                  ["start_ms", "Bắt đầu tiếng"],
                  ["end_ms", "Kết thúc tiếng"],
                ] as const
              ).map(([edge, label]) => (
                <div key={edge} className="grid gap-2">
                  <label className="grid gap-2">
                    {label} (ms)
                    <input
                      aria-label={`${label} (ms)`}
                      type="number"
                      min={0}
                      max={duration ?? 300000}
                      className={karaokeInputClass}
                      value={unit[edge] ?? ""}
                      onChange={(e) =>
                        changeUnit({
                          [edge]:
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {[-100, -50, 50, 100].map((delta) => (
                      <Button
                        key={delta}
                        variant="quiet"
                        className="sm:w-auto"
                        disabled={unit[edge] === null}
                        onClick={() => {
                          const value = unit[edge];
                          if (value !== null)
                            changeUnit({
                              [edge]: Math.max(
                                0,
                                Math.min(duration ?? 300000, value + delta),
                              ),
                            });
                        }}
                      >
                        {label} {delta > 0 ? "+" : ""}
                        {delta} ms
                      </Button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  className="sm:w-auto"
                  disabled={!player?.ready}
                  onClick={() => mark("start_ms", true)}
                >
                  Đánh dấu tiếng tiếp theo
                </Button>
                <Button
                  className="sm:w-auto"
                  variant="secondary"
                  disabled={!player?.ready}
                  onClick={() => mark("end_ms")}
                >
                  Đánh dấu cuối tiếng
                </Button>
                <Button
                  className="sm:w-auto"
                  variant="secondary"
                  onClick={() => {
                    const parts = splitSyllables(unit.text);
                    if (parts.length < 2) return;
                    commit({
                      ...line,
                      syllables: [
                        ...units.slice(0, index),
                        ...parts,
                        ...units.slice(index + 1),
                      ],
                    });
                  }}
                  disabled={!/\p{White_Space}/u.test(unit.text)}
                >
                  Tách cụm thành tiếng
                </Button>
                <Button
                  className="sm:w-auto"
                  variant="secondary"
                  disabled={index >= units.length - 1}
                  onClick={() => {
                    const next = units[index + 1];
                    if (!next) return;
                    commit({
                      ...line,
                      syllables: [
                        ...units.slice(0, index),
                        {
                          ...unit,
                          text: `${unit.text} ${next.text}`,
                          start_ms: null,
                          end_ms: null,
                        },
                        ...units.slice(index + 2),
                      ],
                    });
                  }}
                >
                  Gộp với tiếng sau
                </Button>
              </div>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              className="sm:w-auto"
              disabled={!undo.length}
              onClick={undoLast}
            >
              Hoàn tác căn tiếng
            </Button>
            <Button
              variant="quiet"
              className="sm:w-auto"
              onClick={() => {
                if (
                  window.confirm("Tách lại tiếng và xóa mốc tiếng của câu này?")
                ) {
                  player?.pause?.();
                  commit({ ...line, syllables: splitSyllables(line.text) });
                  setSelected(0);
                }
              }}
            >
              Tách lại và căn lại câu
            </Button>
          </div>
          <label className="grid gap-2">
            Sao chép mốc từ câu giống lời
            <select
              aria-label="Sao chép mốc từ câu giống lời"
              className={karaokeInputClass}
              value={copyFrom}
              onChange={(e) => setCopyFrom(e.target.value)}
            >
              <option value="">Chọn câu nguồn</option>
              {lines
                .filter(
                  (l) =>
                    l.id !== line.id &&
                    l.syllables?.length &&
                    canonicalLyricText(l.text) ===
                      canonicalLyricText(line.text),
                )
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    Dòng {lines.indexOf(l) + 1}:{" "}
                    {formatLyricTimestamp(l.start_ms)}
                  </option>
                ))}
            </select>
          </label>
          <Button
            variant="secondary"
            className="sm:w-auto"
            disabled={!copyFrom}
            onClick={() => {
              const source = lines.find((l) => l.id === copyFrom);
              const next = source ? copySyllableTiming(source, line) : null;
              if (next)
                commit(
                  next,
                  "Đã dịch mốc theo đầu câu đích. Hãy nghe duyệt lại.",
                );
              else setNotice("Cần mốc bắt đầu ở cả hai câu để sao chép.");
            }}
          >
            Sao chép và dịch mốc
          </Button>
        </fieldset>
      </div>
      {notice && (
        <p role="status" className="rounded-control bg-sky p-3 text-sm">
          {notice}
        </p>
      )}
      {issues.length > 0 && (
        <ul className="grid gap-1 text-sm" aria-label="Lỗi căn tiếng">
          {issues.slice(0, 12).map((issue, i) => (
            <li key={i}>
              <button
                type="button"
                className="min-h-11 text-left text-primary underline"
                onClick={() => {
                  const at = units.findIndex((s) => s.id === issue.syllableId);
                  if (at >= 0) setSelected(at);
                  root.current?.focus();
                }}
              >
                {issue.syllableId
                  ? `Tiếng ${units.findIndex((s) => s.id === issue.syllableId) + 1}: `
                  : ""}
                {issue.message}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
