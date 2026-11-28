"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Wind } from "lucide-react";

import {
  annotateBreathingCuesLocal,
  annotateCues,
  type AnnotateCuesResponse,
} from "@/lib/api/fluency-prosody-service";
import { cn } from "@/lib/utils/cn";
import { useProsodyCoachTranslations } from "@/messages/features/prosody_coach";

export interface ProsodyBreathingCuesBarProps {
  readonly text?: string | null;
  readonly annotatedText?: string | null;
  readonly cueResponse?: AnnotateCuesResponse | null;
  readonly defaultExpanded?: boolean;
  readonly fetchRemoteOnExpand?: boolean;
  readonly isLoading?: boolean;
  readonly compact?: boolean;
  readonly className?: string;
}

export function ProsodyBreathingCuesBar({
  text,
  annotatedText,
  cueResponse,
  defaultExpanded = false,
  fetchRemoteOnExpand = false,
  isLoading = false,
  compact = false,
  className,
}: ProsodyBreathingCuesBarProps) {
  const tp = useProsodyCoachTranslations();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [remoteCues, setRemoteCues] = useState<AnnotateCuesResponse | null>(
    null,
  );
  const [fetchingRemote, setFetchingRemote] = useState(false);

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!expanded || !fetchRemoteOnExpand || cueResponse || annotatedText) {
      return;
    }
    const clean = text?.trim() ?? "";
    if (!clean) return;

    const controller = new AbortController();
    // Start fetch asynchronously; setState calls are deferred to promise callbacks
    // so they never run synchronously in the effect body (avoids cascading renders).
    void annotateCues(clean, controller.signal)
      .then((res) => {
        if (!controller.signal.aborted) {
          setFetchingRemote(true);
          setRemoteCues(res);
        }
      })
      .catch(() => {
        // Local deterministic fallback already covers offline or network errors.
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setFetchingRemote(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [annotatedText, cueResponse, expanded, fetchRemoteOnExpand, text]);

  const localFallback = useMemo(() => {
    if (!text?.trim()) return null;
    return annotateBreathingCuesLocal(text);
  }, [text]);

  const resolvedResponse = cueResponse ?? remoteCues ?? localFallback;
  const displayText = annotatedText ?? resolvedResponse?.annotated_text ?? null;
  const showSkeleton = isLoading || (fetchingRemote && !displayText);

  const legendItems = useMemo(
    () => [
      {
        symbol: "•",
        label: tp("legendCommaPause"),
        sublabel: tp("legendCommaSubLabel"),
      },
      {
        symbol: "••",
        label: tp("legendPeriodPause"),
        sublabel: tp("legendPeriodSubLabel"),
      },
      {
        symbol: "↗",
        label: tp("legendRisingCue"),
        sublabel: tp("legendQuestionSubLabel"),
      },
      {
        symbol: "✦",
        label: tp("legendExpressiveCue"),
        sublabel: tp("legendExclaimSubLabel"),
      },
    ],
    [tp],
  );

  return (
    <div
      data-testid="prosody-breathing-cues-bar"
      className={cn(
        compact
          ? "relative inline-block max-w-full text-xs"
          : "rounded-xl border border-sky-200 bg-sky-50/90 text-sm",
        className,
      )}
    >
      <button
        type="button"
        data-testid="prosody-breathing-cues-toggle"
        onClick={toggle}
        aria-expanded={expanded}
        className={cn(
          "flex items-center gap-1.5 text-left font-semibold text-sky-950 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          compact
            ? "inline-flex min-h-9 rounded-full border border-sky-200/90 bg-sky-50/90 px-2.5 py-1 text-xs hover:bg-sky-100/90"
            : "min-h-11 w-full gap-2 rounded-xl px-4 py-2.5 hover:bg-sky-100/80",
        )}
      >
        <Wind className="size-3.5 shrink-0 text-sky-700 sm:size-4" aria-hidden="true" />
        <span className="truncate">{tp("barToggleLabel")}</span>
        {!compact ? (
          <span
            className="hidden items-center gap-1 rounded-full bg-white/85 px-2 py-0.5 text-xs font-bold text-sky-800 sm:inline-flex"
            aria-hidden="true"
          >
            • · •• · ↗ · ✦
          </span>
        ) : null}
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs font-medium text-sky-700",
            !compact && "ms-auto",
          )}
        >
          {!compact ? (
            <span>{expanded ? tp("barHideHint") : tp("barShowHint")}</span>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 transition-transform sm:size-4",
              expanded && "rotate-180",
            )}
          />
        </span>
      </button>

      {expanded ? (
        <div
          data-testid="prosody-breathing-cues-panel"
          className={cn(
            "space-y-2.5",
            compact
              ? "absolute end-0 top-full z-30 mt-1.5 w-[min(92vw,540px)] max-h-[45dvh] overflow-y-auto rounded-2xl border border-sky-200 bg-white/98 p-3 shadow-lg"
              : "border-t border-sky-200/80 px-3.5 pb-3.5 pt-2.5",
          )}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {legendItems.map(({ symbol, label, sublabel }) => {
              const count = resolvedResponse?.cue_counts?.[symbol];
              return (
                <div
                  key={symbol}
                  className="flex flex-col items-center rounded-lg border border-sky-100 bg-white px-2 py-2 text-center shadow-2xs"
                >
                  <span
                    className="mb-0.5 text-base font-extrabold leading-none text-sky-700"
                    aria-hidden="true"
                  >
                    {symbol}
                  </span>
                  <span className="text-xs font-semibold leading-tight text-ink">
                    {label}
                  </span>
                  <span className="text-[11px] leading-tight text-muted">
                    ({sublabel}
                    {typeof count === "number" && count > 0
                      ? ` · ${count}`
                      : ""}
                    )
                  </span>
                </div>
              );
            })}
          </div>

          {showSkeleton ? (
            <div
              data-testid="prosody-cues-loading"
              className="h-11 animate-pulse rounded-lg bg-sky-100"
            />
          ) : displayText ? (
            <div
              data-testid="prosody-annotated-preview"
              className="viread-learning-content rounded-lg border border-sky-100 bg-white px-3 py-2.5"
              dir="ltr"
              lang="vi"
            >
              <p className="text-sm font-medium leading-relaxed text-ink">
                {displayText.split(/(•{1,2}|↗|✦)/g).map((part, idx) =>
                  /^(•{1,2}|↗|✦)$/.test(part) ? (
                    <span
                      key={idx}
                      data-cue-token={part}
                      className="mx-0.5 inline-flex items-center rounded bg-sky-100 px-1 py-0.5 text-xs font-extrabold text-sky-800"
                    >
                      {part}
                    </span>
                  ) : (
                    <span key={idx}>{part}</span>
                  ),
                )}
              </p>
            </div>
          ) : (
            <p className="text-xs italic text-muted">{tp("barEmptyHint")}</p>
          )}

          <p className="text-xs leading-relaxed text-sky-900">
            <strong>{tp("barTipPrefix")}</strong> {tp("barTipBody")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
