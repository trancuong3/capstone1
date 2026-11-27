"use client";

import { Flame, Headphones, Music2, RotateCcw, Sparkles, Star } from "lucide-react";
import { Button } from "@/components/common/button";
import { useTranslations } from "@/hooks/use-i18n";
import type {
  LiveSingingScore,
  LiveWordState,
} from "@/lib/karaoke/live-singing-score";
import type { DspFrame } from "@/lib/karaoke/musical-dsp";
import type {
  ProKaraokeRank,
  ProKaraokeScore,
  TargetNoteSpan,
} from "@/lib/karaoke/pro-karaoke-scoring";

const wordBadgeClass: Record<LiveWordState, string> = {
  matched: "border-green-500 bg-green-100 text-green-900",
  different:
    "border-red-500 bg-red-100 text-red-900 underline decoration-red-600",
  omitted: "border-orange-400 bg-orange-100 text-orange-900",
  unknown: "border-slate-200 bg-slate-100 text-slate-500",
};

const rankBadgeClass: Record<ProKaraokeRank, string> = {
  S: "border-amber-400 bg-gradient-to-br from-amber-300 via-yellow-200 to-amber-400 text-amber-950 shadow-sm",
  "A+": "border-emerald-400 bg-gradient-to-br from-emerald-200 to-teal-300 text-emerald-950",
  A: "border-sky-400 bg-gradient-to-br from-sky-200 to-indigo-200 text-indigo-950",
  B: "border-violet-300 bg-violet-100 text-violet-900",
  C: "border-orange-300 bg-orange-100 text-orange-900",
};

function encouragementKey(points: number): string {
  if (points >= 90) return "karaoke.score.praise90";
  if (points >= 70) return "karaoke.score.praise70";
  if (points >= 50) return "karaoke.score.praise50";
  return "karaoke.score.praiseLow";
}

