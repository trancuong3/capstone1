import {
  Fragment,
  memo,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import type { KaraokeLine, KaraokeSyllable } from "@/types/karaoke";
import type {
  LiveLineScore,
  LiveWordState,
} from "@/lib/karaoke/live-singing-score";
import { syllableProgress } from "@/lib/karaoke/syllable-timing";
import { splitSingingText } from "@/lib/karaoke/singing-text";
import type { ClockListener } from "@/hooks/use-karaoke-player";
import styles from "./syllable-lyrics.module.css";

function renderMarkedTokens(
  text: string,
  unitId: string,
  hasAnyEvidence: boolean,
  stateById: ReadonlyMap<string, LiveWordState>,
  phaseById: ReadonlyMap<string, string | undefined>,
  previewWords?: ReadonlyMap<string, LiveWordState>,
) {
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
          <span className="sr-only"> (đã nghe khớp)</span>
        </span>
      );
    }
    if (committed === "different") {
      return (
        <span key={index} className={styles.wrong} data-word-state="different">
          {part}
          <span className="sr-only"> (chưa đúng lời)</span>
        </span>
      );
    }
    if (committed === "omitted") {
      return (
        <span key={index} className={styles.omitted} data-word-state="omitted">
          {part}
          <span className="sr-only"> (bỏ qua)</span>
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
          <span className="sr-only"> (đang xử lý)</span>
        </span>
      );
    }
    return part;
  });
}

function resolveUnitRecognition(
  unitId: string,
  text: string,
  hasAnyEvidence: boolean,
  stateById: ReadonlyMap<string, LiveWordState>,
  phaseById: ReadonlyMap<string, string | undefined>,
  previewWords?: ReadonlyMap<string, LiveWordState>,
): string | undefined {
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

const SyllableUnit = memo(function SyllableUnit({
  unit,
  currentMs,
  highlightActive,
  hasAnyEvidence,
  stateById,
  phaseById,
  previewWords,
  registerRef,
}: {
  unit: KaraokeSyllable;
  currentMs: number;
  highlightActive: boolean;
  hasAnyEvidence: boolean;
  stateById: ReadonlyMap<string, LiveWordState>;
  phaseById: ReadonlyMap<string, string | undefined>;
  previewWords?: ReadonlyMap<string, LiveWordState>;
  registerRef?: (id: string, node: HTMLSpanElement | null) => void;
}) {
  const active =
    unit.start_ms !== null &&
    unit.end_ms !== null &&
    unit.start_ms <= currentMs &&
    currentMs < unit.end_ms;
  const progress = syllableProgress(unit, currentMs);
  const recognition = resolveUnitRecognition(
    unit.id,
    unit.text,
    hasAnyEvidence,
    stateById,
    phaseById,
    previewWords,
  );
  const marked = useMemo(
    () =>
      renderMarkedTokens(
        unit.text,
        unit.id,
        hasAnyEvidence,
        stateById,
        phaseById,
        previewWords,
      ),
    [unit.text, unit.id, hasAnyEvidence, stateById, phaseById, previewWords],
  );
  return (
    <span
      ref={registerRef ? (node) => registerRef(unit.id, node) : undefined}
      className={`${styles.unit} ${active ? styles.active : ""} ${highlightActive ? styles.highlight : ""}`}
      data-syllable-id={unit.id}
      data-state={active ? "active" : progress >= 1 ? "past" : "upcoming"}
      data-recognition={recognition}
      style={{ "--karaoke-fill": `${progress * 100}%` } as CSSProperties}
    >
      <span>{marked}</span>
      <span aria-hidden="true" className={styles.fill}>
        {unit.text}
      </span>
    </span>
  );
});

export const SyllableLyrics = memo(function SyllableLyrics({
  line,
  currentMs,
  highlightActive = false,
  evidence,
  previewWords,
  subscribeClock,
}: {
  line: KaraokeLine;
  currentMs: number;
  highlightActive?: boolean;
  evidence?: LiveLineScore;
  previewWords?: ReadonlyMap<string, LiveWordState>;
  subscribeClock?: (listener: ClockListener) => () => void;
}) {
  const unitNodes = useRef(new Map<string, HTMLSpanElement>());
  const registerRef = useMemo(
    () => (id: string, node: HTMLSpanElement | null) => {
      if (node) unitNodes.current.set(id, node);
      else unitNodes.current.delete(id);
    },
    [],
  );

  // Ref-driven 60fps CSS custom property updates without React re-renders.
  useEffect(() => {
    if (!subscribeClock || !line.syllables?.length) return;
    const syllables = line.syllables;
    return subscribeClock((ms) => {
      for (let i = 0; i < syllables.length; i++) {
        const unit = syllables[i];
        const node = unitNodes.current.get(unit.id);
        if (!node) continue;
        const progress = syllableProgress(unit, ms);
        const active =
          unit.start_ms !== null &&
          unit.end_ms !== null &&
          unit.start_ms <= ms &&
          ms < unit.end_ms;
        const state = active ? "active" : progress >= 1 ? "past" : "upcoming";
        node.style.setProperty("--karaoke-fill", `${progress * 100}%`);
        if (node.dataset.state !== state) {
          node.dataset.state = state;
          node.classList.toggle(styles.active, active);
        }
      }
    });
  }, [subscribeClock, line]);

  // Keep original punctuation and capitalization while marking each occurrence.
  const { stateById, phaseById, hasAnyEvidence } = useMemo(() => {
    const stateMap = new Map<string, LiveWordState>();
    const phaseMap = new Map<string, string | undefined>();
    for (const word of evidence?.words ?? []) {
      if (word.state !== "unknown") stateMap.set(word.id, word.state);
      phaseMap.set(word.id, word.phase);
    }
    return {
      stateById: stateMap,
      phaseById: phaseMap,
      hasAnyEvidence: Boolean(evidence) || (previewWords?.size ?? 0) > 0,
    };
  }, [evidence, previewWords]);

  if (!line.syllables?.length) {
    const text = renderMarkedTokens(
      line.text,
      line.id,
      hasAnyEvidence,
      stateById,
      phaseById,
      previewWords,
    );
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
      {line.syllables.map((unit, i) => (
        <Fragment key={unit.id}>
          {i > 0 ? " " : null}
          <SyllableUnit
            unit={unit}
            currentMs={currentMs}
            highlightActive={highlightActive}
            hasAnyEvidence={hasAnyEvidence}
            stateById={stateById}
            phaseById={phaseById}
            previewWords={previewWords}
            registerRef={subscribeClock ? registerRef : undefined}
          />
        </Fragment>
      ))}
    </>
  );
});
