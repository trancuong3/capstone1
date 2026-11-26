"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CloudOff,
  FlaskConical,
  HardDrive,
  Link2,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { useState } from "react";

import { AdminBadge, type AdminBadgeTone } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { TranslateFn } from "@/lib/i18n/types";
import type {
  GoogleDriveSelfTestResult,
  GoogleDriveTrainingStatus,
} from "@/lib/api/viread-training-service";

function formatBytes(
  bytes: number | null | undefined,
  unknownLabel: string,
): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
    return unknownLabel;
  }
  const gib = 1024 * 1024 * 1024;
  const mib = 1024 * 1024;
  if (bytes >= gib) {
    return `${(bytes / gib).toFixed(2)} GiB`;
  }
  if (bytes >= mib) {
    return `${(bytes / mib).toFixed(1)} MiB`;
  }
  return `${Math.max(0, Math.round(bytes / 1024))} KiB`;
}

function statusBadge(
  status: GoogleDriveTrainingStatus,
  t: TranslateFn,
): {
  label: string;
  tone: AdminBadgeTone;
} {
  if (!status.migration_applied) {
    return {
      label: t("training.drive.statuses.DB_MIGRATION_REQUIRED"),
      tone: "warning",
    };
  }
  if (status.connected && status.status === "CONNECTED") {
    return {
      label: t("training.drive.statuses.CONNECTED"),
      tone: "success",
    };
  }
  if (status.status === "TOKEN_REVOKED") {
    return {
      label: t("training.drive.statuses.TOKEN_REVOKED"),
      tone: "danger",
    };
  }
  if (status.status === "ERROR") {
    return {
      label: t("training.drive.statuses.ERROR"),
      tone: "danger",
    };
  }
  return {
    label: t("training.drive.statuses.DISCONNECTED"),
    tone: "neutral",
  };
}

function quotaBarColor(warningLevel: string): string {
  if (warningLevel === "EXCEEDED" || warningLevel === "CRITICAL") {
    return "bg-danger";
  }
  if (warningLevel === "WARNING") {
    return "bg-amber-500";
  }
  return "bg-emerald-600";
}

function recoveryHint(
  errorCode: string | null | undefined,
  t: TranslateFn,
): string | null {
  if (!errorCode) return null;
  if (errorCode === "DRIVE_MIGRATION_PENDING") {
    return t("training.drive.guides.DB_MIGRATION_REQUIRED");
  }
  if (errorCode === "DRIVE_TOKEN_REVOKED") {
    return t("training.drive.guides.DRIVE_TOKEN_REVOKED");
  }
  if (errorCode === "DRIVE_QUOTA_EXCEEDED") {
    return t("training.drive.guides.DRIVE_QUOTA_LOW");
  }
  if (errorCode === "DRIVE_ACCOUNT_EMAIL_MISMATCH") {
    return t("training.drive.guides.DRIVE_ACCOUNT_MISMATCH");
  }
  if (errorCode === "DRIVE_BRIDGE_ACCESS_DENIED") {
    return t("training.drive.guides.APPS_SCRIPT_ACCESS_DENIED");
  }
  if (
    errorCode === "DRIVE_BRIDGE_SECRET_NOT_SET" ||
    errorCode === "DRIVE_AUTH_FAILED"
  ) {
    return t("training.drive.guides.BRIDGE_SECRET_MISMATCH");
  }
  if (
    errorCode === "DRIVE_SCOPE_MISSING" ||
    errorCode === "DRIVE_SCOPE_TOO_BROAD"
  ) {
    return t("training.drive.guides.DRIVE_SCOPE_MISMATCH");
  }
  if (errorCode === "GOOGLE_DRIVE_DESKTOP_UNAVAILABLE_ON_CLOUD_SERVER") {
    return t(
      "training.drive.guides.DESKTOP_UNAVAILABLE_CLOUD",
      undefined,
      "Cloud server (Render) không thể truy cập Google Drive Desktop (G:\\) trên máy cá nhân. Hãy chuyển sang Apps Script Bridge.",
    );
  }
  if (errorCode === "GOOGLE_DRIVE_DESKTOP_REQUIRES_WINDOWS_HOST") {
    return t(
      "training.drive.guides.DESKTOP_REQUIRES_WINDOWS",
      undefined,
      "Máy chủ Linux không hỗ trợ Google Drive for Desktop local mount. Hãy kết nối qua Apps Script Bridge.",
    );
  }
  if (errorCode === "DRIVE_ENCRYPTION_KEY_MISSING") {
    return t(
      "training.drive.guides.ENCRYPTION_KEY_MISSING",
      undefined,
      "Thiếu biến VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY (>= 32 ký tự) trên server.",
    );
  }
  return t("training.drive.guides.genericCode", { code: errorCode });
}

