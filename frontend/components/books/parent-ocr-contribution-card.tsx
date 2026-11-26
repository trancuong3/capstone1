"use client";

import { CheckCircle2, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import {
  OCR_CONTRIBUTION_NOTICE_VERSION,
  type ParentOcrContributionStateDTO,
} from "@/types/parent-private-book";

interface ParentOcrContributionCardProps {
  bookTitle: string;
  state: ParentOcrContributionStateDTO;
  disabled?: boolean;
  onUpdate: (input: {
    enabled: boolean;
    rights_confirmed: boolean;
    notice_version: string;
    revoke_reason?: string | null;
  }) => Promise<void>;
}

export function ParentOcrContributionCard({
  bookTitle,
  state,
  disabled = false,
  onUpdate,
}: ParentOcrContributionCardProps) {
  const { formatDateTime } = useI18n();
  const t = useTranslations("books");
  const [rightsChecked, setRightsChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleEnable() {
    if (!rightsChecked) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await onUpdate({
        enabled: true,
        rights_confirmed: true,
        notice_version: OCR_CONTRIBUTION_NOTICE_VERSION,
      });
      setNotice(t("ocrContribution.enabledNotice"));
      setRightsChecked(false);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("ocrContribution.enableError"),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await onUpdate({
        enabled: false,
        rights_confirmed: false,
        notice_version: state.notice_version || OCR_CONTRIBUTION_NOTICE_VERSION,
        revoke_reason: "PARENT_OPTED_OUT",
      });
      setNotice(t("ocrContribution.disabledNotice"));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("ocrContribution.disableError"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={t("ocrContribution.cardAria", { title: bookTitle })}
      className="flex flex-col gap-3 rounded-card border border-border bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Sparkles
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-primary"
          />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-extrabold text-ink">
                {t("ocrContribution.title")}
              </h2>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                  state.enabled
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                    : "border-slate-300 bg-slate-100 text-slate-700"
                }`}
              >
                {state.enabled ? (
                  <>
                    <CheckCircle2 aria-hidden="true" className="size-3.5" />
                    {t("ocrContribution.statusEnabled")}
                  </>
                ) : (
                  <>
                    <XCircle aria-hidden="true" className="size-3.5" />
                    {t("ocrContribution.statusDisabled")}
                  </>
                )}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">{state.status_notice}</p>
          </div>
        </div>
      </div>

      {error ? (
        <StatusMessage title={t("ocrContribution.errorTitle")} tone="error">
          {error}
        </StatusMessage>
      ) : null}

      {notice ? (
        <StatusMessage title={t("ocrContribution.successTitle")} tone="success">
          {notice}
        </StatusMessage>
      ) : null}

      {!state.rights_eligible_for_training && state.rights_ineligible_reason ? (
        <div className="rounded-control border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
          <strong>{t("ocrContribution.rightsNoteLabel")}</strong>{" "}
          {state.rights_ineligible_reason}
        </div>
      ) : null}

      {state.enabled ? (
        <div className="flex flex-col gap-3 rounded-control border border-emerald-200 bg-emerald-50/60 p-4 text-xs text-emerald-950">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              <strong>{t("ocrContribution.noticeVersionLabel")}</strong>{" "}
              {state.notice_version}
            </span>
            <span>
              <strong>{t("ocrContribution.consentVersionLabel")}</strong> #
              {state.consent_version}
            </span>
            {state.consented_at ? (
              <span>
                <strong>{t("ocrContribution.enabledAtLabel")}</strong>{" "}
                {formatDateTime(state.consented_at, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3 font-semibold">
            <span>
              {t("ocrContribution.pendingVerificationCount", {
                count: state.pending_verification_count,
              })}
            </span>
            <span>·</span>
            <span>
              {t("ocrContribution.syncQueuedCount", {
                count: state.sync_queued_count,
              })}
            </span>
            <span>·</span>
            <span>
              {t("ocrContribution.syncedCount", { count: state.synced_count })}
            </span>
            {state.rejected_count > 0 ? (
              <>
                <span>·</span>
                <span>
                  {t("ocrContribution.rejectedCount", {
                    count: state.rejected_count,
                  })}
                </span>
              </>
            ) : null}
          </div>
          <p className="text-emerald-900">
            {t("ocrContribution.enabledExplainer")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="min-h-10 w-auto px-4 text-xs"
              disabled={disabled || busy}
              onClick={() => void handleDisable()}
              type="button"
              variant="secondary"
            >
              {busy
                ? t("ocrContribution.disabling")
                : t("ocrContribution.disableAction")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-control border border-border bg-surface-subtle p-4 text-xs text-ink">
          <p>{t("ocrContribution.disabledExplainer")}</p>
          <label className="flex cursor-pointer items-start gap-2.5 font-semibold text-ink">
            <input
              checked={rightsChecked}
              className="mt-0.5 size-4 rounded border-border accent-primary"
              disabled={disabled || busy}
              onChange={(event) => setRightsChecked(event.target.checked)}
              type="checkbox"
            />
            <span>{t("ocrContribution.consentCheckbox")}</span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              className="min-h-10 w-auto px-4 text-xs"
              disabled={disabled || busy || !rightsChecked}
              onClick={() => void handleEnable()}
              type="button"
            >
              <ShieldCheck aria-hidden="true" className="size-4" />
              {busy
                ? t("ocrContribution.enabling")
                : t("ocrContribution.enableAction")}
            </Button>
            <span className="text-[11px] text-muted">
              {t("ocrContribution.footerNote")}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
