"use client";

import {
  ArrowRight,
  Camera,
  CheckCircle2,
  Mic,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import {
  clearDevicePermissionVerification,
  markDevicePermissionVerified,
} from "@/lib/api/device-permission-service";
import { useReadingServices } from "@/hooks/use-reading-services";
import type {
  DeviceKind,
  DevicePermissionCheckResult,
  DevicePermissionSnapshotUI,
  DevicePermissionUiState,
} from "@/types/reading";

interface DevicePermissionScreenProps {
  flow?: string;
  childId?: string;
  bookId?: string;
}

interface VerificationState {
  camera: boolean;
  microphone: boolean;
}

const initialSnapshot: DevicePermissionSnapshotUI = {
  camera: "checking",
  microphone: "checking",
};

function statusLabel(status: DevicePermissionUiState): string {
  switch (status) {
    case "checking":
      return "Đang kiểm tra";
    case "prompt":
      return "Chưa cấp quyền";
    case "granted":
    case "ready":
      return "Đã cho phép";
    case "denied":
      return "Đã từ chối quyền";
    case "unavailable":
      return "Thiết bị không khả dụng";
    case "error":
      return "Không thể kiểm tra";
    default:
      return "Chưa xác định";
  }
}

function statusDescription(
  status: DevicePermissionUiState,
  verified: boolean,
  kind: DeviceKind,
): string {
  if (verified) {
    return kind === "camera"
      ? "Camera đã được truy cập thành công và sẵn sàng để quét trang sách."
      : "Microphone đã được truy cập thành công và hỗ trợ ghi âm cho buổi đọc.";
  }

  if (status === "granted" || status === "ready") {
    return "Trình duyệt báo đã cấp quyền. Hãy bấm kiểm tra để xác minh thiết bị thực sự hoạt động.";
  }

  if (status === "prompt") {
    return "ViRead chưa được cấp quyền. Bấm kiểm tra để trình duyệt hiển thị yêu cầu cấp quyền.";
  }

  if (status === "denied") {
    return kind === "camera"
      ? "Camera đang bị chặn. Ba mẹ hãy cho phép Camera trong cài đặt quyền của website rồi thử lại."
      : "Microphone đang bị chặn. Ba mẹ hãy cho phép Microphone trong cài đặt quyền của website rồi thử lại.";
  }

  if (status === "unavailable") {
    return kind === "camera"
      ? "Không tìm thấy camera tương thích hoặc thiết bị không thể khởi động."
      : "Không tìm thấy microphone tương thích hoặc thiết bị không thể khởi động.";
  }

  if (status === "error") {
    return "Trình duyệt không thể kiểm tra thiết bị. Hãy kiểm tra HTTPS, cài đặt website và ứng dụng đang sử dụng thiết bị.";
  }

  return "Trạng thái quyền chưa được trình duyệt cung cấp. ViRead sẽ kiểm tra thiết bị khi ba mẹ bấm nút bên dưới.";
}

function DevicePermissionCard({
  kind,
  status,
  verified,
  disabled,
  onRetry,
}: {
  kind: DeviceKind;
  status: DevicePermissionUiState;
  verified: boolean;
  disabled: boolean;
  onRetry: (kind: DeviceKind) => void;
}) {
  const isCamera = kind === "camera";
  const Icon = isCamera ? Camera : Mic;
  const label = isCamera ? "Camera" : "Microphone";

  return (
    <Card className="h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-card bg-sky text-primary">
          <Icon aria-hidden="true" className="size-7" />
        </div>
        {verified ? (
          <span className="inline-flex items-center gap-1.5 rounded-control bg-success-surface px-3 py-2 text-sm font-bold text-success-ink">
            <CheckCircle2 aria-hidden="true" className="size-4" />
            Đã xác minh
          </span>
        ) : (
          <span className="rounded-control bg-sky px-3 py-2 text-sm font-bold text-primary">
            {statusLabel(status)}
          </span>
        )}
      </div>
      <div>
        <h2 className="text-xl font-extrabold text-ink">{label}</h2>
        <p className="mt-2 text-body text-muted">
          {isCamera
            ? "Sử dụng camera để nhìn trang sách và nhận diện đúng cuốn sách, số trang."
            : "Sử dụng microphone để nghe và ghi nhận giọng đọc của bé trong buổi học."}
        </p>
      </div>
      <p className="text-sm leading-6 text-muted">
        {statusDescription(status, verified, kind)}
      </p>
      <Button
        className="mt-auto"
        disabled={disabled}
        onClick={() => onRetry(kind)}
        variant="secondary"
      >
        <RefreshCw aria-hidden="true" className="size-5" />
        Thử lại quyền {label}
      </Button>
    </Card>
  );
}

export function DevicePermissionScreen({
  flow,
  childId,
  bookId,
}: DevicePermissionScreenProps) {
  const router = useRouter();
  const { devicePermissionService } = useReadingServices();
  const mountedRef = useRef(false);
  const snapshotRequestIdRef = useRef(0);
  const [snapshot, setSnapshot] =
    useState<DevicePermissionSnapshotUI>(initialSnapshot);
  const [verified, setVerified] = useState<VerificationState>({
    camera: false,
    microphone: false,
  });
  const [isChecking, setIsChecking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const scanFlow = flow === "book-scan" ? "book-scan" : "global-book-scan";

  const refreshSnapshot = useCallback(async () => {
    const requestId = ++snapshotRequestIdRef.current;
    try {
      const next = await devicePermissionService.getSnapshot();
      if (
        !mountedRef.current ||
        requestId !== snapshotRequestIdRef.current
      ) return;
      setSnapshot(next);

      setVerified((current) => {
        const nextVerified = {
          camera: next.camera === "denied" ? false : current.camera,
          microphone:
            next.microphone === "denied" ? false : current.microphone,
        };
        if (!nextVerified.camera || !nextVerified.microphone) {
          clearDevicePermissionVerification();
        }
        return nextVerified;
      });
    } catch {
      if (
        mountedRef.current &&
        requestId === snapshotRequestIdRef.current
      ) {
        setSnapshot((current) => ({
          ...current,
          camera: "unknown",
          microphone: "unknown",
        }));
      }
    }
  }, [devicePermissionService]);

  useEffect(() => {
    mountedRef.current = true;
    void refreshSnapshot();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshSnapshot();
      }
    };

    window.addEventListener("focus", refreshSnapshot);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      mountedRef.current = false;
      window.removeEventListener("focus", refreshSnapshot);
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
    };
  }, [refreshSnapshot]);

  const applyDeviceResult = useCallback(
    (
      kind: DeviceKind,
      result: DevicePermissionCheckResult,
      current: VerificationState,
    ): VerificationState => {
      const next = { ...current, [kind]: result.verified };
      setSnapshot((previous) => ({
        ...previous,
        [kind]: result.status,
        mediaRecorderSupported: result.mediaRecorderSupported,
      }));
      setVerified(next);

      if (next.camera && next.microphone) {
        markDevicePermissionVerified();
      } else {
        clearDevicePermissionVerification();
      }

      if (!result.verified) {
        setErrorMessage(result.message);
      } else {
        setErrorMessage(null);
      }

      return next;
    },
    [],
  );

  const handleVerifyAll = useCallback(async () => {
    if (isChecking) return;
    setIsChecking(true);
    snapshotRequestIdRef.current += 1;
    setErrorMessage(null);
    clearDevicePermissionVerification();
    setVerified({ camera: false, microphone: false });

    try {
      const cameraResult =
        await devicePermissionService.requestAccess("camera");
      if (!mountedRef.current) return;

      setSnapshot((previous) => ({
        ...previous,
        camera: cameraResult.status,
        mediaDevicesSupported: true,
      }));
      setVerified({
        camera: cameraResult.verified,
        microphone: false,
      });

      const microphoneResult =
        await devicePermissionService.requestAccess("microphone");
      if (!mountedRef.current) return;

      const nextVerified = {
        camera: cameraResult.verified,
        microphone: microphoneResult.verified,
      };
      setSnapshot((previous) => ({
        ...previous,
        microphone: microphoneResult.status,
        mediaRecorderSupported:
          microphoneResult.mediaRecorderSupported,
      }));
      setVerified(nextVerified);

      if (nextVerified.camera && nextVerified.microphone) {
        markDevicePermissionVerified();
        setErrorMessage(null);
      } else {
        clearDevicePermissionVerification();
        const messages = [
          cameraResult.verified ? null : cameraResult.message,
          microphoneResult.verified ? null : microphoneResult.message,
        ].filter((message): message is string => Boolean(message));
        setErrorMessage(messages.join(" "));
      }
    } catch {
      if (mountedRef.current) {
        clearDevicePermissionVerification();
        setVerified({ camera: false, microphone: false });
        setErrorMessage(
          "Không thể hoàn tất xác minh thiết bị. Ba mẹ hãy thử lại.",
        );
      }
    } finally {
      if (mountedRef.current) setIsChecking(false);
    }
  }, [devicePermissionService, isChecking]);

  const handleRetry = useCallback(
    async (kind: DeviceKind) => {
      if (isChecking) return;
      setIsChecking(true);
      snapshotRequestIdRef.current += 1;
      setErrorMessage(null);

      try {
        const result = await devicePermissionService.requestAccess(kind);
        if (!mountedRef.current) return;
        applyDeviceResult(kind, result, verified);
      } catch {
        if (mountedRef.current) {
          setVerified((current) => ({ ...current, [kind]: false }));
          clearDevicePermissionVerification();
          setErrorMessage(
            "Không thể kiểm tra thiết bị. Ba mẹ hãy thử lại.",
          );
        }
      } finally {
        if (mountedRef.current) setIsChecking(false);
      }
    },
    [applyDeviceResult, devicePermissionService, isChecking, verified],
  );

  const canContinue = verified.camera && verified.microphone;

  const handleContinue = useCallback(() => {
    if (!canContinue) return;

    // Refresh the short-lived in-memory gate immediately before navigation.
    markDevicePermissionVerified();
    const params = new URLSearchParams();
    params.set("flow", scanFlow);
    if (childId) params.set("childId", childId);
    if (bookId) params.set("bookId", bookId);

    router.push(`/book-scanner?${params.toString()}`);
  }, [bookId, canContinue, childId, router, scanFlow]);

  return (
    <section className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-[960px] flex-col gap-6 px-4 py-6 sm:gap-8 sm:py-10">
      <header className="flex flex-col gap-3">
        <p className="text-label font-bold uppercase tracking-wide text-primary">
          ViRead · Chuẩn bị thiết bị
        </p>
        <h1 className="text-heading font-extrabold text-ink">
          Chuẩn bị thiết bị để bé bắt đầu đọc
        </h1>
        <p className="max-w-[760px] text-body leading-7 text-muted">
          ViRead cần camera để nhận diện trang sách và microphone để nghe bé
          đọc. Ba mẹ hãy kiểm tra cả hai thiết bị trước khi tiếp tục. ViRead
          không ghi âm hoặc tải ảnh lên trong bước xác minh này.
        </p>
      </header>

      {snapshot.secureContext === false ||
      snapshot.mediaDevicesSupported === false ? (
        <StatusMessage title="Trình duyệt chưa hỗ trợ truy cập thiết bị" tone="error">
          Camera và microphone cần website HTTPS hoặc localhost cùng trình duyệt
          hỗ trợ MediaDevices. Hãy mở ViRead bằng kết nối bảo mật hoặc cập nhật
          trình duyệt.
        </StatusMessage>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <DevicePermissionCard
          kind="camera"
          status={snapshot.camera}
          verified={verified.camera}
          disabled={isChecking}
          onRetry={handleRetry}
        />
        <DevicePermissionCard
          kind="microphone"
          status={snapshot.microphone}
          verified={verified.microphone}
          disabled={isChecking}
          onRetry={handleRetry}
        />
      </div>

      {snapshot.mediaRecorderSupported === false ? (
        <StatusMessage title="Trình duyệt chưa hỗ trợ ghi âm" tone="error">
          Microphone có thể được cấp quyền nhưng trình duyệt không có
          MediaRecorder. Hãy dùng phiên bản Chrome, Edge, Firefox hoặc Safari
          mới hơn trước khi vào buổi đọc.
        </StatusMessage>
      ) : null}

      {errorMessage ? (
        <StatusMessage title="Chưa thể xác minh đầy đủ thiết bị" tone="error">
          {errorMessage}
          <p className="mt-2">
            Ba mẹ có thể mở biểu tượng cài đặt hoặc biểu tượng ổ khóa cạnh địa
            chỉ website, chọn Cho phép đối với Camera và Microphone, sau đó quay
            lại đây và bấm thử lại.
          </p>
        </StatusMessage>
      ) : null}

      <div className="flex flex-col gap-3 rounded-card border border-border bg-cream p-4 sm:p-6">
        <div className="flex items-start gap-3">
          <Settings2 aria-hidden="true" className="mt-1 size-5 shrink-0 text-primary" />
          <div>
            <h2 className="font-extrabold text-ink">
              Vì sao ViRead cần hai quyền này?
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Camera giúp tìm đúng cuốn sách và trang bé đang mở. Microphone
              giúp ghi nhận giọng đọc để phân tích quá trình luyện đọc. Ba mẹ
              có thể thay đổi quyền bất cứ lúc nào trong cài đặt trình duyệt.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Button
          className="sm:flex-1"
          disabled={isChecking}
          isLoading={isChecking}
          onClick={() => void handleVerifyAll()}
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Kiểm tra và cấp quyền
        </Button>
        <Button
          className="sm:flex-1"
          disabled={!canContinue || isChecking}
          onClick={handleContinue}
        >
          Tiếp tục quét trang sách
          <ArrowRight aria-hidden="true" className="size-5" />
        </Button>
      </div>

      {canContinue ? (
        <StatusMessage title="Thiết bị đã sẵn sàng" tone="success">
          Camera và microphone đều đã được truy cập thành công. Ba mẹ có thể
          tiếp tục sang bước quét trang sách.
        </StatusMessage>
      ) : (
        <StatusMessage title="Chưa thể tiếp tục" tone="info">
          Nút tiếp tục chỉ được mở khi cả camera và microphone đã được xác minh
          bằng truy cập thiết bị thật.
        </StatusMessage>
      )}

      <ButtonLink
        className="sm:max-w-[240px]"
        href="/dashboard"
        variant="quiet"
      >
        Quay lại tổng quan
      </ButtonLink>
    </section>
  );
}