export function AdminVireadDrivePanel({
  status,
  onUpdated,
}: {
  status: GoogleDriveTrainingStatus;
  onUpdated: () => Promise<void>;
}) {
  const { vireadTraining } = useAdminServices();
  const t = useTranslations("admin");
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    tone: "info" | "error";
    text: string;
  } | null>(null);
  const [selfTestResult, setSelfTestResult] =
    useState<GoogleDriveSelfTestResult | null>(null);
  const [showBridgeForm, setShowBridgeForm] = useState(false);
  const [bridgeUrl, setBridgeUrl] = useState("");
  const [bridgeSecret, setBridgeSecret] = useState("");
  const [showDesktopForm, setShowDesktopForm] = useState(false);
  const [showDisconnectModal, setShowDisconnectModal] = useState(false);
  const [desktopPath, setDesktopPath] = useState(
    status.drive_desktop_readiness?.default_mount_path ?? "",
  );

  const badge = statusBadge(status, t);
  const quota = status.quota;
  const isAppsScriptConnected =
    status.connected &&
    (status.connection_mode === "apps_script_bridge" ||
      status.oauth_scope === "apps_script_bridge");
  const isDesktopConnected =
    status.connected &&
    (status.connection_mode === "drive_desktop_sync" ||
      status.oauth_scope === "drive_desktop_sync");
  const isNonOauthConnected = isAppsScriptConnected || isDesktopConnected;
  const bridgeReady = status.apps_script_readiness?.bridge_ready ?? false;
  const desktopReady = status.drive_desktop_readiness?.desktop_ready ?? false;
  const detectedMounts = status.drive_desktop_readiness?.detected_mounts ?? [];
  const serverBridgeSecretConfigured =
    status.apps_script_readiness?.server_secret_configured ?? false;
  const usedPct =
    quota.limit_bytes && quota.usage_bytes !== null
      ? Math.min(
          100,
          Math.max(
            0,
            Math.round((quota.usage_bytes / quota.limit_bytes) * 100),
          ),
        )
      : null;

  async function handleConnect() {
    if (!vireadTraining || busyAction) return;
    setBusyAction("connect");
    setFeedback(null);
    try {
      const redirectUri =
        typeof window !== "undefined"
          ? `${window.location.origin}${window.location.pathname}`
          : undefined;
      const result = await vireadTraining.startDriveConnect(redirectUri);
      setFeedback({
        tone: "info",
        text: t("training.drive.notices.redirectingOauth"),
      });
      if (typeof window !== "undefined") {
        window.location.assign(result.authorization_url);
      }
    } catch (err) {
      setFeedback({
        tone: "error",
        text: isServiceError(err)
          ? err.message
          : t("training.drive.notices.oauthInitFailed"),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleConnectAppsScript() {
    if (!vireadTraining || busyAction) return;
    const trimmedUrl = bridgeUrl.trim();
    if (!trimmedUrl) {
      setFeedback({
        tone: "error",
        text: t("training.drive.notices.invalidAppsScriptUrl"),
      });
      return;
    }
    setBusyAction("connect_bridge");
    setFeedback(null);
    try {
      const trimmedSecret = bridgeSecret.trim();
      const connected = await vireadTraining.connectDriveAppsScript({
        web_app_url: trimmedUrl,
        ...(trimmedSecret ? { bridge_secret: trimmedSecret } : {}),
      });
      setBridgeSecret("");
      setShowBridgeForm(false);
      setFeedback({
        tone: "info",
        text: t("training.drive.notices.appsScriptConnected", {
          account: connected.account_email ?? "owner",
        }),
      });
      await onUpdated();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "";
      setFeedback({
        tone: "error",
        text: detail
          ? t("training.drive.notices.appsScriptFailedDetail", { detail })
          : t("training.drive.notices.appsScriptFailed"),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleConnectDesktop() {
    if (!vireadTraining || busyAction) return;
    setBusyAction("connect_desktop");
    setFeedback(null);
    try {
      const trimmedPath = (
        desktopPath ||
        status.drive_desktop_readiness?.default_mount_path ||
        ""
      ).trim();
      const connected = await vireadTraining.connectDriveDesktop(
        trimmedPath ? { sync_root_path: trimmedPath } : {},
      );
      setShowDesktopForm(false);
      setFeedback({
        tone: "info",
        text: t("training.drive.notices.desktopConnected", {
          account: connected.account_email ?? "owner",
        }),
      });
      await onUpdated();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "";
      setFeedback({
        tone: "error",
        text: detail
          ? t("training.drive.notices.desktopFailedDetail", { detail })
          : t("training.drive.notices.desktopFailed"),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleHealthCheck() {
    if (!vireadTraining || busyAction) return;
    setBusyAction("health");
    setFeedback(null);
    try {
      const refreshed = await vireadTraining.checkDriveHealth();
      setFeedback({
        tone: refreshed.connected ? "info" : "error",
        text:
          refreshed.health_detail ||
          (refreshed.connected
            ? t("training.drive.notices.checkOk")
            : t("training.drive.notices.checkError")),
      });
      await onUpdated();
    } catch (err) {
      setFeedback({
        tone: "error",
        text: isServiceError(err)
          ? err.message
          : t("training.drive.notices.checkException"),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSelfTest() {
    if (!vireadTraining || busyAction) return;
    setBusyAction("selftest");
    setFeedback(null);
    setSelfTestResult(null);
    try {
      const result = await vireadTraining.runDriveSelfTest();
      setSelfTestResult(result);
      setFeedback({
        tone: result.ok ? "info" : "error",
        text: result.ok
          ? t("training.drive.notices.selfTestOk")
          : t("training.drive.notices.selfTestFailed"),
      });
      await onUpdated();
    } catch (err) {
      setFeedback({
        tone: "error",
        text: isServiceError(err)
          ? err.message
          : t("training.drive.notices.selfTestException"),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function confirmDisconnect() {
    if (!vireadTraining || busyAction) return;
    setBusyAction("disconnect");
    setFeedback(null);
    setSelfTestResult(null);
    try {
      await vireadTraining.disconnectDrive();
      setShowDisconnectModal(false);
      setFeedback({
        tone: "info",
        text: t("training.drive.notices.disconnected"),
      });
      await onUpdated();
    } catch (err) {
      setShowDisconnectModal(false);
      setFeedback({
        tone: "error",
        text: isServiceError(err)
          ? err.message
          : t("training.drive.notices.disconnectFailed"),
      });
    } finally {
      setBusyAction(null);
    }
  }

  const hint = recoveryHint(status.last_error_code, t);
  const unknownBytes = t("common.unknown");

  return (
    <>
      <Card className="bg-white p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <HardDrive aria-hidden className="size-5 text-primary" />
              <h2 className="text-lg font-extrabold text-ink">
                {t("training.drive.heading")}
              </h2>
              <AdminBadge dot tone={badge.tone}>
                {badge.label}
              </AdminBadge>
            </div>
            <p className="mt-1 text-sm text-muted">
              {t("training.drive.description")}
            </p>
          </div>
        </div>

        {feedback ? (
          <div>
            <StatusMessage tone={feedback.tone === "error" ? "error" : "info"}>
              {feedback.text}
            </StatusMessage>
          </div>
        ) : null}

        {hint ? (
          <div className="flex items-start gap-2 rounded-control border border-amber-200 bg-warning-surface p-3 text-sm text-warning">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>{hint}</p>
          </div>
        ) : null}

        {isDesktopConnected ? (
          <div className="flex items-start gap-2 rounded-control border border-amber-200 bg-warning-surface p-3 text-sm text-warning">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
            <p>
              {t(
                "training.drive.desktopCloudWarningPrefix",
                undefined,
                "Kết nối hiện tại đang dùng",
              )}{" "}
              <code className="font-mono text-xs">drive_desktop_sync</code>{" "}
              {t(
                "training.drive.desktopCloudWarningMid",
                undefined,
                "(chỉ đọc được ổ G:\\ trên máy Windows local). Để backend Cloud (Render) và Google Colab đọc/ghi Drive, hãy chuyển sang",
              )}{" "}
              <strong>{t("training.drive.appsScriptMethod")}</strong>.
            </p>
          </div>
        ) : null}

        {!status.oauth_configured && !isNonOauthConnected ? (
          <div className="flex items-start gap-2 rounded-control border border-border bg-surface-subtle p-3 text-sm text-ink">
            <CloudOff aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            <p>
              {desktopReady || bridgeReady ? (
                <>
                  {t("training.drive.noCloudCardHintPrefix")}
                  <strong>{t("training.drive.desktopMethod")}</strong>
                  {t("training.drive.noCloudCardHintMid")}
                  <strong>{t("training.drive.appsScriptMethod")}</strong>
                  {t("training.drive.noCloudCardHintSuffix")}
                </>
              ) : (
                <>
                  {t("training.drive.missingOauthEnvPrefix")}
                  <code className="font-mono text-xs">
                    VIREAD_GDRIVE_OAUTH_CLIENT_ID
                  </code>
                  ,{" "}
                  <code className="font-mono text-xs">
                    VIREAD_GDRIVE_OAUTH_CLIENT_SECRET
                  </code>
                  ,{" "}
                  <code className="font-mono text-xs">
                    VIREAD_GDRIVE_OAUTH_REDIRECT_URI
                  </code>
                  ,{" "}
                  <code className="font-mono text-xs">
                    VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY
                  </code>
                  {t("training.drive.missingOauthEnvSuffix")}
                </>
              )}
            </p>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border border-border bg-surface-subtle/30 p-4 text-sm">
            <p className="font-extrabold text-ink">
              {t("training.drive.accountHeading")}
            </p>
            <dl className="mt-2.5 space-y-1.5">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">
                  {t("training.drive.googleAccountLabel")}
                </dt>
                <dd className="break-all font-semibold text-ink">
                  {status.account_email || t("training.drive.notConnected")}
                </dd>
              </div>
              {status.required_account_email ? (
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">
                    {t("training.drive.ownerEmailLabel")}
                  </dt>
                  <dd className="break-all font-mono text-xs font-semibold text-primary">
                    {status.required_account_email}
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between gap-2">
                <dt className="text-muted">{t("training.drive.scopeLabel")}</dt>
                <dd className="flex items-center gap-1 font-mono text-xs text-ink">
                  {status.scope_valid ? (
                    <>
                      <ShieldCheck
                        aria-hidden
                        className="size-4 text-emerald-600"
                      />
                      <span>
                        {isDesktopConnected
                          ? t("training.drive.desktopScopeValue")
                          : isAppsScriptConnected
                            ? t("training.drive.appsScriptScopeValue")
                            : t("training.drive.defaultScopeValue")}
                      </span>
                    </>
                  ) : (
                    <span>
                      {status.oauth_scope || t("training.drive.noScope")}
                    </span>
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">
                  {t("training.drive.folderLabel")}
                </dt>
                <dd className="break-all text-end font-mono text-xs text-ink">
                  {status.root_folder_path}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">
                  {t("training.drive.providerLabel")}
                </dt>
                <dd className="font-mono text-xs font-bold text-ink">
                  {status.provider}
                </dd>
              </div>
            </dl>
          </div>

          <div className="rounded-xl border border-border bg-surface-subtle/30 p-4 text-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="font-extrabold text-ink">
                {t("training.drive.quotaHeading")}
              </p>
              <span className="font-mono text-xs font-bold text-muted">
                {quota.warning_level}
              </span>
            </div>
            <div className="mt-2.5">
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-border">
                <div
                  className={`h-full transition-all ${quotaBarColor(quota.warning_level)}`}
                  style={{ width: `${usedPct ?? 0}%` }}
                />
              </div>
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted tabular-nums">
                <span>
                  {t("training.drive.usedBytes", {
                    size: formatBytes(quota.usage_bytes, unknownBytes),
                  })}
                </span>
                <span>
                  {t("training.drive.availableBytes", {
                    size: formatBytes(quota.available_bytes, unknownBytes),
                  })}
                </span>
                <span>
                  {t("training.drive.limitBytes", {
                    size: formatBytes(quota.limit_bytes, unknownBytes),
                  })}
                </span>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted tabular-nums">
              {t("training.drive.safetyBufferPrefix")}
              <strong className="text-ink">
                {formatBytes(quota.min_free_buffer_bytes, unknownBytes)}
              </strong>{" "}
              ·{" "}
              {quota.can_accept_upload
                ? t("training.drive.readyForUpload")
                : t("training.drive.pausedUpload")}
            </p>
          </div>
        </div>

        {selfTestResult ? (
          <div className="rounded-control border border-emerald-200 bg-success-surface p-3 text-xs text-success-ink">
            <div className="flex items-center gap-2 font-bold">
              <CheckCircle2 aria-hidden className="size-4" />
              <span>{t("training.drive.selftestHeading")}</span>
            </div>
            <p className="mt-1">
              {t("training.drive.pathPrefix")}
              <code className="font-mono">{selfTestResult.logical_path}</code> ·
              SHA-256:{" "}
              <code className="font-mono">
                {selfTestResult.sha256?.slice(0, 16) ?? t("common.emptyDash")}…
              </code>
              {t("training.drive.privateLabel")}
              <strong>
                {selfTestResult.is_private ? t("common.yes") : t("common.no")}
              </strong>
              {t("training.drive.cleanedAfterTestLabel")}
              <strong>
                {selfTestResult.deleted_after_test
                  ? t("common.yes")
                  : t("common.notYet")}
              </strong>
            </p>
          </div>
        ) : null}

        {showDesktopForm ? (
          <div className="rounded-xl border border-primary/25 bg-surface-subtle/60 p-4 text-sm">
            <p className="font-extrabold text-ink">
              {t("training.drive.desktopModalHeading")}
            </p>
            <p className="mt-1 text-xs text-muted">
              {t("training.drive.desktopModalDescPrefix")}
              <strong>{t("training.drive.desktopMethod")}</strong>
              {t("training.drive.desktopModalDescMid")}
              {status.required_account_email
                ? ` (${status.required_account_email})`
                : ""}
              {t("training.drive.desktopModalDescSuffix")}
            </p>
            <div className="mt-3">
              <label className="block text-xs font-semibold text-ink">
                {t("training.drive.desktopPathLabel")}
                <input
                  className="mt-1 h-10 w-full rounded-control border border-border bg-white px-3 font-mono text-xs text-ink focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary"
                  onChange={(e) => setDesktopPath(e.target.value)}
                  placeholder={
                    detectedMounts[0]?.drive_root ??
                    t("training.drive.desktopPathPlaceholder")
                  }
                  type="text"
                  value={desktopPath}
                />
              </label>
              {detectedMounts.length > 0 ? (
                <p className="mt-1 text-xs text-emerald-700">
                  {t("training.drive.detectedDrivePrefix")}
                  <code className="font-mono">
                    {detectedMounts[0].drive_root}
                  </code>
                </p>
              ) : null}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={busyAction !== null}
                fullWidth={false}
                onClick={() => void handleConnectDesktop()}
                size="admin"
                variant="primary"
              >
                <Link2 aria-hidden className="size-4" />
                {t("training.drive.verifyAndSaveDesktopBtn")}
              </Button>
              <Button
                disabled={busyAction !== null}
                fullWidth={false}
                onClick={() => setShowDesktopForm(false)}
                size="admin"
                variant="outline"
              >
                {t("common.close")}
              </Button>
            </div>
          </div>
        ) : null}

        {showBridgeForm ? (
          <div className="rounded-xl border border-primary/25 bg-surface-subtle/60 p-4 text-sm">
            <p className="font-extrabold text-ink">
              {t("training.drive.appsScriptHeading")}
            </p>
            <p className="mt-1 text-xs text-muted">
              {t("training.drive.appsScriptStep1Prefix")}
              <code className="font-mono">https://script.google.com/</code>{" "}
              {t("training.drive.appsScriptStep1Mid")}
              {status.required_account_email
                ? ` (${status.required_account_email})`
                : ""}
              {t("training.drive.appsScriptStep1CodeRef")}
              <code className="font-mono">
                scripts/google-apps-script/viread_flow2_drive_bridge.gs
              </code>
              {t("training.drive.appsScriptStep1Secret")}
              <code className="font-mono">VIREAD_BRIDGE_SECRET</code>{" "}
              {t("training.drive.appsScriptStep1End")}
            </p>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              <label className="block text-xs font-semibold text-ink">
                {t("training.drive.appsScriptUrlLabel")}
                <input
                  className="mt-1 h-10 w-full rounded-control border border-border bg-white px-3 font-mono text-xs text-ink focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary"
                  onChange={(e) => setBridgeUrl(e.target.value)}
                  placeholder={t("training.drive.appsScriptUrlPlaceholder")}
                  type="url"
                  value={bridgeUrl}
                />
              </label>
              <label className="block text-xs font-semibold text-ink">
                VIREAD_BRIDGE_SECRET{" "}
                {serverBridgeSecretConfigured
                  ? t("training.drive.secretConfiguredSuffix")
                  : t("training.drive.secretRequiredSuffix")}
                <input
                  className="mt-1 h-10 w-full rounded-control border border-border bg-white px-3 font-mono text-xs text-ink focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary"
                  onChange={(e) => setBridgeSecret(e.target.value)}
                  placeholder={
                    serverBridgeSecretConfigured
                      ? t("training.drive.secretConfiguredPlaceholder")
                      : t("training.drive.secretRequiredPlaceholder")
                  }
                  type="password"
                  value={bridgeSecret}
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                disabled={busyAction !== null || !bridgeUrl.trim()}
                fullWidth={false}
                onClick={() => void handleConnectAppsScript()}
                size="admin"
                variant="primary"
              >
                <Link2 aria-hidden className="size-4" />
                {t("training.drive.verifyAndSaveBridgeBtn")}
              </Button>
              <Button
                disabled={busyAction !== null}
                fullWidth={false}
                onClick={() => setShowBridgeForm(false)}
                size="admin"
                variant="outline"
              >
                {t("common.close")}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {desktopReady ? (
            <Button
              disabled={busyAction !== null || !status.migration_applied}
              fullWidth={false}
              onClick={() => {
                setShowBridgeForm(false);
                setShowDesktopForm((prev) => !prev);
              }}
              size="admin"
              variant={
                !status.connected && !status.oauth_configured
                  ? "primary"
                  : "secondary"
              }
            >
              <Link2 aria-hidden className="size-4" />
              {isDesktopConnected
                ? t("training.drive.changeDesktopFolderBtn")
                : t("training.drive.connectDesktopBtn")}
            </Button>
          ) : null}

          {bridgeReady ? (
            <Button
              disabled={busyAction !== null || !status.migration_applied}
              fullWidth={false}
              onClick={() => {
                setShowDesktopForm(false);
                setShowBridgeForm((prev) => !prev);
              }}
              size="admin"
              variant={
                !status.connected && !status.oauth_configured && !desktopReady
                  ? "primary"
                  : "secondary"
              }
            >
              <Link2 aria-hidden className="size-4" />
              {isAppsScriptConnected
                ? t("training.drive.changeAppsScriptBtn")
                : t("training.drive.connectAppsScriptBtn")}
            </Button>
          ) : null}

          {status.oauth_configured || (!bridgeReady && !desktopReady) ? (
            <Button
              disabled={
                busyAction !== null ||
                !status.migration_applied ||
                !status.oauth_configured
              }
              fullWidth={false}
              onClick={() => void handleConnect()}
              size="admin"
              variant={status.connected ? "secondary" : "primary"}
            >
              <Link2 aria-hidden className="size-4" />
              {status.connected
                ? t("training.drive.reconnectOauthBtn")
                : t("training.drive.connectOauthBtn")}
            </Button>
          ) : null}

          <Button
            disabled={busyAction !== null || !status.connected}
            fullWidth={false}
            onClick={() => void handleHealthCheck()}
            size="admin"
            variant="outline"
          >
            <RefreshCw aria-hidden className="size-4" />
            {t("training.drive.checkConnectionBtn")}
          </Button>

          <Button
            disabled={busyAction !== null || !status.connected}
            fullWidth={false}
            onClick={() => void handleSelfTest()}
            size="admin"
            variant="outline"
          >
            <FlaskConical aria-hidden className="size-4" />
            {t("training.drive.selfTestBtn")}
          </Button>

          {status.connected ? (
            <Button
              disabled={busyAction !== null}
              fullWidth={false}
              onClick={() => setShowDisconnectModal(true)}
              size="admin"
              variant="destructive-outline"
            >
              <Unplug aria-hidden className="size-4" />
              {t("training.drive.disconnectBtn")}
            </Button>
          ) : null}
        </div>
      </Card>

      <Modal
        closeOnBackdropClick={busyAction !== "disconnect"}
        closeOnEscape={busyAction !== "disconnect"}
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              disabled={busyAction === "disconnect"}
              fullWidth={false}
              onClick={() => setShowDisconnectModal(false)}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              fullWidth={false}
              isLoading={busyAction === "disconnect"}
              onClick={() => void confirmDisconnect()}
              size="admin"
              type="button"
              variant="destructive"
            >
              {t(
                "training.drive.disconnectModalConfirm",
                undefined,
                "Ngắt kết nối",
              )}
            </Button>
          </div>
        }
        isOpen={showDisconnectModal}
        onClose={() => {
          if (busyAction !== "disconnect") setShowDisconnectModal(false);
        }}
        role="alertdialog"
        showCloseButton={busyAction !== "disconnect"}
        title={t(
          "training.drive.disconnectModalTitle",
          undefined,
          "Ngắt kết nối Google Drive?",
        )}
        tone="paper"
      >
        <p className="text-sm leading-relaxed text-ink">
          {t("training.drive.notices.disconnectConfirm")}
        </p>
      </Modal>
    </>
  );
}
