"use client";

import { ArrowLeft, BookOpen, Camera, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { CameraPreview } from "@/components/reading/camera-preview";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import type { ReadingPageDTO } from "@/types/reading";

interface BookScannerScreenProps {
  bookId?: string;
}

export function BookScannerScreen({ bookId }: BookScannerScreenProps) {
  const router = useRouter();
  const { state: childState, retry: retryChild } = useValidatedSelectedChild();
  const [cameraStarted, setCameraStarted] = useState(false);
  const [cameraUnavailable, setCameraUnavailable] = useState(false);

  const handleCameraUnavailable = useCallback(() => {
    setCameraUnavailable(true);
    setCameraStarted(false);
  }, []);

  const handleBookPageDetected = useCallback(
    (
      matchedBookId: string,
      matchedPage: ReadingPageDTO,
      confidence: number,
    ) => {
      if (!matchedBookId || !matchedPage.page_id) return;
      setCameraStarted(false);
      const params = new URLSearchParams({ pageId: matchedPage.page_id });
      if (Number.isFinite(confidence))
        params.set("confidence", String(confidence));
      router.push(
        `/books/${encodeURIComponent(matchedBookId)}?${params.toString()}`,
      );
    },
    [router],
  );

  if (childState.status === "loading" || childState.status === "redirecting") {
    return (
      <section
        aria-busy="true"
        className="mx-auto w-full max-w-[900px] px-4 py-8"
      >
        <span className="sr-only" role="status">
          Đang xác minh hồ sơ trẻ…
        </span>
      </section>
    );
  }

  if (childState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-4 py-8">
        <StatusMessage title="Không thể xác minh hồ sơ trẻ" tone="error">
          Chưa thể xác nhận hồ sơ thuộc tài khoản hiện tại. Ba mẹ vui lòng thử
          lại.
        </StatusMessage>
        <Button className="sm:w-auto" onClick={retryChild} variant="secondary">
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

  const child = childState.child;

  return (
    <section className="mx-auto flex min-h-[calc(100dvh-5rem)] w-full max-w-[1100px] flex-col gap-5 px-4 py-6 sm:py-8">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
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

      <SelectedChildIdentity child={child} />

      {cameraUnavailable ? (
        <StatusMessage title="Camera chưa sẵn sàng" tone="error">
          Không thể mở camera hoặc quyền camera đã bị thay đổi. Hãy cho phép
          camera trong cài đặt trình duyệt rồi thử lại.
        </StatusMessage>
      ) : null}

      {cameraStarted ? (
        <CameraPreview
          bookId={bookId}
          enableScanner
          onCameraUnavailable={handleCameraUnavailable}
          onBookPageDetected={handleBookPageDetected}
        />
      ) : (
        <div className="flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-card bg-desk p-6 text-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-white text-primary">
            <Camera aria-hidden="true" className="size-8" />
          </span>
          <div>
            <h2 className="text-xl font-extrabold text-ink">Camera đang tắt</h2>
            <p className="mt-2 max-w-[520px] text-body text-muted">
              ViRead chỉ yêu cầu camera sau khi ba mẹ bấm nút bên dưới. Trang
              quét này không yêu cầu quyền microphone.
            </p>
          </div>
          <Button
            className="sm:max-w-[320px]"
            onClick={() => {
              setCameraUnavailable(false);
              setCameraStarted(true);
            }}
          >
            {cameraUnavailable ? (
              <RefreshCw aria-hidden="true" className="size-5" />
            ) : (
              <Camera aria-hidden="true" className="size-5" />
            )}
            {cameraUnavailable ? "Thử bật camera lại" : "Bật camera để quét"}
          </Button>
        </div>
      )}

      <div className="flex items-start gap-3 rounded-card border border-border bg-cream p-4">
        <BookOpen
          aria-hidden="true"
          className="mt-1 size-5 shrink-0 text-primary"
        />
        <p className="text-sm leading-6 text-muted">
          Sau khi nhận diện được trang, ViRead sẽ mở thông tin sách để ba mẹ
          kiểm tra. Buổi đọc chỉ được tạo sau bước xác minh microphone.
        </p>
      </div>
    </section>
  );
}
