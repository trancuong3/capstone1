"use client";

import { RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { AdminOcrHardSampleRadarResponseDTO } from "@/types/book-content-quality";

export function AdminOcrHardSampleRadarPanel() {
  const { bookContentQuality } = useAdminServices();
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");
  const { formatNumber } = useI18n();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AdminOcrHardSampleRadarResponseDTO | null>(
    null,
  );
  const [reloadNonce, setReloadNonce] = useState(0);

  const stages = useMemo(
    () => [
      { atPct: 0, label: tCommon("aiProgress.preparing") },
      { atPct: 40, label: tCommon("aiProgress.analyzing") },
      { atPct: 80, label: tCommon("aiProgress.finalizing") },
    ],
    [tCommon],
  );
  const loadProgress = useAiProgress({
    active: loading,
    stages,
    expectedDurationMs: 2_600,
  });

  const refresh = useCallback(() => {
    setReloadNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    void reloadNonce;
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (!active) return null;
        if (!bookContentQuality.getOcrHardSampleRadar) {
          return {
            generated_at: new Date().toISOString(),
            total_candidates: 0,
            catalog_count: 0,
            consented_private_count: 0,
            privacy_policy_version: "FLOW2_OPT_IN_STRICT_V1",
            items: [],
          };
        }
        setLoading(true);
        setError(null);
        return bookContentQuality.getOcrHardSampleRadar({
          limit: 30,
          max_ocr_confidence: 0.88,
        });
      })
      .then((res) => {
        if (!active || !res) return;
        setData(res);
      })
      .catch(() => {
        if (!active) return;
        setError(t("userBooks.hardRadar.loadError"));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [bookContentQuality, reloadNonce, t]);

  return (
    <section
      aria-label={t("userBooks.hardRadar.heading")}
      className="flex flex-col gap-4"
      data-testid="admin-ocr-hard-sample-radar"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3.5">
        <div className="flex items-start gap-2.5">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-emerald-700"
          />
          <div className="min-w-0">
            <p className="text-sm font-extrabold text-ink">
              {t("userBooks.hardRadar.heading")}
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              {t("userBooks.hardRadar.privacyNotice")}
            </p>
          </div>
        </div>
        <Button
          className="w-auto"
          disabled={loading}
          fullWidth={false}
          onClick={refresh}
          size="compact"
          type="button"
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
          {t("userBooks.reloadQueue")}
        </Button>
      </div>

      {loading ? (
        <div className="rounded-xl border border-border bg-white p-4">
          <AiProgressBar
            active
            label={loadProgress.stageLabel ?? t("userBooks.hardRadar.loading")}
            percent={loadProgress.percent}
            testId="admin-ocr-hard-radar-progress"
          />
        </div>
      ) : error ? (
        <StatusMessage tone="error">{error}</StatusMessage>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-white p-3.5">
              <p className="text-xs font-semibold text-muted">
                {t("userBooks.hardRadar.totalCandidates")}
              </p>
              <p className="mt-1 text-2xl font-extrabold text-ink">
                {formatNumber(data.total_candidates)}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-white p-3.5">
              <p className="text-xs font-semibold text-muted">
                {t("userBooks.hardRadar.catalogCount")}
              </p>
              <p className="mt-1 text-2xl font-extrabold text-primary">
                {formatNumber(data.catalog_count)}
              </p>
            </div>
            <div className="rounded-xl border border-border bg-white p-3.5">
              <p className="text-xs font-semibold text-muted">
                {t("userBooks.hardRadar.consentedPrivateCount")}
              </p>
              <p className="mt-1 text-2xl font-extrabold text-emerald-700">
                {formatNumber(data.consented_private_count)}
              </p>
            </div>
          </div>

          {data.items.length === 0 ? (
            <div className="rounded-xl border border-border bg-white p-6 text-center text-sm text-muted">
              {t("userBooks.hardRadar.empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {data.items.map((item) => (
                <article
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-white p-3.5"
                  data-testid="ocr-hard-sample-row"
                  key={item.word_id}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="viread-learning-content rounded-md bg-amber-100 px-2 py-0.5 text-sm font-extrabold text-amber-950"
                        dir="ltr"
                        lang="vi"
                      >
                        {item.word_text}
                      </span>
                      <span className="rounded-full border border-border bg-surface-subtle px-2.5 py-0.5 text-[11px] font-bold text-ink">
                        {item.visibility_scope === "PARENT_PRIVATE"
                          ? t("userBooks.hardRadar.scopeConsentedPrivate")
                          : t("userBooks.hardRadar.scopeCatalog")}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs font-bold text-primary">
                        <Sparkles aria-hidden="true" className="size-3.5" />
                        {t("userBooks.hardRadar.scoreLabel", {
                          score: Math.round(item.hard_sample_score),
                        })}
                      </span>
                    </div>
                    <p
                      className="viread-learning-content truncate text-xs text-muted"
                      dir="ltr"
                      lang="vi"
                    >
                      {item.book_title} ·{" "}
                      {t("userBooks.hardRadar.pageLineMeta", {
                        page: formatNumber(item.page_number),
                        line: formatNumber(item.line_index + 1),
                      })}{" "}
                      — “{item.line_text}”
                    </p>
                    <p className="text-xs text-muted">
                      {t("userBooks.hardRadar.signalSummary", {
                        conf:
                          item.ocr_confidence != null
                            ? Math.round(item.ocr_confidence * 100)
                            : 0,
                        retries: formatNumber(item.retry_fail_count),
                        mismatches: formatNumber(
                          item.comparison_mismatch_count,
                        ),
                        sessions: formatNumber(item.distinct_session_count),
                      })}
                    </p>
                  </div>
                  {item.visibility_scope === "CATALOG" ? (
                    <Link
                      className="inline-flex min-h-9 items-center rounded-control border border-border bg-surface-subtle px-3 py-1.5 text-xs font-bold text-ink hover:bg-sky"
                      href={`/admin/books/${encodeURIComponent(item.book_id)}/pages/${encodeURIComponent(item.page_id)}`}
                    >
                      {t("userBooks.hardRadar.inspectOcrAction")}
                    </Link>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}
