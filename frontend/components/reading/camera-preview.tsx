"use client";

import {
  Camera,
  FileImage,
  Play,
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
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import {
  scanCameraFrameForBook,
  scanCameraFrameGlobal,
  type CameraPageMatchDTO,
} from "@/lib/api/page-match-service";
import { isServiceError } from "@/lib/api/service-error";
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
  onPickDeviceImage?: () => void;
}

const AUTO_SCAN_COOLDOWN_MS = 1800;

export function CameraPreview({
  children,
  bookId,
  enableScanner = false,
  onPageDetected,
  onBookPageDetected,
  onCameraUnavailable,
  onPickDeviceImage,
}: CameraPreviewProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("ocr");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mountedRef = useRef(false);
  const scanAbortRef = useRef<AbortController | null>(null);
  const scanInFlightRef = useRef(false);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const cameraRequestRef = useRef<Promise<MediaStream> | null>(null);
  const cameraEffectCountRef = useRef(0);
  const ignoreCameraEndedRef = useRef(false);
  const cameraSuspendedRef = useRef(false);

  const [cameraReady, setCameraReady] = useState(false);
  const [cameraDenied, setCameraDenied] = useState(false);
  const [cameraSuspended, setCameraSuspended] = useState(false);
  const [cameraSessionNonce, setCameraSessionNonce] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [autoScan, setAutoScan] = useState(true);
  const [scanResult, setScanResult] = useState<CameraPageMatchDTO | null>(null);
  const [ocrUnavailableBanner, setOcrUnavailableBanner] = useState<
    string | null
  >(null);
  const consecutiveErrorCountRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scanAbortRef.current?.abort();
      scanAbortRef.current = null;
      scanInFlightRef.current = false;
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

  const resumeCamera = useCallback(() => {
    cameraSuspendedRef.current = false;
    setCameraSuspended(false);
    setCameraDenied(false);
    setAutoScan(true);
    setCameraSessionNonce((prev) => prev + 1);
  }, []);

  useEffect(() => {
    if (!enableScanner) {
      cameraSuspendedRef.current = false;
      return;
    }
    if (cameraSuspendedRef.current) return;

    let active = true;
    cameraEffectCountRef.current += 1;

    let request = cameraRequestRef.current;
    if (!request) {
      if (!navigator.mediaDevices?.getUserMedia) {
        request = Promise.reject(new Error("Camera API unavailable"));
      } else {
        request = navigator.mediaDevices
          .getUserMedia({
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1920 },
              height: { ideal: 1440 },
            },
            audio: false,
          })
          .catch((err: unknown) => {
            if (
              err instanceof DOMException &&
              err.name === "OverconstrainedError"
            ) {
              return navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: "environment" } },
                audio: false,
              });
            }
            throw err;
          });
      }
      cameraRequestRef.current = request;
    }

    void request.then(
      (acquiredStream) => {
        if (cameraRequestRef.current === request) {
          cameraRequestRef.current = null;
        }
        if (!active || !mountedRef.current || cameraSuspendedRef.current) {
          if (
            cameraSuspendedRef.current ||
            cameraEffectCountRef.current === 0
          ) {
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
            scanInFlightRef.current = false;
            setIsScanning(false);
            setCameraDenied(true);
            stopCamera();
            onCameraUnavailable?.();
          },
          { once: true },
        );

        if (videoRef.current) videoRef.current.srcObject = acquiredStream;
        setCameraReady(
          Boolean(videoTrack && videoTrack.readyState === "live") ||
            acquiredStream.getVideoTracks().length > 0,
        );
        setCameraDenied(false);
        setCameraSuspended(false);
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
      scanInFlightRef.current = false;
      if (cameraEffectCountRef.current === 0) stopCamera();
    };
  }, [cameraSessionNonce, enableScanner, onCameraUnavailable, stopCamera]);

  // Release camera tracks immediately when Android Activity enters background or tab hides,
  // while allowing an instant single-tap "Bật lại camera" recovery on return.
  useEffect(() => {
    if (!enableScanner) return;
    const suspend = () => {
      if (cameraSuspendedRef.current) return;
      cameraSuspendedRef.current = true;
      scanAbortRef.current?.abort();
      scanAbortRef.current = null;
      scanInFlightRef.current = false;
      setIsScanning(false);
      setAutoScan(false);
      setCameraSuspended(true);
      stopCamera();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") suspend();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("viread:android-background", suspend);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("viread:android-background", suspend);
    };
  }, [enableScanner, stopCamera]);

  const captureAndScan = useCallback(async () => {
    if (
      !enableScanner ||
      !videoRef.current ||
      !canvasRef.current ||
      scanInFlightRef.current ||
      isScanning ||
      !cameraReady ||
      cameraSuspendedRef.current ||
      !mountedRef.current
    ) {
      return;
    }

    const video = videoRef.current;
    if (video.readyState < 2) return;

    scanInFlightRef.current = true;
    setIsScanning(true);
    const canvas = canvasRef.current;
    const rawW = video.videoWidth || 1200;
    const rawH = video.videoHeight || 1600;
    const maxEdge = 1800;
    const scale = Math.min(1, maxEdge / Math.max(rawW, rawH));
    canvas.width = Math.max(1, Math.round(rawW * scale));
    canvas.height = Math.max(1, Math.round(rawH * scale));

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      scanInFlightRef.current = false;
      setIsScanning(false);
      return;
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;

    await new Promise<void>((resolve) => {
      canvas.toBlob(
        async (blob) => {
          if (!mountedRef.current || controller.signal.aborted) {
            resolve();
            return;
          }
          if (!blob) {
            if (scanAbortRef.current === controller) {
              scanAbortRef.current = null;
              scanInFlightRef.current = false;
              setIsScanning(false);
            }
            resolve();
            return;
          }

          try {
            const response = bookId
              ? await scanCameraFrameForBook(bookId, blob, controller.signal)
              : await scanCameraFrameGlobal(blob, controller.signal);

            if (!mountedRef.current || controller.signal.aborted) {
              resolve();
              return;
            }

            consecutiveErrorCountRef.current = 0;
            setOcrUnavailableBanner(null);

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
                setScanResult({
                  ...response,
                  matched: false,
                  status_code: "LOW_CONFIDENCE",
                  message: response.matched_page
                    ? t("camera.missingBookInfo")
                    : t("camera.invalidPageInfo"),
                });
              }
            } else {
              setScanResult(response);
            }
          } catch (error) {
            if (!mountedRef.current || controller.signal.aborted) {
              resolve();
              return;
            }
            consecutiveErrorCountRef.current += 1;
            const serviceUnavailable =
              isServiceError(error) &&
              (error.status === 503 ||
                error.status === 504 ||
                error.status === 502 ||
                error.status === 429);
            if (serviceUnavailable || consecutiveErrorCountRef.current >= 3) {
              const reason =
                isServiceError(error) && error.status === 504
                  ? "Hệ thống nhận diện trang đang xử lý chậm hơn dự kiến. Tự động quét đã tạm dừng — bấm Thử quét lại khi sẵn sàng."
                  : isServiceError(error) && error.message
                    ? error.message
                    : "Hệ thống nhận diện trang đang tạm nghỉ hoặc tạm bận. Tự động quét đã tạm dừng — bấm Thử quét lại khi sẵn sàng.";
              setAutoScan(false);
              setOcrUnavailableBanner(reason);
              setScanResult({
                framing_valid: false,
                matched: false,
                status_code: "INVALID_IMAGE",
                message: reason,
                confidence: 0,
                matched_page: null,
              });
            } else {
              setScanResult({
                framing_valid: false,
                matched: false,
                status_code: "INVALID_IMAGE",
                message: t("camera.connectingMessage"),
                confidence: 0,
                matched_page: null,
              });
            }
          } finally {
            if (mountedRef.current && scanAbortRef.current === controller) {
              scanAbortRef.current = null;
              scanInFlightRef.current = false;
              setIsScanning(false);
            }
            resolve();
          }
        },
        "image/jpeg",
        0.88,
      );
    });
  }, [
    bookId,
    cameraReady,
    enableScanner,
    isScanning,
    onBookPageDetected,
    onPageDetected,
    stopCamera,
    t,
  ]);

  // Sequential non-overlapping auto-scan loop: schedules the next capture ONLY after
  // any in-flight scan has completed and settled, eliminating overlapping frame spam.
  useEffect(() => {
    if (
      !enableScanner ||
      !autoScan ||
      !cameraReady ||
      cameraSuspended ||
      isScanning ||
      scanResult?.matched
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (document.visibilityState !== "hidden") {
        void captureAndScan();
      }
    }, AUTO_SCAN_COOLDOWN_MS);
    return () => window.clearTimeout(timer);
  }, [
    autoScan,
    cameraReady,
    cameraSuspended,
    captureAndScan,
    enableScanner,
    isScanning,
    scanResult?.matched,
  ]);

  if (!enableScanner) {
    return (
      <section
        aria-label={t("camera.mockPreviewAria")}
        className="relative flex min-h-0 w-full items-center justify-center rounded-card bg-desk p-4 sm:flex-1 sm:p-8"
      >
        <div className="end-3 top-3 absolute z-20 inline-flex items-center gap-2 rounded-control bg-white/90 px-3 py-2 text-[13px] font-semibold text-muted sm:end-5 sm:top-5">
          <VideoOff aria-hidden="true" className="size-4" />
          <span className="hidden sm:inline">
            {t("camera.mockBadgeDesktop")}
          </span>
          <span className="sr-only sm:hidden">{t("camera.mockBadgeSr")}</span>
        </div>
        {children}
      </section>
    );
  }

  const isFrameValid = scanResult?.framing_valid ?? false;
  const isMatched = scanResult?.matched ?? false;

  return (
    <section
      aria-label={t("camera.frameRegionAria")}
      className="relative flex w-full flex-col gap-4 rounded-card bg-desk p-3 sm:p-6"
    >
      {/* Thanh trạng thái hướng dẫn bé đặt sách */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-cream px-3.5 py-2.5 sm:px-4 sm:py-3">
        <p className="text-sm font-semibold text-ink sm:text-body">
          {cameraSuspended
            ? t("camera.pausedStatus")
            : (scanResult?.message ?? t("camera.alignGuideStatus"))}
        </p>

        {scanResult && !cameraSuspended ? (
          <span
            className={cn(
              "rounded-control px-3 py-1 text-xs font-semibold sm:text-[14px]",
              isMatched
                ? "bg-white text-success-ink"
                : isFrameValid
                  ? "bg-white text-primary"
                  : "bg-white text-muted",
            )}
          >
            {isMatched
              ? t("camera.matchedConfidence", {
                  page: formatNumber(scanResult.matched_page?.page_number ?? 0),
                  confidence: Math.round(scanResult.confidence * 100),
                })
              : isFrameValid
                ? t("camera.alignedFindingPage")
                : t("camera.notAligned")}
          </span>
        ) : null}
      </div>

      {ocrUnavailableBanner && !cameraSuspended ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-950"
          data-testid="camera-ocr-unavailable-banner"
          role="status"
        >
          <p className="font-semibold">{ocrUnavailableBanner}</p>
          <Button
            className="min-h-10 sm:w-auto"
            disabled={!cameraReady || isScanning}
            onClick={() => {
              consecutiveErrorCountRef.current = 0;
              setOcrUnavailableBanner(null);
              setAutoScan(true);
              void captureAndScan();
            }}
            size="compact"
            type="button"
            variant="secondary"
          >
            <RefreshCw aria-hidden="true" className="size-4" />
            Thử quét lại
          </Button>
        </div>
      ) : null}

      {/* Portrait-first trên điện thoại (aspect-[3/4]), ngang trên màn hình rộng (sm:aspect-[16/10]) */}
      <div
        data-testid="scanner-camera-viewport"
        className="relative aspect-[3/4] w-full overflow-hidden rounded-card bg-ink sm:aspect-[16/10]"
      >
        {cameraSuspended ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center text-white">
            <Camera aria-hidden="true" className="size-11 text-sky" />
            <p className="text-lg font-extrabold sm:text-[20px]">
              {t("camera.pausedTitle")}
            </p>
            <p className="max-w-md text-sm text-white/85 sm:text-body">
              {t("camera.pausedBody")}
            </p>
            <Button
              className="min-h-12 w-full max-w-[260px]"
              onClick={resumeCamera}
            >
              <Play aria-hidden="true" className="size-4" />
              {t("camera.resumeCamera")}
            </Button>
          </div>
        ) : cameraDenied ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-white">
            <VideoOff aria-hidden="true" className="size-10 text-muted" />
            <p className="text-lg font-semibold sm:text-[20px]">
              {t("camera.deniedTitle")}
            </p>
            <p className="max-w-md text-sm text-white/80 sm:text-body">
              {t("camera.deniedBody")}
            </p>
            <Button
              className="mt-1 min-h-12 w-full max-w-[260px]"
              onClick={resumeCamera}
              variant="secondary"
            >
              {t("camera.retryCamera")}
            </Button>
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

            {/* Khung căn chỉnh sách 4 góc (Portrait-friendly Framing Guide Overlay) */}
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 sm:p-8">
              <div
                className={cn(
                  "relative flex h-[86%] w-[86%] flex-col justify-between rounded-card border-2 border-dashed p-3 transition-colors sm:h-[80%] sm:w-[78%] sm:p-4",
                  isMatched
                    ? "border-success-ink bg-white/10"
                    : isFrameValid
                      ? "border-primary bg-white/5"
                      : "border-white/80 bg-black/15",
                )}
              >
                {/* 4 dấu góc sắc nét định vị trang sách */}
                <span className="absolute -left-0.5 -top-0.5 size-5 rounded-tl-md border-l-4 border-t-4 border-white" />
                <span className="absolute -right-0.5 -top-0.5 size-5 rounded-tr-md border-r-4 border-t-4 border-white" />
                <span className="absolute -bottom-0.5 -left-0.5 size-5 rounded-bl-md border-b-4 border-l-4 border-white" />
                <span className="absolute -bottom-0.5 -right-0.5 size-5 rounded-br-md border-b-4 border-r-4 border-white" />

                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="rounded-control bg-white/92 px-2.5 py-1 text-xs font-bold text-ink shadow">
                    {t("camera.frameBoxLabel")}
                  </span>
                  {isScanning ? (
                    <span className="inline-flex items-center gap-1.5 rounded-control bg-primary px-2.5 py-1 text-xs font-bold text-white shadow">
                      <Sparkles
                        aria-hidden="true"
                        className="size-3.5 animate-spin"
                      />
                      {t("camera.scanningBadge")}
                    </span>
                  ) : null}
                </div>

                <div className="mx-auto rounded-control bg-black/65 px-3 py-1.5 text-center text-xs font-semibold text-white sm:text-[14px]">
                  {isMatched
                    ? t("camera.matchedOverlay", {
                        page: formatNumber(
                          scanResult?.matched_page?.page_number ?? 0,
                        ),
                      })
                    : isFrameValid
                      ? t("camera.holdSteadyOverlay")
                      : t("camera.alignCornersOverlay")}
                </div>
              </div>
            </div>
          </>
        )}
        <canvas ref={canvasRef} className="hidden" />
      </div>

      {/* Thanh nút điều khiển Camera chuẩn thao tác ngón cái trên điện thoại */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Button
          className="min-h-14 w-full"
          disabled={!cameraReady || cameraSuspended || isScanning}
          isLoading={isScanning}
          onClick={() => void captureAndScan()}
        >
          <Camera aria-hidden="true" className="size-5" />
          {t("camera.captureAndScan")}
        </Button>

        <Button
          className="min-h-14 w-full"
          disabled={!cameraReady || cameraSuspended}
          onClick={() => setAutoScan((prev) => !prev)}
          variant="secondary"
        >
          {autoScan ? t("camera.autoScanOn") : t("camera.autoScanOff")}
        </Button>

        {onPickDeviceImage ? (
          <Button
            className="min-h-12 w-full sm:col-span-2"
            onClick={onPickDeviceImage}
            variant="secondary"
          >
            <FileImage aria-hidden="true" className="size-5" />
            {t("camera.fallbackUploadAction")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
