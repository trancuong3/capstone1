import { Fragment, type CSSProperties } from "react";
import type { KaraokeLine } from "@/types/karaoke";
import type { LiveLineScore } from "@/lib/karaoke/live-singing-score";
import { syllableProgress } from "@/lib/karaoke/syllable-timing";
import styles from "./syllable-lyrics.module.css";

export function SyllableLyrics({
  line,
  currentMs,
  highlightActive = false,
  evidence,
}: {
  line: KaraokeLine;
  currentMs: number;
  highlightActive?: boolean;
  evidence?: LiveLineScore;
}) {
  // Keep original punctuation and capitalization while marking each occurrence.
  const matched = new Set(
    evidence?.words
      .filter((word) => word.state === "matched")
      .map((word) => word.id),
  );
  function mark(text: string, unitId: string) {
    if (!matched.size) return text;
    let token = 0;
    return text
      .normalize("NFC")
      .split(/([\p{L}\p{M}\p{N}]+)/gu)
      .map((part, index) => {
        if (!/[\p{L}\p{N}]/u.test(part)) return part;
        const id = unitId + "/" + token++;
        return matched.has(id) ? (
          <span key={index} className={styles.heard} data-heard={id}>
            {part}
            <span className="sr-only"> (đã nghe khớp)</span>
          </span>
        ) : (
          part
        );
      });
  }
  if (!line.syllables?.length) {
    const text = mark(line.text, line.id);
    return highlightActive ? (
      <span className={styles.activeLine} data-state="active">
        {text}
      </span>
    ) : (
      <>{text}</>
    );
  }
  return (
    <>
      {line.syllables?.map((unit, i) => {
        const active =
          unit.start_ms !== null &&
          unit.end_ms !== null &&
          unit.start_ms <= currentMs &&
          currentMs < unit.end_ms;
        const progress = syllableProgress(unit, currentMs);
        return (
          <Fragment key={unit.id}>
            {i > 0 ? " " : null}
            <span
              className={`${styles.unit} ${active ? styles.active : ""} ${highlightActive ? styles.highlight : ""}`}
              data-syllable-id={unit.id}
              data-state={
                active ? "active" : progress >= 1 ? "past" : "upcoming"
              }
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
    </>
  );
}
