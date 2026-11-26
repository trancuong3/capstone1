"use client";

import { Fragment, type CSSProperties } from "react";
import { useTranslations } from "@/hooks/use-i18n";
import type { KaraokeLine } from "@/types/karaoke";
import type {
  LiveLineScore,
  LiveWordState,
} from "@/lib/karaoke/live-singing-score";
import { syllableProgress } from "@/lib/karaoke/syllable-timing";
import { splitSingingText } from "@/lib/karaoke/singing-text";
import styles from "./syllable-lyrics.module.css";

export function SyllableLyrics({
  line,
  currentMs,
  highlightActive = false,
  evidence,
  previewWords,
}: {
  line: KaraokeLine;
  currentMs: number;
  highlightActive?: boolean;
  evidence?: LiveLineScore;
  previewWords?: ReadonlyMap<string, LiveWordState>;
}) {
  const t = useTranslations("entertainment");
  // Keep original punctuation and capitalization while marking each occurrence.
  const stateById = new Map<string, LiveWordState>();
  for (const word of evidence?.words ?? []) {
    if (word.state !== "unknown") stateById.set(word.id, word.state);
  }
  const phaseById = new Map(
    evidence?.words.map((word) => [word.id, word.phase]) ?? [],
  );
  const hasAnyEvidence = Boolean(evidence) || (previewWords?.size ?? 0) > 0;

  function mark(text: string, unitId: string) {
    if (!hasAnyEvidence) return text;
    let token = 0;
    return splitSingingText(text).map((part, index) => {
      if (!/[\p{L}\p{N}]/u.test(part)) return part;
      const id = unitId + "/" + token++;
      const committed = stateById.get(id);
      if (committed === "matched") {
        return (
          <span
            key={index}
            className={styles.heard}
            data-heard={id}
            data-word-state="matched"
          >
            {part}
            <span className="sr-only">{t("karaoke.lyrics.wordMatchedSr")}</span>
          </span>
        );
      }
      if (committed === "different") {
        return (
          <span
            key={index}
            className={styles.wrong}
            data-word-state="different"
          >
            {part}
            <span className="sr-only">
              {t("karaoke.lyrics.wordDifferentSr")}
            </span>
          </span>
        );
      }
      if (committed === "omitted") {
        return (
          <span
            key={index}
            className={styles.omitted}
            data-word-state="omitted"
          >
            {part}
            <span className="sr-only">{t("karaoke.lyrics.wordOmittedSr")}</span>
          </span>
        );
      }
      if (previewWords?.has(id) || phaseById.get(id) === "processing") {
        return (
          <span
            key={index}
            className={styles.processing}
            data-word-state="processing"
          >
            {part}
            <span className="sr-only">
              {t("karaoke.lyrics.wordProcessingSr")}
            </span>
          </span>
        );
      }
      return part;
    });
  }

  function unitRecognition(unitId: string, text: string): string | undefined {
    if (!hasAnyEvidence) return undefined;
    let token = 0;
    let found: string | undefined;
    for (const part of splitSingingText(text)) {
      if (!/[\p{L}\p{N}]/u.test(part)) continue;
      const id = unitId + "/" + token++;
      const committed = stateById.get(id);
      if (committed) return committed;
      const preview = previewWords?.get(id);
      if (preview || phaseById.get(id) === "processing") found ??= "processing";
    }
    return found;
  }

  if (!line.syllables?.length) {
    const text = mark(line.text, line.id);
    return (
      <span className="viread-learning-content" dir="ltr" lang="vi">
        {highlightActive ? (
          <span className={styles.activeLine} data-state="active">
            {text}
          </span>
        ) : (
          text
        )}
      </span>
    );
  }
  return (
    <span className="viread-learning-content" dir="ltr" lang="vi">
      {line.syllables?.map((unit, i) => {
        const active =
          unit.start_ms !== null &&
          unit.end_ms !== null &&
          unit.start_ms <= currentMs &&
          currentMs < unit.end_ms;
        const progress = syllableProgress(unit, currentMs);
        const recognition = unitRecognition(unit.id, unit.text);
        return (
          <Fragment key={unit.id}>
            {i > 0 ? " " : null}
            <span
              className={`${styles.unit} ${active ? styles.active : ""} ${highlightActive ? styles.highlight : ""}`}
              data-syllable-id={unit.id}
              data-state={
                active ? "active" : progress >= 1 ? "past" : "upcoming"
              }
              data-recognition={recognition}
              style={
                { "--karaoke-fill": `${progress * 100}%` } as CSSProperties
              }
            >
              <span>{mark(unit.text, unit.id)}</span>
              <span aria-hidden="true" className={styles.fill}>
                {unit.text}
              </span>
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}
