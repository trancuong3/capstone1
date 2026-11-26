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
import { isServiceError } from "@/lib/api/service-error";
import type {
  GoogleDriveSelfTestResult,
  GoogleDriveTrainingStatus,
} from "@/lib/api/viread-training-service";

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
    return "Chưa rõ";
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

function statusBadge(status: GoogleDriveTrainingStatus): {
  label: string;
  toneClass: string;
} {
  if (!status.migration_applied) {
    return {
      label: "Chờ migration DB",
      toneClass: "bg-amber-100 text-amber-900 border-amber-300",
    };
  }
  if (status.connected && status.status === "CONNECTED") {
    return {
      label: "Đã kết nối (Private)",
      toneClass: "bg-emerald-100 text-emerald-900 border-emerald-300",
    };
  }
  if (status.status === "TOKEN_REVOKED") {
    return {
      label: "Token bị thu hồi",
      toneClass: "bg-rose-100 text-rose-900 border-rose-300",
    };
  }
  if (status.status === "ERROR") {
    return {
      label: "Lỗi kết nối Drive",
      toneClass: "bg-rose-100 text-rose-900 border-rose-300",
    };
  }
  return {
    label: "Chưa kết nối",
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

function recoveryHint(errorCode: string | null | undefined): string | null {
  if (!errorCode) return null;
  if (errorCode === "DRIVE_MIGRATION_PENDING") {
    return "Cần áp dụng migration SQL Flow 2 Google Drive trên database trước khi kết nối tài khoản.";
  }
  if (errorCode === "DRIVE_TOKEN_REVOKED") {
    return "Google đã thu hồi refresh token hoặc token hết hạn. Hãy bấm Kết nối Google Drive để cấp quyền lại.";
  }
  if (errorCode === "DRIVE_QUOTA_EXCEEDED") {
    return "Dung lượng Google Drive miễn phí sắp chạm ngưỡng an toàn. Upload đã tạm dừng an toàn (không chuyển về Supabase); hãy dọn thùng rác Drive hoặc lưu trữ các run cũ đã kiểm toán.";
  }
  if (errorCode === "DRIVE_ACCOUNT_EMAIL_MISMATCH") {
    return "Tài khoản Google vừa chọn không khớp tài khoản chủ sở hữu Drive được khóa trên server. Hãy kết nối lại đúng tài khoản Gmail chủ sở hữu.";
  }
  if (errorCode === "DRIVE_BRIDGE_ACCESS_DENIED") {
    return "Apps Script Web App đang chặn truy cập ẩn danh. Trong script.google.com hãy Deploy lại với tùy chọn 'Ai có quyền truy cập: Bất kỳ ai (Anyone)' (vẫn bảo vệ bằng chữ ký HMAC-SHA256).";
  }
  if (
    errorCode === "DRIVE_BRIDGE_SECRET_NOT_SET" ||
    errorCode === "DRIVE_AUTH_FAILED"
  ) {
    return "Chữ ký Apps Script Bridge không khớp hoặc chưa cài VIREAD_BRIDGE_SECRET trong Script Properties của script.google.com.";
  }
  if (
    errorCode === "DRIVE_SCOPE_MISSING" ||
    errorCode === "DRIVE_SCOPE_TOO_BROAD"
  ) {
    return "Quyền OAuth không đúng phạm vi tối thiểu drive.file. Hãy kết nối lại và chấp thuận đúng quyền thư mục riêng của ứng dụng.";
  }
  if (errorCode === "GOOGLE_DRIVE_DESKTOP_UNAVAILABLE_ON_CLOUD_SERVER") {
    return "Cloud server (Render) không thể truy cập Google Drive Desktop (G:\\) trên máy cá nhân. Hãy chuyển sang Apps Script Bridge.";
  }
  if (errorCode === "GOOGLE_DRIVE_DESKTOP_REQUIRES_WINDOWS_HOST") {
    return "Máy chủ Linux không hỗ trợ Google Drive for Desktop local mount. Hãy kết nối qua Apps Script Bridge.";
  }
  if (errorCode === "DRIVE_ENCRYPTION_KEY_MISSING") {
    return "Thiếu biến VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY (>= 32 ký tự) trên server.";
  }
  return `Mã lỗi: ${errorCode}. Kiểm tra lại kết nối Google Drive hoặc bấm Kiểm tra kết nối & dung lượng.`;
}

export function AdminVireadDrivePanel({
  status,
  onUpdated,
}: {
  status: GoogleDriveTrainingStatus;
  onUpdated: () => Promise<void>;
}) {
  const { vireadTraining } = useAdminServices();
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

  const badge = statusBadge(status);
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
        text: "Đang chuyển hướng tới trang xác thực OAuth 2.0 của Google (chỉ xin quyền tối thiểu drive.file)…",
      });
      if (typeof window !== "undefined") {
        window.location.assign(result.authorization_url);
      }
    } catch (err) {
      setFeedback({
        tone: "error",
        text: isServiceError(err)
          ? err.message
          : "Không thể khởi tạo OAuth Google Drive. Kiểm tra cấu hình VIREAD_GDRIVE_OAUTH_* và VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY trên server.",
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
        text: "Vui lòng dán URL Web App từ script.google.com (dạng https://script.google.com/macros/s/.../exec).",
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
        text: `Đã kết nối Google Drive riêng tư (${connected.account_email ?? "owner"}) qua Apps Script Bridge (0 thẻ, không hết hạn 7 ngày).`,
      });
      await onUpdated();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "";
      setFeedback({
        tone: "error",
        text: detail
          ? `Kết nối Apps Script Bridge thất bại: ${detail}`
          : "Kết nối Apps Script Bridge thất bại. Kiểm tra lại URL Web App, VIREAD_BRIDGE_SECRET và quyền 'Bất kỳ ai (Anyone)'.",
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
        text: `Đã kết nối Google Drive for Desktop (${connected.account_email ?? "owner"}) — dữ liệu từ mọi acc Colab sẽ đồng bộ thẳng vào Drive của bạn.`,
      });
      await onUpdated();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "";
      setFeedback({
        tone: "error",
        text: detail
          ? `Kết nối Google Drive for Desktop thất bại: ${detail}`
          : "Không tìm thấy thư mục Google Drive for Desktop. Hãy mở Google Drive trên Windows, đăng nhập tài khoản chủ Drive rồi nhập đường dẫn (vd: G:\\My Drive).",
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
            ? "Đã xác minh kết nối Google Drive, thư mục Flow 2 và dung lượng còn lại."
            : "Kiểm tra Google Drive phát hiện lỗi. Xem mã lỗi và hướng dẫn khắc phục bên dưới."),
      });
      await onUpdated();
    } catch (err) {
      setFeedback({
        tone: "error",
        text: isServiceError(err)
          ? err.message
          : "Không thể kiểm tra kết nối Google Drive lúc này.",
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
          ? "Kiểm thử upload / xác minh SHA-256 / đọc lại / xóa tệp trong _selftest thành công (100% riêng tư)."
          : "Kiểm thử Google Drive không đạt toàn bộ điều kiện.",
      });
      await onUpdated();
    } catch (err) {
      setFeedback({
        tone: "error",
        text: isServiceError(err)
          ? err.message
          : "Kiểm thử upload/đọc/xóa trên Google Drive thất bại. Kiểm tra quyền ghi và dung lượng trống.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDisconnect() {
    if (!vireadTraining || busyAction) return;
    if (
      !globalThis.confirm(
        "Ngắt kết nối Google Drive khỏi Luồng 2? Dữ liệu sách gốc và tệp đã lưu trên Drive không bị xóa; outbox mới sẽ tạm chờ an toàn (không chuyển về Supabase).",
      )
    ) {
      return;
    }
    setBusyAction("disconnect");
    setFeedback(null);
    setSelfTestResult(null);
    try {
      await vireadTraining.disconnectDrive();
      setFeedback({
        tone: "info",
        text: "Đã ngắt kết nối Google Drive an toàn và xóa refresh token khỏi backend.",
      });
      await onUpdated();
    } catch (err) {
      setFeedback({
        tone: "error",
        text: isServiceError(err)
          ? err.message
          : "Không thể ngắt kết nối Google Drive lúc này.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  const hint = recoveryHint(status.last_error_code);

  return (
    <Card className="mb-6 bg-white">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <HardDrive aria-hidden className="size-5 text-primary" />
            <h2 className="text-xl font-black">
              Lưu trữ Luồng 2 · Google Drive (0 VNĐ)
            </h2>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-extrabold ${badge.toneClass}`}
            >
              {badge.label}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            Toàn bộ ảnh crop dòng, nhãn đã xác minh, dataset snapshot,
            checkpoint và báo cáo benchmark Luồng 2 được lưu riêng tư trên
            Google Drive. Supabase chỉ giữ metadata; không tự chuyển fallback về
            Supabase khi Drive đầy hoặc mất kết nối.
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

      {isDesktopConnected ? (
        <div className="mt-3 flex items-start gap-2 rounded-control border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            Kết nối hiện tại đang dùng{" "}
            <code className="font-mono text-xs">drive_desktop_sync</code> (chỉ
            đọc được ổ G:\ trên máy Windows local). Để backend Cloud (Render) và
            Google Colab đọc/ghi Drive, hãy chuyển sang{" "}
            <strong>Apps Script Bridge</strong>.
          </p>
        </div>
      ) : null}

      {!status.oauth_configured && !isNonOauthConnected ? (
        <div className="mt-3 flex items-start gap-2 rounded-control border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800">
          <CloudOff aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            {desktopReady || bridgeReady ? (
              <>
                Không cần Google Cloud Console hay thẻ thanh toán: dùng{" "}
                <strong>Google Drive for Desktop</strong> (giữ nguyên Bảo vệ
                nâng cao) hoặc <strong>Apps Script Bridge</strong> ở nút bên
                dưới.
              </>
            ) : (
              <>
                Server chưa đủ biến môi trường OAuth Google Drive (
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
                ). Cấu hình phía server rồi bấm Kết nối Google Drive.
              </>
            )}
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <div className="rounded-control border border-border p-4 text-sm">
          <p className="font-extrabold">Tài khoản & quyền truy cập</p>
          <dl className="mt-2 space-y-1.5">
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Tài khoản Google</dt>
              <dd className="break-all font-semibold">
                {status.account_email || "Chưa kết nối"}
              </dd>
            </div>
            {status.required_account_email ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Tài khoản chủ Drive (khóa cứng)</dt>
                <dd className="break-all font-mono text-xs font-semibold text-primary">
                  {status.required_account_email}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Phạm vi quyền (Scope)</dt>
              <dd className="flex items-center gap-1 font-mono text-xs">
                {status.scope_valid ? (
                  <>
                    <ShieldCheck
                      aria-hidden
                      className="size-4 text-emerald-600"
                    />
                    <span>
                      {isDesktopConnected
                        ? "Google Drive for Desktop (chính chủ · 0 thẻ)"
                        : isAppsScriptConnected
                          ? "Apps Script Bridge (riêng tư · 0 thẻ)"
                          : "drive.file (tối thiểu)"}
                    </span>
                  </>
                ) : (
                  <span>{status.oauth_scope || "Chưa cấp quyền"}</span>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Thư mục dành riêng</dt>
              <dd className="break-all text-right font-mono text-xs">
                {status.root_folder_path}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Provider ghi Luồng 2</dt>
              <dd className="font-mono text-xs font-bold">{status.provider}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-control border border-border p-4 text-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="font-extrabold">Dung lượng miễn phí & Quota Guard</p>
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
              <span>Đã dùng: {formatBytes(quota.usage_bytes)}</span>
              <span>Còn trống: {formatBytes(quota.available_bytes)}</span>
              <span>Giới hạn: {formatBytes(quota.limit_bytes)}</span>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">
            Vùng đệm an toàn bắt buộc:{" "}
            <strong>{formatBytes(quota.min_free_buffer_bytes)}</strong> ·{" "}
            {quota.can_accept_upload
              ? "Sẵn sàng nhận upload Luồng 2."
              : "Upload tạm dừng an toàn (chưa kết nối hoặc chạm ngưỡng quota)."}
          </p>
        </div>
      </div>

      {selfTestResult ? (
        <div className="mt-4 rounded-control border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-950">
          <div className="flex items-center gap-2 font-bold">
            <CheckCircle2 aria-hidden className="size-4" />
            <span>Kết quả kiểm thử Google Drive (_selftest)</span>
          </div>
          <p className="mt-1">
            Đường dẫn:{" "}
            <code className="font-mono">{selfTestResult.logical_path}</code> ·
            SHA-256:{" "}
            <code className="font-mono">
              {selfTestResult.sha256?.slice(0, 16) ?? "—"}…
            </code>{" "}
            · Riêng tư:{" "}
            <strong>{selfTestResult.is_private ? "Có" : "Không"}</strong> · Đã
            dọn sau kiểm thử:{" "}
            <strong>{selfTestResult.deleted_after_test ? "Có" : "Chưa"}</strong>
          </p>
        </div>
      ) : null}

      {showDesktopForm ? (
        <div className="mt-4 rounded-control border border-primary/30 bg-slate-50 p-4 text-sm">
          <p className="font-extrabold">
            Kết nối Google Drive for Desktop (chính chủ Google · giữ nguyên Bảo
            vệ nâng cao · 0 thẻ)
          </p>
          <p className="mt-1 text-xs text-muted">
            Đăng nhập ứng dụng <strong>Google Drive for Desktop</strong> trên
            Windows bằng đúng tài khoản chủ Drive
            {status.required_account_email
              ? ` (${status.required_account_email})`
              : ""}
            . ViRead Backend sẽ lưu toàn bộ dữ liệu Luồng 2 và resume checkpoint
            của mọi tài khoản Colab vào thư mục đồng bộ này.
          </p>
          <div className="mt-3">
            <label className="block text-xs font-semibold">
              Đường dẫn ổ Google Drive trên Windows (để trống để tự nhận diện ổ
              G:\My Drive)
              <input
                className="mt-1 w-full rounded-control border border-border bg-white px-3 py-2 font-mono text-xs"
                onChange={(e) => setDesktopPath(e.target.value)}
                placeholder={
                  detectedMounts[0]?.drive_root ??
                  "G:\\My Drive (hoặc G:\\Drive của tôi)"
                }
                type="text"
                value={desktopPath}
              />
            </label>
            {detectedMounts.length > 0 ? (
              <p className="mt-1 text-xs text-emerald-700">
                Đã tự phát hiện ổ Google Drive:{" "}
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
              <Link2 aria-hidden className="size-4" /> Xác minh & Lưu kết nối
              Drive Desktop
            </Button>
            <Button
              className="sm:w-auto"
              disabled={busyAction !== null}
              onClick={() => setShowDesktopForm(false)}
              variant="secondary"
            >
              Đóng
            </Button>
          </div>
        </div>
      ) : null}

      {showBridgeForm ? (
        <div className="mt-4 rounded-control border border-primary/30 bg-slate-50 p-4 text-sm">
          <p className="font-extrabold">
            Kết nối Google Drive bằng Apps Script Bridge (0 VNĐ · 0 thẻ · Không
            hết hạn 7 ngày)
          </p>
          <p className="mt-1 text-xs text-muted">
            Mở <code className="font-mono">https://script.google.com/</code>{" "}
            bằng đúng tài khoản chủ Drive
            {status.required_account_email
              ? ` (${status.required_account_email})`
              : ""}
            , dán mã nguồn trong{" "}
            <code className="font-mono">
              scripts/google-apps-script/viread_flow2_drive_bridge.gs
            </code>
            , thiết lập <code className="font-mono">VIREAD_BRIDGE_SECRET</code>{" "}
            trong Script Properties rồi Deploy dạng Web App (Execute as: Me, Who
            has access: Anyone).
          </p>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="block text-xs font-semibold">
              URL ứng dụng web (Apps Script Web App URL)
              <input
                className="mt-1 w-full rounded-control border border-border bg-white px-3 py-2 font-mono text-xs"
                onChange={(e) => setBridgeUrl(e.target.value)}
                placeholder="https://script.google.com/macros/s/.../exec"
                type="url"
                value={bridgeUrl}
              />
            </label>
            <label className="block text-xs font-semibold">
              VIREAD_BRIDGE_SECRET{" "}
              {serverBridgeSecretConfigured
                ? "(để trống sẽ tự dùng khóa đã cài sẵn trên server)"
                : "(bắt buộc >= 32 ký tự)"}
              <input
                className="mt-1 w-full rounded-control border border-border bg-white px-3 py-2 font-mono text-xs"
                onChange={(e) => setBridgeSecret(e.target.value)}
                placeholder={
                  serverBridgeSecretConfigured
                    ? "Đã cấu hình sẵn trên server (có thể bỏ trống)"
                    : "Dán chuỗi bí mật >= 32 ký tự khớp Script Properties"
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
              <Link2 aria-hidden className="size-4" /> Xác minh & Lưu kết nối
              Bridge
            </Button>
            <Button
              className="sm:w-auto"
              disabled={busyAction !== null}
              onClick={() => setShowBridgeForm(false)}
              variant="secondary"
            >
              Đóng
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
              ? "Đổi thư mục Drive Desktop"
              : "Kết nối Google Drive for Desktop (0 thẻ)"}
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
              ? "Đổi URL Apps Script Bridge"
              : "Kết nối không cần thẻ (Apps Script)"}
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
              ? "Kết nối lại Google Drive"
              : "Kết nối Google Drive"}
          </Button>
        ) : null}

        <Button
          className="sm:w-auto"
          disabled={busyAction !== null || !status.connected}
          onClick={() => void handleHealthCheck()}
          variant="secondary"
        >
          <RefreshCw aria-hidden className="size-4" /> Kiểm tra kết nối & dung
          lượng
        </Button>

        <Button
          className="sm:w-auto"
          disabled={busyAction !== null || !status.connected}
          onClick={() => void handleSelfTest()}
          variant="secondary"
        >
          <FlaskConical aria-hidden className="size-4" /> Kiểm thử Upload / Đọc
          / Xóa
        </Button>

        {status.connected ? (
          <Button
            className="sm:w-auto"
            disabled={busyAction !== null}
            onClick={() => void handleDisconnect()}
            variant="secondary"
          >
            <Unplug aria-hidden className="size-4" /> Ngắt kết nối an toàn
          </Button>
        ) : null}
      </div>
    </Card>
  );
}
