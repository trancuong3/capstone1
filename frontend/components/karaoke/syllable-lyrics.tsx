import { Fragment, type CSSProperties } from "react";
import type { KaraokeLine } from "@/types/karaoke";
import type {
  LiveLineScore,
  LiveWordState,
} from "@/lib/karaoke/live-singing-score";
import { syllableProgress } from "@/lib/karaoke/syllable-timing";
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
  // Keep original punctuation and capitalization while marking each occurrence.
  const stateById = new Map<string, LiveWordState>();
  for (const word of evidence?.words ?? []) {
    if (word.state !== "unknown") stateById.set(word.id, word.state);
  }
  const hasAnyEvidence = stateById.size > 0 || (previewWords?.size ?? 0) > 0;

  function mark(text: string, unitId: string) {
    if (!hasAnyEvidence) return text;
    let token = 0;
    return text
      .normalize("NFC")
      .split(/([\p{L}\p{M}\p{N}]+)/gu)
      .map((part, index) => {
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
              <span className="sr-only"> (đã nghe khớp)</span>
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
              <span className="sr-only"> (chưa đúng lời)</span>
            </span>
          );
        }
        const preview = previewWords?.get(id);
        if (preview === "matched") {
          return (
            <span
              key={index}
              className={styles.previewHeard}
              data-word-state="preview-matched"
            >
              {part}
            </span>
          );
        }
        if (preview === "different") {
          return (
            <span
              key={index}
              className={styles.wrong}
              data-word-state="preview-different"
            >
              {part}
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
              <span className="sr-only"> (bỏ qua)</span>
            </span>
          );
        }
        if (preview === "omitted") {
          return (
            <span
              key={index}
              className={styles.omitted}
              data-word-state="preview-omitted"
            >
              {part}
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
    for (const part of text.normalize("NFC").split(/([\p{L}\p{M}\p{N}]+)/gu)) {
      if (!/[\p{L}\p{N}]/u.test(part)) continue;
      const id = unitId + "/" + token++;
      const committed = stateById.get(id);
      if (committed) return committed;
      const preview = previewWords?.get(id);
      if (preview) found ??= `preview-${preview}`;
    }
    return found;
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
    </>
  );
}
