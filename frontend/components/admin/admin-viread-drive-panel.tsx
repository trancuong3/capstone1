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
  if (
    errorCode === "DRIVE_SCOPE_MISSING" ||
    errorCode === "DRIVE_SCOPE_TOO_BROAD"
  ) {
    return "Quyền OAuth không đúng phạm vi tối thiểu drive.file. Hãy kết nối lại và chấp thuận đúng quyền thư mục riêng của ứng dụng.";
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

  const badge = statusBadge(status);
  const quota = status.quota;
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
    } catch {
      setFeedback({
        tone: "error",
        text: "Không thể khởi tạo OAuth Google Drive. Kiểm tra cấu hình VIREAD_GDRIVE_OAUTH_* và VIREAD_GDRIVE_TOKEN_ENCRYPTION_KEY trên server.",
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
    } catch {
      setFeedback({
        tone: "error",
        text: "Không thể kiểm tra kết nối Google Drive lúc này.",
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
    } catch {
      setFeedback({
        tone: "error",
        text: "Kiểm thử upload/đọc/xóa trên Google Drive thất bại. Kiểm tra quyền ghi và dung lượng trống.",
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
    } catch {
      setFeedback({
        tone: "error",
        text: "Không thể ngắt kết nối Google Drive lúc này.",
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

      {!status.oauth_configured ? (
        <div className="mt-3 flex items-start gap-2 rounded-control border border-slate-300 bg-slate-50 p-3 text-sm text-slate-800">
          <CloudOff aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
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
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Phạm vi quyền (Scope)</dt>
              <dd className="flex items-center gap-1 font-mono text-xs">
                {status.scope_valid ? (
                  <>
                    <ShieldCheck
                      aria-hidden
                      className="size-4 text-emerald-600"
                    />
                    <span>drive.file (tối thiểu)</span>
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

      <div className="mt-4 flex flex-wrap gap-2">
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
