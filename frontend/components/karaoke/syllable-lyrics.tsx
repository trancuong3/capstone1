import { Fragment, type CSSProperties } from "react";
import type { KaraokeLine } from "@/types/karaoke";
import { syllableProgress } from "@/lib/karaoke/syllable-timing";
import styles from "./syllable-lyrics.module.css";

export function SyllableLyrics({
  line,
  currentMs,
}: {
  line: KaraokeLine;
  currentMs: number;
}) {
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
              className={`${styles.unit} ${active ? styles.active : ""}`}
              data-syllable-id={unit.id}
              data-state={
                active ? "active" : progress >= 1 ? "past" : "upcoming"
              }
              style={
                { "--karaoke-fill": `${progress * 100}%` } as CSSProperties
              }
            >
              <span>{unit.text}</span>
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
