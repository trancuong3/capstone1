"use client";

import { Camera, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { CameraPreview } from "@/components/reading/camera-preview";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import { cn } from "@/lib/utils/cn";
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
        className="mx-auto w-full max-w-[960px] px-4 py-8"
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
    <section
      className={cn(
        "mx-auto flex w-full flex-col gap-6",
        cameraStarted ? "max-w-[1120px]" : "max-w-[960px]",
      )}
    >
      <header className="border-b border-border pb-5">
        <div>
          <p className="text-label font-semibold text-muted">
            {child.alias} · Lớp {child.grade}
          </p>
          <h1 className="mt-1 text-heading font-extrabold text-ink">
            Đưa trang sách vào khung camera
          </h1>
          <p className="mt-2 max-w-[720px] text-body leading-7 text-muted">
            Đặt sách ngay ngắn, đủ sáng và giữ trọn trang trong khung. ViRead sẽ
            dùng ảnh camera để tìm cuốn sách và trang tương ứng.
          </p>
        </div>
      </header>

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
        <div className="flex min-h-[380px] flex-col items-center justify-center gap-4 rounded-card bg-desk p-6 text-center">
          <Camera aria-hidden="true" className="size-14 text-primary" />
          <div>
            <h2 className="text-2xl font-extrabold text-ink">
              Camera đang tắt
            </h2>
            <p className="mt-6 max-w-[620px] text-body text-muted">
              Camera chỉ bật khi ba mẹ chọn nút bên dưới. Bước này chưa sử dụng
              microphone.
            </p>
          </div>
          <Button
            className="min-h-16 sm:max-w-[400px]"
            onClick={() => {
              setCameraUnavailable(false);
              setCameraStarted(true);
            }}
          >
            Bật camera để quét
          </Button>
        </div>
      )}

      {!cameraUnavailable ? (
        <div className="rounded-card bg-sky p-4">
          <h2 className="font-extrabold text-ink">Sau khi nhận diện</h2>
          <p className="mt-2 text-body text-muted">
            ViRead mở chi tiết sách để ba mẹ chọn phạm vi trang. Microphone được
            kiểm tra ở bước chuẩn bị đọc.
          </p>
        </div>
      ) : null}

      {!cameraStarted || cameraUnavailable ? (
        <ButtonLink
          className="min-h-16 sm:max-w-[400px]"
          href="/books"
          variant="secondary"
        >
          Chọn sách từ thư viện
        </ButtonLink>
      ) : null}
    </section>
  );
}
