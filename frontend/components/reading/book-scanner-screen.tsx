"use client";

import { ArrowLeft, BookOpen, Camera, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { CameraPreview } from "@/components/reading/camera-preview";
import { consumeDevicePermissionVerification } from "@/lib/api/device-permission-service";
import type { ReadingPageDTO } from "@/types/reading";

interface BookScannerScreenProps {
  childId?: string;
  bookId?: string;
  flow?: string;
}

export function BookScannerScreen({
  childId,
  bookId,
  flow,
}: BookScannerScreenProps) {
  const router = useRouter();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);
  const permissionCheckStartedRef = useRef(false);

  const permissionHref = (() => {
    const params = new URLSearchParams();
    params.set("flow", flow === "book-scan" ? "book-scan" : "global-book-scan");
    if (childId) params.set("childId", childId);
    if (bookId) params.set("bookId", bookId);
    return `/device-permissions?${params.toString()}`;
  })();

  useEffect(() => {
    // React Strict Mode replays effects in development while preserving refs.
    // Do not consume the one-time in-memory ticket twice for the same mount.
    if (permissionCheckStartedRef.current) return;
    permissionCheckStartedRef.current = true;

    if (consumeDevicePermissionVerification()) {
      setIsAuthorized(true);
      return;
    }
    router.replace(permissionHref);
  }, [permissionHref, router]);

  const handleCameraUnavailable = useCallback(() => {
    setCameraUnavailable(true);
  }, []);

  const handleBookPageDetected = useCallback(
    (matchedBookId: string, matchedPage: ReadingPageDTO) => {
      if (!matchedBookId || !matchedPage.page_id) return;

      const params = new URLSearchParams({
        pageId: matchedPage.page_id,
      });
      if (childId) params.set("childId", childId);

      router.push(
        `/books/${encodeURIComponent(matchedBookId)}?${params.toString()}`,
      );
    },
    [childId, router],
  );

  if (!isAuthorized) {
    return (
      <section
        aria-busy="true"
        className="mx-auto flex min-h-[50vh] w-full max-w-[900px] flex-col items-center justify-center gap-3 px-4"
      >
        <span className="size-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-body text-muted">Đang kiểm tra quyền truy cập...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-[1100px] flex-col gap-5 px-4 py-6 sm:py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-label font-bold uppercase tracking-wide text-primary">
            ViRead · Quét trang sách
          </p>
          <h1 className="mt-1 text-heading font-extrabold text-ink">
            Đưa trang sách vào khung camera
          </h1>
          <p className="mt-2 max-w-[720px] text-body leading-7 text-muted">
            Đặt sách ngay ngắn, đủ sáng và giữ trọn trang trong khung. ViRead sẽ
            dùng ảnh camera để tìm cuốn sách và trang tương ứng.
          </p>
        </div>
        <ButtonLink href="/dashboard" variant="quiet" className="sm:w-auto">
          <ArrowLeft aria-hidden="true" className="size-5" />
          Về tổng quan
        </ButtonLink>
      </header>

      {cameraUnavailable ? (
        <StatusMessage title="Camera chưa sẵn sàng" tone="error">
          Không thể mở camera hoặc quyền camera đã bị thay đổi. Hãy xác minh lại
          camera và microphone trước khi quét tiếp.
          <ButtonLink className="mt-3 sm:max-w-[300px]" href={permissionHref}>
            <RefreshCw aria-hidden="true" className="size-5" />
            Kiểm tra lại quyền thiết bị
          </ButtonLink>
        </StatusMessage>
      ) : null}

      {!cameraUnavailable ? (
        <StatusMessage title="Quyền thiết bị đã được xác minh" tone="success">
          Camera đã được kiểm tra ở bước trước. Microphone cũng đã sẵn sàng cho
          buổi đọc sau khi ba mẹ xác nhận đúng sách và trang.
        </StatusMessage>
      ) : null}

      <CameraPreview
        bookId={bookId}
        enableScanner
        onCameraUnavailable={handleCameraUnavailable}
        onBookPageDetected={handleBookPageDetected}
      />

      <div className="flex items-start gap-3 rounded-card border border-border bg-cream p-4">
        <BookOpen aria-hidden="true" className="mt-1 size-5 shrink-0 text-primary" />
        <p className="text-sm leading-6 text-muted">
          Sau khi nhận diện được trang, ViRead sẽ mở thông tin sách để ba mẹ
          kiểm tra. Buổi đọc chỉ bắt đầu khi ba mẹ bấm <strong>Bắt đầu đọc</strong>.
        </p>
      </div>
      <Button
        className="sm:max-w-[280px]"
        onClick={() => router.push(permissionHref)}
        variant="secondary"
      >
        <Camera aria-hidden="true" className="size-5" />
        Kiểm tra lại camera và microphone
      </Button>
    </section>
  );
}
