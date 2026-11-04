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
  onBookPageDetected?: (
    bookId: string,
    page: ReadingPageDTO,
    confidence: number,
  ) => void;
  onCameraUnavailable?: () => void;
}

export function CameraPreview({
  children,
  bookId,
  enableScanner = false,
  onPageDetected,
  onBookPageDetected,
  onCameraUnavailable,
}: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mountedRef = useRef(false);
  const scanAbortRef = useRef<AbortController | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraRequestRef = useRef<Promise<MediaStream> | null>(null);
  const cameraEffectCountRef = useRef(0);
  const ignoreCameraEndedRef = useRef(false);

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [autoScan, setAutoScan] = useState(true);
  const [scanResult, setScanResult] = useState<CameraPageMatchDTO | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scanAbortRef.current?.abort();
      scanAbortRef.current = null;
    };
  }, []);

  const stopCamera = useCallback(() => {
    const video = videoRef.current;
    const stream =
      cameraStreamRef.current ?? (video?.srcObject as MediaStream | null);
    ignoreCameraEndedRef.current = true;
    cameraStreamRef.current = null;
    if (video && video.srcObject === stream) {
      video.pause();
      video.srcObject = null;
    }
    stream?.getTracks().forEach((track) => track.stop());
    if (canvasRef.current) {
      canvasRef.current.width = 0;
      canvasRef.current.height = 0;
    }
    if (mountedRef.current) setCameraReady(false);
  }, []);

  useEffect(() => {
    if (!enableScanner) return;
    let active = true;
    cameraEffectCountRef.current += 1;

    let request = cameraRequestRef.current;
    if (!request) {
      request = navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });
      cameraRequestRef.current = request;
    }

    void request.then(
      (acquiredStream) => {
        if (cameraRequestRef.current === request) {
          cameraRequestRef.current = null;
        }
        if (!active || !mountedRef.current) {
          if (cameraEffectCountRef.current === 0) {
            acquiredStream.getTracks().forEach((track) => track.stop());
          }
          return;
        }

        cameraStreamRef.current = acquiredStream;
        ignoreCameraEndedRef.current = false;
        const videoTrack = acquiredStream.getVideoTracks()[0];
        videoTrack?.addEventListener(
          "ended",
          () => {
            if (!active || ignoreCameraEndedRef.current) return;
            scanAbortRef.current?.abort();
            scanAbortRef.current = null;
            setIsScanning(false);
            setCameraDenied(true);
            stopCamera();
            onCameraUnavailable?.();
          },
          { once: true },
        );

        if (videoRef.current) videoRef.current.srcObject = acquiredStream;
        setCameraReady(Boolean(videoTrack && videoTrack.readyState === "live"));
        setCameraDenied(false);
      },
      () => {
        if (cameraRequestRef.current === request) {
          cameraRequestRef.current = null;
        }
        if (!active || !mountedRef.current) return;
        setCameraReady(false);
        setCameraDenied(true);
        onCameraUnavailable?.();
      },
    );

    return () => {
      active = false;
      cameraEffectCountRef.current = Math.max(
        0,
        cameraEffectCountRef.current - 1,
      );
      scanAbortRef.current?.abort();
      scanAbortRef.current = null;
      if (cameraEffectCountRef.current === 0) stopCamera();
    };
  }, [enableScanner, onCameraUnavailable, stopCamera]);

  const captureAndScan = useCallback(async () => {
    if (
      !enableScanner ||
      !videoRef.current ||
      !canvasRef.current ||
      isScanning ||
      !cameraReady ||
      !mountedRef.current
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

    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;

    canvas.toBlob(
      async (blob) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        if (!blob) {
          if (scanAbortRef.current === controller) {
            scanAbortRef.current = null;
            setIsScanning(false);
          }
          return;
        }

        try {
          const response = bookId
            ? await scanCameraFrameForBook(bookId, blob, controller.signal)
            : await scanCameraFrameGlobal(blob, controller.signal);

          if (!mountedRef.current || controller.signal.aborted) return;

          const resolvedBookId = response.book_id || bookId;
          if (response.matched) {
            if (response.matched_page && resolvedBookId) {
              setScanResult(response);
              setAutoScan(false);
              scanAbortRef.current?.abort();
              scanAbortRef.current = null;
              stopCamera();
              onPageDetected?.(response.matched_page);
              onBookPageDetected?.(
                resolvedBookId,
                response.matched_page,
                response.confidence,
              );
            } else {
              // A successful match requires both a concrete page and its book.
              setScanResult({
                ...response,
                matched: false,
                status_code: "LOW_CONFIDENCE",
                message: response.matched_page
                  ? "ViRead nhận diện được trang nhưng thiếu thông tin cuốn sách. Ba mẹ hãy căn chỉnh và quét lại nhé."
                  : "ViRead chưa nhận được thông tin trang sách hợp lệ. Ba mẹ hãy căn chỉnh và quét lại nhé.",
              });
            }
          } else {
            setScanResult(response);
          }
        } catch {
          if (!mountedRef.current || controller.signal.aborted) return;
          setScanResult({
            framing_valid: false,
            matched: false,
            status_code: "INVALID_IMAGE",
            message: "Đang kết nối tới ViRead... Bé giữ yên sách nhé!",
            confidence: 0,
            matched_page: null,
          });
        } finally {
          if (mountedRef.current && scanAbortRef.current === controller) {
            scanAbortRef.current = null;
            setIsScanning(false);
          }
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
    stopCamera,
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
      aria-label="Khung camera nhận diện trang sách ViRead"
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
                      ViRead đang quét…
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
