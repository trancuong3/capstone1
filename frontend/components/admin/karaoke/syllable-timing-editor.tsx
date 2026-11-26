"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/common/button";
import { SyllableLyrics } from "@/components/karaoke/syllable-lyrics";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
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
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
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
  const pause = player?.pause;
  useEffect(() => () => pause?.(), [pause]);
  useEffect(() => {
    if (!getCurrentMs) return;
    let frame = 0;
    const tick = () => {
      setTime(getCurrentMs());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [getCurrentMs]);
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
    setNotice(t("karaoke.syllableEditor.undidNotice"));
  }
  function mark(edge: "start_ms" | "end_ms", advance = false) {
    if (!player?.ready || !unit) return;
    const at = player.getCurrentMs();
    if (
      line.start_ms === null ||
      line.end_ms === null ||
      at < line.start_ms ||
      at > line.end_ms
    ) {
      setNotice(t("karaoke.syllableEditor.setLineBoundsFirst"));
      return;
    }
    commit(
      markSyllable(line, index, edge, at, advance),
      advance
        ? t("karaoke.syllableEditor.markedPreviousEndHint")
        : t("karaoke.syllableEditor.markedPositionNotice"),
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
      aria-label={t("karaoke.syllableEditor.sectionAria", {
        lineNumber: formatNumber(lineNumber),
      })}
      onKeyDown={keyboard}
      className="grid min-w-0 gap-4 rounded-control border-2 border-primary bg-white p-4 focus-visible:outline-3 focus-visible:outline-primary"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-xl font-extrabold">
          {t("karaoke.syllableEditor.heading", {
            lineNumber: formatNumber(lineNumber),
          })}
        </h3>
        <p role="status">
          {t("karaoke.syllableEditor.progressLine", {
            completed: formatNumber(completed),
            total: formatNumber(units.length),
            status: issues.length
              ? t("karaoke.syllableEditor.statusNeedsReview")
              : t("karaoke.syllableEditor.statusValid"),
          })}
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
          {player?.playing
            ? t("karaoke.syllableEditor.stopPlayBtn")
            : t("karaoke.syllableEditor.playFromStartBtn")}
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
          {t("karaoke.syllableEditor.repeatLineBtn")}
        </label>
        <label className="flex items-center gap-2">
          {t("karaoke.syllableEditor.speedLabel")}
          <select
            aria-label={t("karaoke.syllableEditor.speedAria")}
            className="min-h-11 rounded border border-border px-2"
            value={player?.rate ?? 1}
            disabled={disabled || !player?.setRate}
            onChange={(e) => player?.setRate?.(Number(e.target.value))}
          >
            <option value={0.75}>
              {t("karaoke.syllableEditor.speedSlow")}
            </option>
            <option value={1}>{t("karaoke.syllableEditor.speedNormal")}</option>
          </select>
        </label>
        <span
          className="text-sm tabular-nums"
          aria-label={t("karaoke.syllableEditor.currentTimeAria")}
        >
          {formatLyricTimestamp(time)}
        </span>
        {onSave && (
          <Button
            variant="secondary"
            className="sm:w-auto"
            disabled={disabled}
            onClick={onSave}
          >
            {t("karaoke.syllableEditor.saveDraftBtn")}
          </Button>
        )}
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <div className="grid min-w-0 content-start gap-4 rounded-control bg-sky p-4 lg:sticky lg:top-28 lg:self-start">
          <p className="text-sm font-bold">
            {t("karaoke.syllableEditor.previewHeading")}
          </p>
          <p
            className="viread-learning-content break-words text-2xl font-extrabold"
            data-testid="syllable-editor-preview"
            dir="ltr"
            lang="vi"
          >
            <SyllableLyrics line={line} currentMs={time} />
          </p>
          <div
            className="viread-learning-content flex flex-wrap gap-2"
            aria-label={t("karaoke.syllableEditor.selectSyllableAria")}
            dir="ltr"
            lang="vi"
          >
            {units.map((s, i) => (
              <button
                type="button"
                key={s.id}
                data-unit-id={s.id}
                aria-label={t("karaoke.syllableEditor.pickSyllableAria", {
                  num: formatNumber(i + 1),
                  text: s.text,
                })}
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
          <p className="text-sm">{t("karaoke.syllableEditor.keyboardHint")}</p>
        </div>
        <fieldset disabled={disabled} className="grid min-w-0 gap-3">
          <legend className="mb-3 font-bold">
            {unit
              ? t("karaoke.syllableEditor.selectedCounter", {
                  num: formatNumber(index + 1),
                  total: formatNumber(units.length),
                  text: unit.text,
                })
              : t("karaoke.syllableEditor.noSyllable")}
          </legend>
          {unit && (
            <>
              <label className="grid gap-2">
                {t("karaoke.syllableEditor.selectedTextLabel")}
                <input
                  aria-label={t("karaoke.syllableEditor.selectedTextAria")}
                  className={`${karaokeInputClass} viread-learning-content`}
                  dir="ltr"
                  lang="vi"
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
                  ["start_ms", t("karaoke.syllableEditor.startLabel")],
                  ["end_ms", t("karaoke.syllableEditor.endLabel")],
                ] as const
              ).map(([edge, label]) => (
                <div key={edge} className="grid gap-2">
                  <label className="grid gap-2">
                    {t("karaoke.syllableEditor.timeInputAria", { label })}
                    <input
                      aria-label={t("karaoke.syllableEditor.timeInputAria", {
                        label,
                      })}
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
                        {t("karaoke.syllableEditor.deltaStepBtn", {
                          label,
                          delta: `${delta > 0 ? "+" : ""}${delta}`,
                        })}
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
                  {t("karaoke.syllableEditor.markNextBtn")}
                </Button>
                <Button
                  className="sm:w-auto"
                  variant="secondary"
                  disabled={!player?.ready}
                  onClick={() => mark("end_ms")}
                >
                  {t("karaoke.syllableEditor.markEndBtn")}
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
                  {t("karaoke.syllableEditor.splitBtn")}
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
                  {t("karaoke.syllableEditor.mergeNextBtn")}
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
              {t("karaoke.syllableEditor.undoBtn")}
            </Button>
            <Button
              variant="quiet"
              className="sm:w-auto"
              onClick={() => {
                if (
                  window.confirm(t("karaoke.syllableEditor.resplitConfirm"))
                ) {
                  player?.pause?.();
                  commit({ ...line, syllables: splitSyllables(line.text) });
                  setSelected(0);
                }
              }}
            >
              {t("karaoke.syllableEditor.resplitBtn")}
            </Button>
          </div>
          <label className="grid gap-2">
            {t("karaoke.syllableEditor.copyLabel")}
            <select
              aria-label={t("karaoke.syllableEditor.copyAria")}
              className={karaokeInputClass}
              value={copyFrom}
              onChange={(e) => setCopyFrom(e.target.value)}
            >
              <option value="">
                {t("karaoke.syllableEditor.chooseSourceOption")}
              </option>
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
                    {t("karaoke.syllableEditor.sourceLineTimeOption", {
                      num: formatNumber(lines.indexOf(l) + 1),
                      time: formatLyricTimestamp(l.start_ms),
                    })}
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
              if (next) commit(next, t("karaoke.syllableEditor.copiedNotice"));
              else
                setNotice(t("karaoke.syllableEditor.copyMissingBoundsNotice"));
            }}
          >
            {t("karaoke.syllableEditor.copyBtn")}
          </Button>
        </fieldset>
      </div>
      {notice && (
        <p role="status" className="rounded-control bg-sky p-3 text-sm">
          {notice}
        </p>
      )}
      {issues.length > 0 && (
        <ul
          className="grid gap-1 text-sm"
          aria-label={t("karaoke.syllableEditor.issuesAria")}
        >
          {issues.slice(0, 12).map((issue, i) => (
            <li key={i}>
              <button
                type="button"
                className="min-h-11 text-start text-primary underline"
                onClick={() => {
                  const at = units.findIndex((s) => s.id === issue.syllableId);
                  if (at >= 0) setSelected(at);
                  root.current?.focus();
                }}
              >
                {issue.syllableId
                  ? t("karaoke.syllableEditor.syllableIssuePrefix", {
                      num: formatNumber(
                        units.findIndex((s) => s.id === issue.syllableId) + 1,
                      ),
                    })
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
