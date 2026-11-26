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
      <p className="rounded-control border border-border bg-canvas px-4 py-4 text-sm text-muted">
        {t("sessions.events.empty")}
      </p>
    );
  }

  const retryEvents = events.filter((event) => event.type === "WORD_RETRY");
  const readingEvents = events.filter((event) => event.type !== "WORD_RETRY");

  return (
    <div className="flex flex-col gap-5">
      {retryEvents.length > 0 ? (
        <section
          aria-label={t("sessions.events.retrySectionAria")}
          className="flex flex-col gap-2.5"
        >
          <h3 className="text-base font-extrabold text-ink">
            {t("sessions.events.retrySectionTitle")}
          </h3>
          <ol className="divide-y divide-border rounded-control border border-border bg-white">
            {retryEvents.map((event) => {
              const metadata = event.metadata;
              const attempt = metadata.retry_attempt;
              const originalStatus = metadata.original_status;
              const recognizedText = metadata.recognized_text;
              const targetWord = metadata.target_word;
              return (
                <li className="space-y-1.5 p-3.5 sm:p-4" key={event.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-bold text-ink">
                      {event.status === "CONFIRMED"
                        ? t("sessions.events.retryCorrect")
                        : event.status === "FAILED"
                          ? t("sessions.events.retryFailed")
                          : t("sessions.events.retryUncertain")}
                    </p>
                    <span
                      className={`rounded-control px-2.5 py-0.5 text-xs font-bold ${eventStatusBadgeClass(event.status)}`}
                    >
                      {typeof attempt === "number" && Number.isInteger(attempt)
                        ? t("sessions.events.retryAttempt", { attempt })
                        : t(`sessions.events.statuses.${event.status}`)}
                    </span>
                  </div>
                  <p className="text-sm text-muted">
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
                        : (event.page_revision_word_id ??
                          t("sessions.detail.notRecorded"))}
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
                    <p className="text-sm text-muted">
                      {t("sessions.events.recognizedPrefix", {
                        text: recognizedText,
                      })}
                    </p>
                  ) : null}
                  <p className="text-xs text-muted">
                    {t("sessions.events.pageRevisionMeta", {
                      pageId: event.page_id,
                    })}
                    <code className="break-all">{event.page_revision_id}</code>
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {readingEvents.length > 0 ? (
        <section
          aria-label={t("sessions.events.firstPassSectionAria")}
          className="flex flex-col gap-2.5"
        >
          {retryEvents.length > 0 ? (
            <h3 className="text-base font-extrabold text-ink">
              {t("sessions.events.firstPassSectionTitle")}
            </h3>
          ) : null}
          <ol className="divide-y divide-border rounded-control border border-border bg-white">
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
                <li className="space-y-1.5 p-3.5 sm:p-4" key={event.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-bold text-ink">
                      {t(`sessions.events.types.${event.type}`)}
                    </p>
                    <span
                      className={`rounded-control px-2.5 py-0.5 text-xs font-bold ${eventStatusBadgeClass(event.status)}`}
                    >
                      {t(`sessions.events.statuses.${event.status}`)}
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    {t("sessions.events.timestampAt")}
                    <span className="font-bold tabular-nums text-ink">
                      {t("sessions.events.secondsValue", {
                        seconds: formatNumber(
                          Math.round(event.start_ms / 1000),
                        ),
                      })}
                    </span>
                    {t("sessions.events.versionSeparator")}
                    <code className="break-all">{event.page_revision_id}</code>
                  </p>
                  <p className="text-xs font-semibold text-muted">
                    {countsAsError
                      ? t("sessions.events.confirmedEvidence")
                      : t("sessions.events.supportOrUncertainEvidence")}
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
