"use client";

import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { HistoryEventDTO } from "@/types/reading";

function eventStatusBadgeClass(status: HistoryEventDTO["status"]): string {
  if (status === "CONFIRMED") {
    return "border border-success-ink/20 bg-success-surface text-success-ink";
  }
  if (status === "FAILED") {
    return "border border-warning/25 bg-warning-surface text-warning";
  }
  return "border border-border bg-canvas text-muted";
}

interface SessionEventListProps {
  readonly events: readonly HistoryEventDTO[];
}

export function SessionEventList({ events }: SessionEventListProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reports");

  if (events.length === 0) {
    return (
      <p className="rounded-control bg-canvas/70 px-3 py-2.5 text-xs font-medium text-muted sm:text-sm">
        {t("sessions.events.empty")}
      </p>
    );
  }

  const retryEvents = events.filter((event) => event.type === "WORD_RETRY");
  const readingEvents = events.filter((event) => event.type !== "WORD_RETRY");

  return (
    <div className="flex flex-col gap-3.5">
      {retryEvents.length > 0 ? (
        <section
          aria-label={t("sessions.events.retrySectionAria")}
          className="flex flex-col gap-1.5"
        >
          <h3 className="text-sm font-extrabold text-ink">
            {t("sessions.events.retrySectionTitle")}
          </h3>
          <ol className="divide-y divide-border/70 border-y border-border/70 bg-white">
            {retryEvents.map((event) => {
              const metadata = event.metadata;
              const attempt = metadata.retry_attempt;
              const originalStatus = metadata.original_status;
              const recognizedText = metadata.recognized_text;
              const targetWord = metadata.target_word;
              return (
                <li
                  className="space-y-1 px-2.5 py-2 sm:px-3 sm:py-2.5"
                  key={event.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-bold text-ink">
                      {event.status === "CONFIRMED"
                        ? t("sessions.events.retryCorrect")
                        : event.status === "FAILED"
                          ? t("sessions.events.retryFailed")
                          : t("sessions.events.retryUncertain")}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold leading-tight ${eventStatusBadgeClass(event.status)}`}
                    >
                      {typeof attempt === "number" && Number.isInteger(attempt)
                        ? t("sessions.events.retryAttempt", { attempt })
                        : t(`sessions.events.statuses.${event.status}`)}
                    </span>
                  </div>
                  <p className="text-xs text-muted sm:text-sm">
                    {t("sessions.events.practiceWordLabel")}
                    <strong
                      className={
                        typeof targetWord === "string"
                          ? "viread-learning-content font-bold text-ink"
                          : "font-bold text-ink"
                      }
                      dir={typeof targetWord === "string" ? "ltr" : undefined}
                      lang={typeof targetWord === "string" ? "vi" : undefined}
                    >
                      {typeof targetWord === "string"
                        ? targetWord
                        : t("sessions.detail.notRecorded")}
                    </strong>
                    {typeof originalStatus === "string"
                      ? ` · ${
                          originalStatus === "OMISSION"
                            ? t("sessions.events.originalOmission")
                            : t("sessions.events.originalMispronunciation")
                        }`
                      : ""}
                  </p>
                  {typeof recognizedText === "string" && recognizedText ? (
                    <p className="text-xs text-muted sm:text-sm">
                      {t("sessions.events.recognizedPrefix", {
                        text: recognizedText,
                      })}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {readingEvents.length > 0 ? (
        <section
          aria-label={t("sessions.events.firstPassSectionAria")}
          className="flex flex-col gap-1.5"
        >
          {retryEvents.length > 0 ? (
            <h3 className="text-sm font-extrabold text-ink">
              {t("sessions.events.firstPassSectionTitle")}
            </h3>
          ) : null}
          <ol className="divide-y divide-border/70 border-y border-border/70 bg-white">
            {readingEvents.map((event) => {
              const countsAsError =
                event.status === "CONFIRMED" &&
                [
                  "OMISSION",
                  "REPETITION",
                  "LONG_PAUSE",
                  "SUBSTITUTION",
                ].includes(event.type);

              return (
                <li
                  className="space-y-1 px-2.5 py-2 sm:px-3 sm:py-2.5"
                  key={event.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-bold text-ink">
                      {t(`sessions.events.types.${event.type}`)}
                    </p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-bold leading-tight ${eventStatusBadgeClass(event.status)}`}
                    >
                      {t(`sessions.events.statuses.${event.status}`)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-xs text-muted">
                    <p>
                      {t("sessions.events.timestampAt")}
                      <span className="font-bold tabular-nums text-ink">
                        {t("sessions.events.secondsValue", {
                          seconds: formatNumber(
                            Math.round(event.start_ms / 1000),
                          ),
                        })}
                      </span>
                    </p>
                    <p className="font-semibold">
                      {countsAsError
                        ? t("sessions.events.confirmedEvidence")
                        : t("sessions.events.supportOrUncertainEvidence")}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
