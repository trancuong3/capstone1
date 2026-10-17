"use client";

import {
  Camera,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  VideoOff,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/common/button";
import {
  scanCameraFrameForBook,
  scanCameraFrameGlobal,
  type CameraPageMatchDTO,
} from "@/lib/api/page-match-service";
import { cn } from "@/lib/utils/cn";
import type { ReadingPageDTO } from "@/types/reading";

interface CameraPreviewProps {
  children?: ReactNode;
  bookId?: string;
  enableScanner?: boolean;
  onPageDetected?: (page: ReadingPageDTO) => void;
  onBookPageDetected?: (bookId: string, page: ReadingPageDTO) => void;
}

export function CameraPreview({
  children,
  bookId,
  enableScanner = false,
  onPageDetected,
  onBookPageDetected,
}: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [autoScan, setAutoScan] = useState(true);
  const [scanResult, setScanResult] = useState<CameraPageMatchDTO | null>(null);

  useEffect(() => {
    if (!enableScanner) return;
    let stream: MediaStream | null = null;
    let mounted = true;

    async function initCamera() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        if (!mounted) return;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setCameraReady(true);
        setCameraDenied(false);
      } catch {
        if (!mounted) return;
        setCameraReady(false);
        setCameraDenied(true);
      }
    }

    void initCamera();

    return () => {
      mounted = false;
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [enableScanner]);

  const captureAndScan = useCallback(async () => {
    if (
      !enableScanner ||
      !videoRef.current ||
      !canvasRef.current ||
      isScanning ||
      !cameraReady
    ) {
      return;
    }

    const video = videoRef.current;
    if (video.readyState < 2) return;

    setIsScanning(true);
    const canvas = canvasRef.current;
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setIsScanning(false);
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          setIsScanning(false);
          return;
        }
        try {
          // Nếu có bookId thì quét theo sách, nếu không thì quét tổng quát toàn hệ thống
          const response = bookId
            ? await scanCameraFrameForBook(bookId, blob)
            : await scanCameraFrameGlobal(blob);

          setScanResult(response);

          if (response.matched && response.matched_page) {
            setAutoScan(false);
            onPageDetected?.(response.matched_page);

            const resolvedBookId = response.book_id || bookId;
            if (resolvedBookId) {
              onBookPageDetected?.(resolvedBookId, response.matched_page);
            }
          }
        } catch {
          setScanResult({
            framing_valid: false,
            matched: false,
            status_code: "INVALID_IMAGE",
            message: "Đang kết nối tới ViRead Vision... Bé giữ yên sách nhé!",
            confidence: 0,
            matched_page: null,
          });
        } finally {
          setIsScanning(false);
        }
      },
      "image/jpeg",
      0.85,
    );
  }, [
    bookId,
    cameraReady,
    enableScanner,
    isScanning,
    onBookPageDetected,
    onPageDetected,
  ]);

  useEffect(() => {
    if (!enableScanner || !autoScan || !cameraReady || scanResult?.matched) {
      return;
    }
    const timer = setInterval(() => {
      void captureAndScan();
    }, 2200);
    return () => clearInterval(timer);
  }, [
    autoScan,
    cameraReady,
    captureAndScan,
    enableScanner,
    scanResult?.matched,
  ]);

  if (!enableScanner) {
    return (
      <section
        aria-label="Bản xem trước camera mô phỏng"
        className="relative flex min-h-0 w-full items-center justify-center rounded-card bg-desk p-4 sm:flex-1 sm:p-8"
      >
        <div className="absolute right-3 top-3 z-20 inline-flex items-center gap-2 rounded-control bg-white/90 px-3 py-2 text-[13px] font-bold text-muted sm:right-5 sm:top-5">
          <VideoOff aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">Mô phỏng · không ghi hình</span>
          <span className="sr-only sm:hidden">Mô phỏng, không ghi hình</span>
        </div>
        {children}
      </section>
    );
  }

  const isFrameValid = scanResult?.framing_valid ?? false;
  const isMatched = scanResult?.matched ?? false;

  return (
    <section
      aria-label="Khung camera nhận diện trang sách ViRead Vision"
      className="relative flex w-full flex-col gap-4 rounded-card bg-desk p-4 sm:p-6"
    >
      {/* Thanh trạng thái hướng dẫn bé đặt sách */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-cream px-4 py-3">
        <p className="inline-flex items-center gap-2 text-body font-bold text-ink">
          {isMatched ? (
            <CheckCircle2
              aria-hidden="true"
              className="size-6 text-success-ink"
            />
          ) : (
            <Camera aria-hidden="true" className="size-6 text-primary" />
          )}
          <span>
            {scanResult?.message ??
              "Đặt trang sách nằm gọn vào trong khung viền bên dưới để bắt đầu nhé!"}
          </span>
        </p>

        {scanResult && (
          <span
            className={cn(
              "rounded-control px-3 py-1 text-[14px] font-extrabold",
              isMatched
                ? "bg-white text-success-ink"
                : isFrameValid
                  ? "bg-white text-primary"
                  : "bg-white text-muted",
            )}
          >
            {isMatched
              ? `Trang ${scanResult.matched_page?.page_number} · Độ chính xác ${Math.round(scanResult.confidence * 100)}%`
              : isFrameValid
                ? "Đã đúng khung · Đang tìm trang…"
                : "Chưa đúng khung"}
          </span>
        )}
      </div>

      {/* Màn hình Camera & Khung căn chỉnh đặt sách */}
      <div className="relative aspect-[16/10] w-full overflow-hidden rounded-card bg-ink">
        {cameraDenied ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-white">
            <VideoOff aria-hidden="true" className="size-10 text-muted" />
            <p className="text-[20px] font-bold">
              Chưa bật được Camera trên trình duyệt
            </p>
            <p className="max-w-md text-body text-white/80">
              Ba mẹ vui lòng cấp quyền sử dụng Camera trên thanh địa chỉ trình
              duyệt hoặc chọn trang sách thủ công ở bên dưới nhé.
            </p>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="h-full w-full object-cover"
            />

            {/* Khung căn chỉnh sách (Framing Guide Overlay) */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 sm:p-10">
              <div
                className={cn(
                  "relative flex h-[78%] w-[78%] flex-col justify-between rounded-card border-4 border-dashed p-4 transition-all duration-300",
                  isMatched
                    ? "border-success-ink bg-white/10"
                    : isFrameValid
                      ? "border-primary bg-white/5"
                      : "border-white/80 bg-black/15",
                )}
              >
                {/* 4 góc định vị khung đặt sách */}
                <div className="flex items-center justify-between">
                  <span className="rounded-control bg-white/90 px-3 py-1 text-[13px] font-extrabold text-ink shadow">
                    📖 Khung đặt trang sách
                  </span>
                  {isScanning ? (
                    <span className="inline-flex items-center gap-1.5 rounded-control bg-primary px-3 py-1 text-[13px] font-bold text-white shadow">
                      <Sparkles
                        aria-hidden="true"
                        className="size-4 animate-spin"
                      />
                      ViRead Vision đang quét…
                    </span>
                  ) : null}
                </div>

                <div className="mx-auto rounded-control bg-black/60 px-4 py-1.5 text-center text-[14px] font-bold text-white">
                  {isMatched
                    ? `Đã xác nhận đúng khung — Trang ${scanResult?.matched_page?.page_number}!`
                    : isFrameValid
                      ? "Khung hình hợp lệ! Giữ yên sách để nhận diện trang..."
                      : "Căn chỉnh sao cho 4 mép trang sách nằm gọn trong khung"}
                </div>
              </div>
            </div>
          </>
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>

      {/* Thanh nút điều khiển Camera */}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button
          className="sm:w-auto sm:px-6"
          disabled={!cameraReady || isScanning}
          isLoading={isScanning}
          onClick={() => void captureAndScan()}
        >
          <Camera aria-hidden="true" className="size-5" />
          Xác nhận khung & Quét trang
        </Button>

        <Button
          className="sm:w-auto sm:px-6"
          disabled={!cameraReady}
          onClick={() => setAutoScan((prev) => !prev)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          {autoScan ? "Tự động quét: ĐANG BẬT" : "Tự động quét: ĐANG TẮT"}
        </Button>
      </div>
    </section>
  );
}