function SongPitchOverviewChart({
  targetNotes,
  dspFrames,
  durationMs,
  keyShift,
}: {
  targetNotes: readonly TargetNoteSpan[];
  dspFrames: readonly DspFrame[];
  durationMs: number;
  keyShift: number;
}) {
  const voicedFrames = dspFrames.filter(
    (f) => f.voiced && !f.isHumLike && f.midiNote !== null,
  );
  if (!targetNotes.length && !voicedFrames.length) return null;

  const maxTime = Math.max(
    durationMs,
    targetNotes[targetNotes.length - 1]?.endMs ?? 1000,
    voicedFrames[voicedFrames.length - 1]?.timeMs ?? 1000,
    1000,
  );
  const targetMidis = targetNotes.map((n) => n.midi + keyShift);
  const targetCenterMidi =
    targetMidis.length > 0
      ? [...targetMidis].sort((a, b) => a - b)[Math.floor(targetMidis.length / 2)]
      : null;
  const foldNearTarget = (midi: number) => {
    if (targetCenterMidi === null) return midi;
    let folded = midi;
    while (folded - targetCenterMidi > 6.5) folded -= 12;
    while (folded - targetCenterMidi < -6.5) folded += 12;
    return folded;
  };
  const allMidis: number[] = [...targetMidis];
  for (const f of voicedFrames) {
    if (f.midiNote !== null) allMidis.push(foldNearTarget(f.midiNote));
  }
  const minMidi = Math.min(...allMidis) - 3;
  const maxMidi = Math.max(...allMidis) + 3;
  const span = Math.max(12, maxMidi - minMidi);
  const W = 520;
  const H = 112;
  const toX = (ms: number) => Math.max(4, Math.min(W - 4, (ms / maxTime) * W));
  const toY = (midi: number) =>
    Math.max(8, Math.min(H - 8, H - ((midi - minMidi) / span) * (H - 16) - 8));

  const stride = Math.max(1, Math.floor(voicedFrames.length / 180));
  const sampled = voicedFrames.filter((_, idx) => idx % stride === 0);

  return (
    <div
      data-testid="karaoke-pitch-overview-chart"
      className="grid gap-1.5 rounded-control border border-indigo-200 bg-slate-950 p-3 text-start text-white"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold">
        <span className="inline-flex items-center gap-1 text-sky-200">
          <Music2 aria-hidden className="size-3.5" />
          Tổng quan đường tông cả bài
        </span>
        <span className="flex items-center gap-3 text-[10px] text-slate-300">
          {targetNotes.length > 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="inline-block h-2 w-4 rounded-full bg-sky-400/80" />
              Giai điệu mẫu
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <span className="inline-block size-2 rounded-full bg-emerald-400" />
            Giọng bé
          </span>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-24 w-full overflow-visible"
        role="img"
        aria-label="Biểu đồ so sánh giai điệu mẫu và giọng hát của bé"
      >
        <line
          x1={0}
          y1={H * 0.25}
          x2={W}
          y2={H * 0.25}
          stroke="rgba(148,163,184,0.18)"
          strokeDasharray="3 4"
        />
        <line
          x1={0}
          y1={H * 0.5}
          x2={W}
          y2={H * 0.5}
          stroke="rgba(148,163,184,0.18)"
          strokeDasharray="3 4"
        />
        <line
          x1={0}
          y1={H * 0.75}
          x2={W}
          y2={H * 0.75}
          stroke="rgba(148,163,184,0.18)"
          strokeDasharray="3 4"
        />
        {targetNotes.map((n, idx) => {
          const x = toX(n.startMs);
          const w = Math.max(3, toX(n.endMs) - x);
          const y = toY(n.midi + keyShift);
          return (
            <rect
              key={`${n.startMs}-${idx}`}
              x={x}
              y={y - 3}
              width={w}
              height={6}
              rx={3}
              fill="rgba(56, 189, 248, 0.72)"
            />
          );
        })}
        {sampled.map((fr, idx) => (
          <circle
            key={`${fr.timeMs}-${idx}`}
            cx={toX(fr.timeMs)}
            cy={toY(foldNearTarget(fr.midiNote!))}
            r={2.2}
            fill="#34D399"
          />
        ))}
      </svg>
    </div>
  );
}

function PillarRow({
  label,
  score,
  weightPct,
  insight,
  colorClass,
}: {
  label: string;
  score: number | null;
  weightPct: number;
  insight: string;
  colorClass: string;
}) {
  return (
    <div className="grid gap-1 rounded-control border border-border bg-slate-50/80 p-3 text-start">
      <div className="flex items-center justify-between gap-2 text-sm font-extrabold">
        <span className="text-ink">
          {label}{" "}
          {weightPct > 0 && (
            <span className="text-xs font-semibold text-muted">
              ({weightPct}%)
            </span>
          )}
        </span>
        <span className="tabular-nums text-primary">
          {score !== null ? `${score}/100` : "Chưa đo"}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className={`h-full rounded-full transition-all ${score !== null ? colorClass : "bg-slate-300"}`}
          style={{ width: `${score ?? 0}%` }}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted">{insight}</p>
    </div>
  );
}

export function KaraokeScoreCard({
  score,
  proScore = null,
  targetNotes = [],
  dspFrames = [],
  durationMs = 0,
  replayAudioUrl = null,
  practice = false,
  onPractice,
  onApplySuggestedKeyShift,
}: {
  score: LiveSingingScore | null;
  proScore?: ProKaraokeScore | null;
  targetNotes?: readonly TargetNoteSpan[];
  dspFrames?: readonly DspFrame[];
  durationMs?: number;
  replayAudioUrl?: string | null;
  practice?: boolean;
  onPractice?: (lineId: string) => void;
  onApplySuggestedKeyShift?: (nextShift: number) => void;
}) {
  const t = useTranslations("entertainment");
  const hasProAcoustic = Boolean(
    proScore &&
      proScore.kind === "scored" &&
      (proScore.activePillars.pitch || proScore.activePillars.rhythm) &&
      !practice,
  );

  const overallAccuracy = score?.overallAccuracy ?? null;
  const matchedWords = score?.matchedWords ?? 0;
  const evaluatedWords = score?.evaluatedWords ?? 0;
  const totalWords = score?.totalWords ?? 0;

  const lyricsPoints =
    overallAccuracy ??
    (!practice && score?.kind === "partial" && evaluatedWords > 0
      ? Math.round((100 * matchedWords) / evaluatedWords)
      : null);

  const allWords = score?.lineScores.flatMap((line) => line.words) ?? [];
  const differentWords = allWords.filter((w) => w.state === "different").length;
  const omittedWords = allWords.filter((w) => w.state === "omitted").length;
  const errorLine = score?.lineScores.find((line) =>
    line.words.some(
      (word) => word.state === "different" || word.state === "omitted",
    ),
  );
  const unheardLine = score?.lineScores.find((line) =>
    line.words.some((word) => word.state === "unknown"),
  );
  const suggested = errorLine ?? unheardLine;
  const unassessedWords = Math.max(0, totalWords - evaluatedWords);

  return (
    <section
      aria-label={t("karaoke.score.regionAria")}
      data-testid="karaoke-score-card"
      className="mx-auto grid w-full max-w-2xl gap-4 rounded-card border border-border bg-white p-5 text-center shadow-sm"
    >
      {/* PRO 3-PILLAR HEADER (when acoustic DSP captured real singing) */}
      {hasProAcoustic && proScore && proScore.totalScore !== null && proScore.rank ? (
        <div
          data-testid="karaoke-pro-score-header"
          className="grid gap-3 rounded-2xl border border-primary/20 bg-gradient-to-b from-sky/70 via-white to-cream/50 p-4"
        >
          <div className="flex flex-wrap items-center justify-center gap-3">
            <span
              data-testid="karaoke-pro-rank"
              className={`grid size-16 place-items-center rounded-2xl border-2 text-3xl font-black ${rankBadgeClass[proScore.rank]}`}
            >
              {proScore.rank}
            </span>
            <div className="text-start">
              <p className="text-xs font-extrabold uppercase tracking-wide text-primary">
                Tổng điểm thực lực Karaoke
              </p>
              <p
                data-testid="karaoke-pro-total-score"
                className="text-5xl font-black leading-none text-primary tabular-nums"
              >
                {proScore.totalScore}
                <span className="text-xl font-bold text-muted">/100</span>
              </p>
            </div>
            {proScore.maxCombo >= 2 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-950">
                <Flame aria-hidden className="size-4 text-amber-600" />
                Chuỗi chuẩn tối đa: x{proScore.maxCombo}
              </span>
            )}
          </div>

          <div aria-hidden className="flex justify-center gap-1.5 text-amber-600">
            {Array.from({ length: 5 }, (_, i) => (
              <Star
                key={i}
                className={
                  i < proScore.stars
                    ? "size-8 fill-amber-300 text-amber-500 drop-shadow-xs"
                    : "size-8 opacity-25"
                }
              />
            ))}
          </div>

          <p className="text-base font-extrabold text-ink">
            <Sparkles
              aria-hidden
              className="me-1 inline size-4 text-amber-500"
            />
            {proScore.headlineVi}
          </p>

          {/* 3-Pillar Visual Breakdown */}
          <div
            data-testid="karaoke-pro-pillars"
            className="grid gap-2.5 sm:grid-cols-3"
          >
            <PillarRow
              label="Tông giọng"
              score={proScore.pitchScore}
              weightPct={Math.round(proScore.weights.pitch * 100)}
              insight={proScore.pitchInsightVi}
              colorClass="bg-gradient-to-r from-emerald-500 to-teal-400"
            />
            <PillarRow
              label="Nhịp điệu"
              score={proScore.rhythmScore}
              weightPct={Math.round(proScore.weights.rhythm * 100)}
              insight={proScore.rhythmInsightVi}
              colorClass="bg-gradient-to-r from-sky-500 to-indigo-500"
            />
            <PillarRow
              label="Đúng lời"
              score={proScore.lyricsScore}
              weightPct={Math.round(proScore.weights.lyrics * 100)}
              insight={proScore.lyricsInsightVi}
              colorClass="bg-gradient-to-r from-violet-500 to-fuchsia-500"
            />
          </div>

          {proScore.suggestedKeyShift !== null && onApplySuggestedKeyShift && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-amber-300 bg-amber-50 px-3 py-2 text-start text-xs font-bold text-amber-950">
              <span>
                Gợi ý: thử chỉnh tông sang{" "}
                <strong>
                  {proScore.suggestedKeyShift > 0
                    ? `+${proScore.suggestedKeyShift}`
                    : proScore.suggestedKeyShift}{" "}
                  bán âm
                </strong>{" "}
                cho hợp giọng bé hơn nhé!
              </span>
              <Button
                variant="secondary"
                size="compact"
                className="sm:w-auto"
                onClick={() =>
                  onApplySuggestedKeyShift(proScore.suggestedKeyShift!)
                }
              >
                Áp dụng tông gợi ý
              </Button>
            </div>
          )}

          {/* Song Pitch Overview Chart */}
          <SongPitchOverviewChart
            targetNotes={targetNotes}
            dspFrames={dspFrames}
            durationMs={durationMs}
            keyShift={proScore.keyShift}
          />

          {/* 1-tap Practice Worst Line */}
          {onPractice && proScore.worstLine && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-orange-300 bg-orange-50 p-3 text-start">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-extrabold text-orange-900">
                  Câu nên luyện thêm nhất · Câu {proScore.worstLine.lineIndex + 1}
                </p>
                <p
                  className="viread-learning-content truncate text-sm font-bold text-ink"
                  dir="ltr"
                  lang="vi"
                >
                  {proScore.worstLine.text}
                </p>
                <p className="text-xs text-orange-900">
                  {proScore.worstLine.tipVi}
                </p>
              </div>
              <Button
                variant="primary"
                className="sm:w-auto"
                data-testid="karaoke-practice-worst-line-btn"
                onClick={() => onPractice(proScore.worstLine!.lineId)}
              >
                <RotateCcw aria-hidden className="size-4" />
                Luyện ngay câu cần cải thiện nhất
              </Button>
            </div>
          )}

          {/* Per-line 3D Mini-Scores */}
          {onPractice && proScore.lineScores.length > 0 && (
            <details className="rounded-control border border-border bg-white p-3 text-start">
              <summary className="cursor-pointer text-sm font-bold text-primary">
                Xem điểm chi tiết 3 trụ cột từng câu ({proScore.lineScores.length} câu)
              </summary>
              <ol className="mt-2.5 grid max-h-64 gap-2 overflow-y-auto">
                {proScore.lineScores.map((line) => (
                  <li
                    key={line.lineId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-border bg-cream/40 p-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-extrabold text-primary">
                        Câu {line.lineIndex + 1}
                        {line.overallScore !== null
                          ? ` · ${line.overallScore}/100`
                          : ""}
                      </p>
                      <p
                        className="viread-learning-content text-sm font-semibold text-ink"
                        dir="ltr"
                        lang="vi"
                      >
                        {line.text}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] font-bold">
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-900">
                          Tông: {line.pitchScore !== null ? line.pitchScore : "—"}
                        </span>
                        <span className="rounded-full bg-sky-100 px-2 py-0.5 text-sky-900">
                          Nhịp: {line.rhythmScore !== null ? line.rhythmScore : "—"}
                        </span>
                        <span className="rounded-full bg-violet-100 px-2 py-0.5 text-violet-900">
                          Lời: {line.lyricsScore !== null ? line.lyricsScore : "—"}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="compact"
                      className="sm:w-auto"
                      onClick={() => onPractice(line.lineId)}
                    >
                      Luyện câu này
                    </Button>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </div>
      ) : null}

      {/* LOCAL-ONLY VOCAL REPLAY (never uploaded, revoked on unmount/reset) */}
      {replayAudioUrl && !practice && (
        <div
          data-testid="karaoke-local-vocal-replay"
          className="grid gap-2 rounded-control border border-emerald-200 bg-emerald-50/70 p-3 text-start"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-extrabold text-emerald-950">
            <span className="inline-flex items-center gap-1.5">
              <Headphones aria-hidden className="size-4 text-emerald-700" />
              Nghe lại giọng hát vừa thu của bé
            </span>
            <span className="text-[11px] font-semibold text-emerald-800">
              Chỉ lưu tạm trên máy của bé, không gửi lên mạng
            </span>
          </div>
          <audio
            controls
            preload="metadata"
            src={replayAudioUrl}
            className="h-10 w-full"
          />
        </div>
      )}

      {/* CLASSIC LYRICS SCORE CARD (kept 100% intact for lyrics-only & practice line tests) */}
      {score && (
        <>
          {!hasProAcoustic && lyricsPoints !== null && (
            <div className="grid gap-1">
              <p className="font-bold">
                {score.kind === "whole"
                  ? t("karaoke.score.wholePointsTitle")
                  : t("karaoke.score.partialPointsTitle")}
              </p>
              <p className="text-5xl font-extrabold text-primary">
                {lyricsPoints}/100
              </p>
              <p className="text-sm font-semibold text-primary">
                {t(encouragementKey(lyricsPoints))}
              </p>
            </div>
          )}
          {!hasProAcoustic && lyricsPoints !== null && (
            <div
              aria-hidden
              className="flex justify-center gap-1 text-amber-700"
            >
              {Array.from({ length: 5 }, (_, i) => (
                <Star
                  key={i}
                  className={
                    i < Math.round(lyricsPoints / 20)
                      ? "size-7 fill-amber-300"
                      : "size-7 opacity-30"
                  }
                />
              ))}
            </div>
          )}
          <p role="status" className="font-bold">
            {score.kind === "insufficient"
              ? t("karaoke.score.insufficient")
              : t("karaoke.score.matchedSummary", {
                  matched: matchedWords,
                  evaluated: evaluatedWords,
                })}
          </p>
          {unassessedWords > 0 && (
            <p className="text-sm text-muted">
              {t("karaoke.score.unassessedNote", { count: unassessedWords })}
            </p>
          )}
          {evaluatedWords > 0 && (
            <>
              <p className="text-sm text-muted">
                {t("karaoke.score.evaluatedTotal", {
                  evaluated: evaluatedWords,
                  total: totalWords,
                })}
              </p>
              <div
                data-testid="karaoke-score-breakdown"
                className="grid grid-cols-3 gap-2 text-xs font-bold sm:text-sm"
              >
                <div className="rounded-control border border-green-400 bg-green-50 p-2 text-green-900">
                  <span className="block">{t("karaoke.score.matchedBox")}</span>
                  <span className="text-lg font-extrabold">{matchedWords}</span>
                </div>
                <div className="rounded-control border border-red-400 bg-red-50 p-2 text-red-900">
                  <span className="block">{t("karaoke.score.wrongBox")}</span>
                  <span className="text-lg font-extrabold">
                    {differentWords}
                  </span>
                </div>
                <div className="rounded-control border border-orange-400 bg-orange-50 p-2 text-orange-900">
                  <span className="block">{t("karaoke.score.omittedBox")}</span>
                  <span className="text-lg font-extrabold">{omittedWords}</span>
                </div>
              </div>
            </>
          )}
          {practice && score.lineScores.length === 1 && evaluatedWords > 0 && (
            <div
              aria-hidden="true"
              className="viread-learning-content flex flex-wrap justify-center gap-1.5 pt-1 text-sm font-bold"
              dir="ltr"
              lang="vi"
            >
              {score.lineScores[0].words.map((word) => (
                <span
                  key={word.id}
                  data-word-chip={word.state}
                  className={`rounded border px-2 py-0.5 ${wordBadgeClass[word.state]}`}
                >
                  {word.text}
                </span>
              ))}
            </div>
          )}
          {!hasProAcoustic && onPractice && suggested && (
            <Button
              variant="secondary"
              onClick={() => onPractice(suggested.lineId)}
            >
              {errorLine
                ? t("karaoke.score.practiceErrorLine", {
                    number: suggested.lineIndex + 1,
                  })
                : t("karaoke.score.practiceUnheardLine", {
                    number: suggested.lineIndex + 1,
                  })}
            </Button>
          )}
          {onPractice && score.lineScores.length > 1 && (
            <details className="text-start">
              <summary className="cursor-pointer py-2 font-bold">
                {t("karaoke.score.viewLinesSummary")}
              </summary>
              <ol className="grid max-h-72 gap-2 overflow-y-auto">
                {score.lineScores.map((line) => (
                  <li key={line.lineId}>
                    <button
                      type="button"
                      className="min-h-12 w-full rounded-control border border-border p-2 text-start"
                      onClick={() => onPractice(line.lineId)}
                    >
                      <span className="block font-bold">
                        {t("karaoke.score.linePrefix", {
                          number: line.lineIndex + 1,
                        })}
                        <span
                          className="viread-learning-content"
                          dir="ltr"
                          lang="vi"
                        >
                          {line.lineText}
                        </span>
                      </span>
                      {line.evaluatedWords > 0 && (
                        <span
                          aria-hidden="true"
                          className="viread-learning-content my-1.5 flex flex-wrap gap-1 text-xs font-semibold"
                          dir="ltr"
                          lang="vi"
                        >
                          {line.words.map((word) => (
                            <span
                              key={word.id}
                              data-word-chip={word.state}
                              className={`rounded border px-1.5 py-0.5 ${wordBadgeClass[word.state]}`}
                            >
                              {word.text}
                            </span>
                          ))}
                        </span>
                      )}
                      {line.evaluatedWords
                        ? t("karaoke.score.lineMatchedRetry", {
                            matched: line.matchedWords,
                            evaluated: line.evaluatedWords,
                          })
                        : t("karaoke.score.lineUnheardRetry")}
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}

      {/* Insufficient acoustic guidance when no lyrics score exists */}
      {!score && proScore?.kind === "insufficient" && (
        <p role="status" className="text-sm font-bold text-amber-900">
          {proScore.headlineVi}
        </p>
      )}
    </section>
  );
}
