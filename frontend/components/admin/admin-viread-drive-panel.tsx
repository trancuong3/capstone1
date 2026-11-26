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

import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
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
  toneClass: string;
} {
  if (!status.migration_applied) {
    return {
      label: t("training.drive.statuses.DB_MIGRATION_REQUIRED"),
      toneClass: "bg-amber-100 text-amber-900 border-amber-300",
    };
  }
  if (status.connected && status.status === "CONNECTED") {
    return {
      label: t("training.drive.statuses.CONNECTED"),
      toneClass: "bg-emerald-100 text-emerald-900 border-emerald-300",
    };
  }
  if (status.status === "TOKEN_REVOKED") {
    return {
      label: t("training.drive.statuses.TOKEN_REVOKED"),
      toneClass: "bg-rose-100 text-rose-900 border-rose-300",
    };
  }
  if (status.status === "ERROR") {
    return {
      label: t("training.drive.statuses.ERROR"),
      toneClass: "bg-rose-100 text-rose-900 border-rose-300",
    };
  }
  return {
    label: t("training.drive.statuses.DISCONNECTED"),
    toneClass: "bg-slate-100 text-slate-800 border-slate-300",
  };
}

function quotaBarColor(warningLevel: string): string {
  if (warningLevel === "EXCEEDED" || warningLevel === "CRITICAL") {
    return "bg-rose-600";
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
    } catch {
      setFeedback({
        tone: "error",
        text: t("training.drive.notices.oauthInitFailed"),
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
    } catch {
      setFeedback({
        tone: "error",
        text: t("training.drive.notices.checkException"),
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
    } catch {
      setFeedback({
        tone: "error",
        text: t("training.drive.notices.selfTestException"),
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDisconnect() {
    if (!vireadTraining || busyAction) return;
    if (!globalThis.confirm(t("training.drive.notices.disconnectConfirm"))) {
      return;
    }
    setBusyAction("disconnect");
    setFeedback(null);
    setSelfTestResult(null);
    try {
      await vireadTraining.disconnectDrive();
      setFeedback({
        tone: "info",
        text: t("training.drive.notices.disconnected"),
      });
      await onUpdated();
    } catch {
      setFeedback({
        tone: "error",
        text: t("training.drive.notices.disconnectFailed"),
      });
    } finally {
      setBusyAction(null);
    }
  }

  const hint = recoveryHint(status.last_error_code, t);
  const unknownBytes = t("common.unknown");

  return (
    <Card className="mb-6 bg-white">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <HardDrive aria-hidden className="size-5 text-primary" />
            <h2 className="text-xl font-black">
              {t("training.drive.heading")}
            </h2>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-extrabold ${badge.toneClass}`}
            >
              {badge.label}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            {t("training.drive.description")}
          </p>
        </div>
      </div>

      {feedback ? (
        <div className="mt-4">
          <StatusMessage tone={feedback.tone === "error" ? "error" : "info"}>
            {feedback.text}
          </StatusMessage>
        </div>
      ) : null}

      {hint ? (
        <div className="mt-3 flex items-start gap-2 rounded-control border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>{hint}</p>
        </div>
      ) : null}

      {!status.oauth_configured && !isNonOauthConnected ? (
        <div className="mt-3 flex items-start gap-2 rounded-control border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800">
          <CloudOff aria-hidden className="mt-0.5 size-4 shrink-0" />
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

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-control border border-border p-4 text-sm">
          <p className="font-extrabold">{t("training.drive.accountHeading")}</p>
          <dl className="mt-2 space-y-1.5">
            <div className="flex justify-between gap-2">
              <dt className="text-muted">
                {t("training.drive.googleAccountLabel")}
              </dt>
              <dd className="break-all font-semibold">
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
              <dd className="flex items-center gap-1 font-mono text-xs">
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
              <dt className="text-muted">{t("training.drive.folderLabel")}</dt>
              <dd className="break-all text-end font-mono text-xs">
                {status.root_folder_path}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">
                {t("training.drive.providerLabel")}
              </dt>
              <dd className="font-mono text-xs font-bold">{status.provider}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-control border border-border p-4 text-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="font-extrabold">{t("training.drive.quotaHeading")}</p>
            <span className="font-mono text-xs font-bold text-muted">
              {quota.warning_level}
            </span>
          </div>
          <div className="mt-2">
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-200">
              <div
                className={`h-full transition-all ${quotaBarColor(quota.warning_level)}`}
                style={{ width: `${usedPct ?? 0}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted">
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
          <p className="mt-2 text-xs text-muted">
            {t("training.drive.safetyBufferPrefix")}
            <strong>
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
        <div className="mt-4 rounded-control border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-950">
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
        <div className="mt-4 rounded-control border border-primary/30 bg-slate-50 p-4 text-sm">
          <p className="font-extrabold">
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
            <label className="block text-xs font-semibold">
              {t("training.drive.desktopPathLabel")}
              <input
                className="mt-1 w-full rounded-control border border-border bg-white px-3 py-2 font-mono text-xs"
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
              className="sm:w-auto"
              disabled={busyAction !== null}
              onClick={() => void handleConnectDesktop()}
              variant="primary"
            >
              <Link2 aria-hidden className="size-4" />{" "}
              {t("training.drive.verifyAndSaveDesktopBtn")}
            </Button>
            <Button
              className="sm:w-auto"
              disabled={busyAction !== null}
              onClick={() => setShowDesktopForm(false)}
              variant="secondary"
            >
              {t("common.close")}
            </Button>
          </div>
        </div>
      ) : null}

      {showBridgeForm ? (
        <div className="mt-4 rounded-control border border-primary/30 bg-slate-50 p-4 text-sm">
          <p className="font-extrabold">
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
            <label className="block text-xs font-semibold">
              {t("training.drive.appsScriptUrlLabel")}
              <input
                className="mt-1 w-full rounded-control border border-border bg-white px-3 py-2 font-mono text-xs"
                onChange={(e) => setBridgeUrl(e.target.value)}
                placeholder={t("training.drive.appsScriptUrlPlaceholder")}
                type="url"
                value={bridgeUrl}
              />
            </label>
            <label className="block text-xs font-semibold">
              VIREAD_BRIDGE_SECRET{" "}
              {serverBridgeSecretConfigured
                ? t("training.drive.secretConfiguredSuffix")
                : t("training.drive.secretRequiredSuffix")}
              <input
                className="mt-1 w-full rounded-control border border-border bg-white px-3 py-2 font-mono text-xs"
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
              className="sm:w-auto"
              disabled={busyAction !== null || !bridgeUrl.trim()}
              onClick={() => void handleConnectAppsScript()}
              variant="primary"
            >
              <Link2 aria-hidden className="size-4" />{" "}
              {t("training.drive.verifyAndSaveBridgeBtn")}
            </Button>
            <Button
              className="sm:w-auto"
              disabled={busyAction !== null}
              onClick={() => setShowBridgeForm(false)}
              variant="secondary"
            >
              {t("common.close")}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {desktopReady ? (
          <Button
            className="sm:w-auto"
            disabled={busyAction !== null || !status.migration_applied}
            onClick={() => {
              setShowBridgeForm(false);
              setShowDesktopForm((prev) => !prev);
            }}
            variant={
              !status.connected && !status.oauth_configured
                ? "primary"
                : "secondary"
            }
          >
            <Link2 aria-hidden className="size-4" />{" "}
            {isDesktopConnected
              ? t("training.drive.changeDesktopFolderBtn")
              : t("training.drive.connectDesktopBtn")}
          </Button>
        ) : null}

        {bridgeReady ? (
          <Button
            className="sm:w-auto"
            disabled={busyAction !== null || !status.migration_applied}
            onClick={() => {
              setShowDesktopForm(false);
              setShowBridgeForm((prev) => !prev);
            }}
            variant={
              !status.connected && !status.oauth_configured && !desktopReady
                ? "primary"
                : "secondary"
            }
          >
            <Link2 aria-hidden className="size-4" />{" "}
            {isAppsScriptConnected
              ? t("training.drive.changeAppsScriptBtn")
              : t("training.drive.connectAppsScriptBtn")}
          </Button>
        ) : null}

        {status.oauth_configured || (!bridgeReady && !desktopReady) ? (
          <Button
            className="sm:w-auto"
            disabled={
              busyAction !== null ||
              !status.migration_applied ||
              !status.oauth_configured
            }
            onClick={() => void handleConnect()}
            variant={status.connected ? "secondary" : "primary"}
          >
            <Link2 aria-hidden className="size-4" />{" "}
            {status.connected
              ? t("training.drive.reconnectOauthBtn")
              : t("training.drive.connectOauthBtn")}
          </Button>
        ) : null}

        <Button
          className="sm:w-auto"
          disabled={busyAction !== null || !status.connected}
          onClick={() => void handleHealthCheck()}
          variant="secondary"
        >
          <RefreshCw aria-hidden className="size-4" />{" "}
          {t("training.drive.checkConnectionBtn")}
        </Button>

        <Button
          className="sm:w-auto"
          disabled={busyAction !== null || !status.connected}
          onClick={() => void handleSelfTest()}
          variant="secondary"
        >
          <FlaskConical aria-hidden className="size-4" />{" "}
          {t("training.drive.selfTestBtn")}
        </Button>

        {status.connected ? (
          <Button
            className="sm:w-auto"
            disabled={busyAction !== null}
            onClick={() => void handleDisconnect()}
            variant="secondary"
          >
            <Unplug aria-hidden className="size-4" />{" "}
            {t("training.drive.disconnectBtn")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
