"use client";

import {
  Camera,
  Check,
  Crop,
  ImagePlus,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import { BookCover } from "@/components/books/book-cover";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import {
  createBookAssetsService,
  type BookAssetsService,
} from "@/lib/api/book-assets-service";
import { isServiceError } from "@/lib/api/service-error";
import { preprocessScanImage } from "@/lib/reading/scan-image-preprocess";
import { cn } from "@/lib/utils/cn";
import type { BookListItemDTO } from "@/types/book";
import type {
  AssetSourceType,
  BookAssetsSummaryDTO,
  BookPresentationAssetDTO,
  CoverCropRect,
  CoverRotationDegrees,
} from "@/types/book-assets";

const ACCEPTED_COVER_TYPES =
  "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

type CropPresetKey = "FULL" | "CENTER" | "TOP" | "CUSTOM";

const SOURCE_LABELS: Record<string, string> = {
  USER_UPLOAD: "Ảnh bìa tự tải lên",
  AI_GENERATED: "Ảnh bìa tạo bằng AI",
  METADATA_RENDER: "Bìa chữ tiếng Việt tự động",
};

function normalizeError(error: unknown, fallback: string): string {
  if (isServiceError(error) && error.message) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function presetToCrop(
  preset: Exclude<CropPresetKey, "CUSTOM">,
): CoverCropRect | null {
  if (preset === "FULL") return null;
  if (preset === "CENTER") {
    return { crop_x: 0.1, crop_y: 0.1, crop_w: 0.8, crop_h: 0.8 };
  }
  return { crop_x: 0.08, crop_y: 0.0, crop_w: 0.84, crop_h: 0.84 };
}

export interface BookCoverStudioProps {
  readonly bookId: string;
  readonly bookTitle: string;
  readonly author?: string | null;
  readonly minGrade?: number;
  readonly maxGrade?: number;
  readonly actorRole: "admin" | "parent";
  readonly autoLoad?: boolean;
  readonly initialCoverUrl?: string | null;
  readonly initialCoverSourceType?: AssetSourceType | null;
  readonly service?: BookAssetsService;
  readonly onCoverUpdated?: (asset: BookPresentationAssetDTO | null) => void;
  readonly className?: string;
}

export function BookCoverStudio({
  bookId,
  bookTitle,
  author = null,
  minGrade = 1,
  maxGrade = 3,
  actorRole,
  autoLoad = true,
  initialCoverUrl = null,
  initialCoverSourceType = null,
  service: injectedService,
  onCoverUpdated,
  className,
}: BookCoverStudioProps) {
  const defaultService = useMemo(() => createBookAssetsService(), []);
  const service = injectedService ?? defaultService;

  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const [summary, setSummary] = useState<BookAssetsSummaryDTO | null>(null);
  const [loadedBookId, setLoadedBookId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<
    "upload" | "delete" | "ai" | null
  >(null);
  const [notice, setNotice] = useState<{
    tone: "info" | "error";
    title?: string;
    message: string;
  } | null>(null);

  // Staged local upload state (before clicking "Lưu ảnh bìa")
  const [stagedFile, setStagedFile] = useState<File | null>(null);
  const [stagedPreviewUrl, setStagedPreviewUrl] = useState<string | null>(null);
  const [rotation, setRotation] = useState<CoverRotationDegrees>(0);
  const [cropPreset, setCropPreset] = useState<CropPresetKey>("FULL");
  const [customCrop, setCustomCrop] = useState<CoverCropRect>({
    crop_x: 0.1,
    crop_y: 0.1,
    crop_w: 0.8,
    crop_h: 0.8,
  });
  const [aiPromptHint, setAiPromptHint] = useState("");

  useEffect(() => {
    if (!autoLoad) return;
    const controller = new AbortController();
    let active = true;
    void service
      .getBookAssets(bookId, controller.signal)
      .then((data) => {
        if (!active) return;
        setSummary(data);
        setLoadedBookId(bookId);
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setLoadedBookId(bookId);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [autoLoad, bookId, service]);

  useEffect(() => {
    return () => {
      if (stagedPreviewUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(stagedPreviewUrl);
      }
    };
  }, [stagedPreviewUrl]);

  const clearStagedFile = useCallback(() => {
    setStagedFile(null);
    setStagedPreviewUrl((prev) => {
      if (prev && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(prev);
      }
      return null;
    });
    setRotation(0);
    setCropPreset("FULL");
  }, []);

  const handleFileSelected = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      setNotice(null);

      try {
        const prepared = await preprocessScanImage(file, { maxLongEdge: 2048 });
        const readyFile = prepared.file;
        const previewUrl =
          typeof URL !== "undefined" &&
          typeof URL.createObjectURL === "function"
            ? URL.createObjectURL(readyFile)
            : null;
        setStagedPreviewUrl((prev) => {
          if (prev && typeof URL.revokeObjectURL === "function") {
            URL.revokeObjectURL(prev);
          }
          return previewUrl;
        });
        setStagedFile(readyFile);
        setRotation(0);
        setCropPreset("FULL");
      } catch {
        setNotice({
          tone: "error",
          message:
            "Không thể đọc tệp ảnh bìa. Hãy chọn ảnh JPG, PNG hoặc WEBP hợp lệ.",
        });
      }
    },
    [],
  );

  const activeCrop: CoverCropRect | null =
    cropPreset === "CUSTOM" ? customCrop : presetToCrop(cropPreset);

  const handleUploadStaged = async () => {
    if (!stagedFile || busyAction) return;
    setBusyAction("upload");
    setNotice(null);
    try {
      const saved = await service.uploadCover(bookId, stagedFile, {
        crop: activeCrop,
        rotation,
      });
      setSummary((prev) =>
        prev
          ? {
              ...prev,
              active_cover: saved,
              effective_cover_source: "USER_UPLOAD",
            }
          : prev,
      );
      onCoverUpdated?.(saved);
      clearStagedFile();
      setNotice({
        tone: "info",
        title: "Đã lưu ảnh bìa mới",
        message:
          actorRole === "parent"
            ? "Ảnh bìa đã được tối ưu WebP và cập nhật ngay mà không ảnh hưởng các trang sách đã thêm."
            : "Ảnh bìa đã được tối ưu 3:4 WebP và ưu tiên hiển thị cao nhất cho sách này.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: normalizeError(
          error,
          "Không thể tải lên ảnh bìa. Hãy kiểm tra định dạng ảnh JPG/PNG/WEBP (<= 10 MB).",
        ),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteCover = async () => {
    if (busyAction) return;
    setBusyAction("delete");
    setNotice(null);
    try {
      const res = await service.deleteCover(bookId);
      setSummary((prev) =>
        prev
          ? {
              ...prev,
              active_cover: null,
              effective_cover_source: "METADATA_RENDER",
              metadata_fallback: res.metadata_fallback,
            }
          : prev,
      );
      onCoverUpdated?.(null);
      setNotice({
        tone: "info",
        title: "Đã gỡ ảnh bìa",
        message: res.message_vi,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message: normalizeError(error, "Không thể gỡ ảnh bìa lúc này."),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const handleGenerateAiCover = async () => {
    if (busyAction) return;
    setBusyAction("ai");
    setNotice(null);
    try {
      const res = await service.generateAiCover(bookId, {
        prompt_hint: aiPromptHint.trim() || null,
      });
      if (res.status === "SUCCEEDED" && res.cover) {
        setSummary((prev) =>
          prev
            ? {
                ...prev,
                active_cover: res.cover,
                effective_cover_source: "AI_GENERATED",
                style_bible: res.style_bible ?? prev.style_bible,
              }
            : prev,
        );
        onCoverUpdated?.(res.cover);
        setNotice({
          tone: "info",
          title: "Đã tạo bìa bằng AI",
          message: res.message_vi,
        });
      } else {
        setNotice({
          tone: "info",
          title:
            res.status === "WAITING_FOR_QUOTA"
              ? "Tạm hết hạn mức tạo ảnh AI"
              : res.status === "SUPERSEDED_BY_USER_UPLOAD"
                ? "Đang giữ ảnh bìa người dùng tải lên"
                : "Chưa có nhà cung cấp tạo ảnh AI",
          message: res.message_vi,
        });
      }
    } catch (error) {
      setNotice({
        tone: "error",
        message: normalizeError(
          error,
          "Không thể gọi dịch vụ tạo bìa AI lúc này. Bìa chữ tiếng Việt vẫn được giữ nguyên.",
        ),
      });
    } finally {
      setBusyAction(null);
    }
  };

  const activeCoverAsset = summary?.active_cover ?? null;
  const effectiveCoverUrl = activeCoverAsset?.media_url ?? initialCoverUrl;
  const effectiveSourceType: AssetSourceType =
    summary?.effective_cover_source ??
    (effectiveCoverUrl
      ? (initialCoverSourceType ?? "USER_UPLOAD")
      : "METADATA_RENDER");
  const hasRealCover =
    Boolean(effectiveCoverUrl) && effectiveSourceType !== "METADATA_RENDER";
  const isInitialLoading = autoLoad && loadedBookId !== bookId;

  const previewBook: BookListItemDTO = {
    id: bookId,
    title: bookTitle || "Sách đọc ViRead",
    author,
    min_grade: minGrade,
    max_grade: maxGrade,
    lifecycle_status: "ACTIVE",
  };

  const gradeText =
    minGrade === maxGrade ? `Lớp ${minGrade}` : `Lớp ${minGrade}–${maxGrade}`;

  return (
    <section
      aria-label="Studio ảnh bìa sách"
      className={cn(
        "flex flex-col gap-4 rounded-card border border-border bg-white p-4 sm:p-5",
        className,
      )}
      data-testid="book-cover-studio"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-lg font-extrabold text-ink">
            Studio ảnh bìa sách
          </h3>
          <p className="mt-0.5 text-xs text-muted">
            {actorRole === "parent"
              ? "Thay đổi ảnh bìa độc lập hoàn toàn, không làm kiểm tra lại OCR hay kiểm duyệt an toàn các trang sách đã thêm."
              : "Tải lên, cắt khung 3:4, xoay ảnh hoặc tạo bìa AI miễn phí. Ảnh bìa tự tải lên luôn được ưu tiên cao nhất."}
          </p>
        </div>
        <span
          className="inline-flex items-center rounded-full border border-border bg-canvas px-2.5 py-1 text-xs font-bold text-ink"
          data-testid="cover-source-badge"
        >
          {SOURCE_LABELS[effectiveSourceType] ?? "Bìa chữ tiếng Việt tự động"}
        </span>
      </div>

      {notice ? (
        <StatusMessage title={notice.title} tone={notice.tone}>
          {notice.message}
        </StatusMessage>
      ) : null}

      <div className="grid gap-5 md:grid-cols-[200px_1fr]">
        {/* 3:4 Cover Preview Column */}
        <div className="flex flex-col items-center gap-2">
          <div className="relative aspect-[3/4] w-[180px] overflow-hidden rounded-card border border-border bg-cream shadow-xs">
            {stagedPreviewUrl ? (
              <div
                className="relative h-full w-full overflow-hidden"
                data-testid="staged-cover-preview"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  alt={`Xem trước ảnh bìa mới cho ${bookTitle}`}
                  className="h-full w-full object-cover transition-transform duration-150"
                  src={stagedPreviewUrl}
                  style={{ transform: `rotate(${rotation}deg)` }}
                />
                {activeCrop ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute border-2 border-dashed border-primary bg-primary/10"
                    style={{
                      left: `${activeCrop.crop_x * 100}%`,
                      top: `${activeCrop.crop_y * 100}%`,
                      width: `${activeCrop.crop_w * 100}%`,
                      height: `${activeCrop.crop_h * 100}%`,
                    }}
                  />
                ) : null}
              </div>
            ) : (
              <BookCover
                author={author}
                book={previewBook}
                className="h-full w-full"
                coverSourceType={effectiveSourceType}
                coverUrl={effectiveCoverUrl}
                grade={gradeText}
                showTitle
              />
            )}
          </div>
          <p className="text-center text-[11px] font-medium text-muted">
            {isInitialLoading
              ? "Đang tải trạng thái ảnh bìa…"
              : stagedFile
                ? `Đã chọn: ${stagedFile.name} · Xoay ${rotation}°`
                : "Tỷ lệ chuẩn 3:4 (≤ 300 KB WebP)"}
          </p>
        </div>

        {/* Controls Column */}
        <div className="flex min-w-0 flex-col gap-3">
          {/* Dual Android WebView-safe inputs (Camera capture + Gallery picker) */}
          <input
            ref={cameraInputRef}
            accept={ACCEPTED_COVER_TYPES}
            aria-label="Chụp ảnh bìa bằng máy ảnh"
            capture="environment"
            className="hidden"
            data-testid="cover-camera-input"
            onChange={(event) => void handleFileSelected(event)}
            type="file"
          />
          <input
            ref={galleryInputRef}
            accept={ACCEPTED_COVER_TYPES}
            aria-label="Chọn ảnh bìa từ thư viện"
            className="hidden"
            data-testid="cover-gallery-input"
            onChange={(event) => void handleFileSelected(event)}
            type="file"
          />

          <div className="flex flex-wrap gap-2">
            <Button
              className="min-h-11 w-auto px-3.5 text-xs"
              disabled={busyAction !== null}
              fullWidth={false}
              onClick={() => cameraInputRef.current?.click()}
              type="button"
              variant="secondary"
            >
              <Camera aria-hidden="true" className="size-4" />
              Chụp ảnh bìa
            </Button>
            <Button
              className="min-h-11 w-auto px-3.5 text-xs"
              disabled={busyAction !== null}
              fullWidth={false}
              onClick={() => galleryInputRef.current?.click()}
              type="button"
              variant="secondary"
            >
              <ImagePlus aria-hidden="true" className="size-4" />
              {hasRealCover ? "Thay ảnh từ thư viện" : "Chọn từ thư viện"}
            </Button>
            {hasRealCover && !stagedFile ? (
              <Button
                className="min-h-11 w-auto px-3.5 text-xs"
                disabled={busyAction !== null}
                fullWidth={false}
                isLoading={busyAction === "delete"}
                onClick={() => void handleDeleteCover()}
                type="button"
                variant="destructive"
              >
                <Trash2 aria-hidden="true" className="size-4" />
                Xóa ảnh bìa
              </Button>
            ) : null}
          </div>

          {/* Crop 3:4 & Rotate 90° editor when a local file is staged */}
          {stagedFile ? (
            <div
              className="flex flex-col gap-3 rounded-control border border-primary/30 bg-sky/40 p-3"
              data-testid="cover-crop-rotate-panel"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="inline-flex items-center gap-1.5 text-xs font-bold text-ink">
                  <Crop aria-hidden="true" className="size-4 text-primary" />
                  Chỉnh khung cắt 3:4 & xoay ảnh
                </p>
                <Button
                  className="min-h-10 w-auto px-3 text-xs"
                  disabled={busyAction !== null}
                  fullWidth={false}
                  onClick={() =>
                    setRotation(
                      (prev) => ((prev + 90) % 360) as CoverRotationDegrees,
                    )
                  }
                  type="button"
                  variant="secondary"
                >
                  <RotateCw aria-hidden="true" className="size-3.5" />
                  Xoay 90° ({rotation}°)
                </Button>
              </div>

              <div
                aria-label="Chọn khung cắt 3:4"
                className="flex flex-wrap gap-1.5"
                role="group"
              >
                {(
                  [
                    ["FULL", "Toàn khung 3:4"],
                    ["CENTER", "Cắt giữa 80%"],
                    ["TOP", "Ưu tiên phần trên"],
                    ["CUSTOM", "Tùy chỉnh"],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    aria-pressed={cropPreset === key}
                    className={cn(
                      "min-h-9 rounded-full border px-3 text-xs font-semibold transition-colors",
                      cropPreset === key
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-white text-ink hover:bg-canvas",
                    )}
                    onClick={() => setCropPreset(key)}
                    type="button"
                  >
                    {label}
                  </button>
                ))}
              </div>

              {cropPreset === "CUSTOM" ? (
                <div className="grid gap-2 sm:grid-cols-3">
                  <label className="flex flex-col gap-1 text-[11px] font-semibold text-ink">
                    Dịch ngang ({Math.round(customCrop.crop_x * 100)}%)
                    <input
                      aria-label="Vị trí cắt ngang"
                      max={Math.round((1 - customCrop.crop_w) * 100)}
                      min={0}
                      onChange={(event) => {
                        const x = Number(event.target.value) / 100;
                        setCustomCrop((prev) => ({ ...prev, crop_x: x }));
                      }}
                      type="range"
                      value={Math.round(customCrop.crop_x * 100)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] font-semibold text-ink">
                    Dịch dọc ({Math.round(customCrop.crop_y * 100)}%)
                    <input
                      aria-label="Vị trí cắt dọc"
                      max={Math.round((1 - customCrop.crop_h) * 100)}
                      min={0}
                      onChange={(event) => {
                        const y = Number(event.target.value) / 100;
                        setCustomCrop((prev) => ({ ...prev, crop_y: y }));
                      }}
                      type="range"
                      value={Math.round(customCrop.crop_y * 100)}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] font-semibold text-ink">
                    Kích thước khung ({Math.round(customCrop.crop_w * 100)}%)
                    <input
                      aria-label="Kích thước khung cắt"
                      max={100}
                      min={30}
                      onChange={(event) => {
                        const size = Number(event.target.value) / 100;
                        setCustomCrop((prev) => ({
                          crop_x: Math.min(prev.crop_x, 1 - size),
                          crop_y: Math.min(prev.crop_y, 1 - size),
                          crop_w: size,
                          crop_h: size,
                        }));
                      }}
                      type="range"
                      value={Math.round(customCrop.crop_w * 100)}
                    />
                  </label>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  className="min-h-11 w-auto px-4 text-xs"
                  disabled={busyAction !== null}
                  fullWidth={false}
                  isLoading={busyAction === "upload"}
                  onClick={() => void handleUploadStaged()}
                  type="button"
                >
                  <Check aria-hidden="true" className="size-4" />
                  Lưu ảnh bìa
                </Button>
                <Button
                  className="min-h-11 w-auto px-3 text-xs"
                  disabled={busyAction !== null}
                  fullWidth={false}
                  onClick={clearStagedFile}
                  type="button"
                  variant="secondary"
                >
                  <X aria-hidden="true" className="size-4" />
                  Hủy chọn
                </Button>
              </div>
            </div>
          ) : null}

          {/* Honest AI Cover Generation section */}
          <div className="flex flex-col gap-2 rounded-control border border-border bg-canvas/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="inline-flex items-center gap-1.5 text-xs font-bold text-ink">
                <Sparkles
                  aria-hidden="true"
                  className="size-3.5 text-primary"
                />
                Tạo bìa bằng AI (miễn phí 0 VND)
              </p>
              {summary ? (
                <span className="text-[11px] font-semibold text-muted">
                  {summary.ai_image_provider_available
                    ? `Nhà cung cấp: ${summary.ai_image_provider_name ?? "AI"}`
                    : "Chưa cấu hình nhà cung cấp tạo ảnh AI"}
                </span>
              ) : null}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                aria-label="Gợi ý cảnh cho bìa AI"
                className="min-h-10 flex-1 rounded-control border border-border bg-white px-3 text-xs text-ink placeholder:text-muted"
                onChange={(event) => setAiPromptHint(event.target.value)}
                placeholder="Gợi ý cảnh tùy chọn (ví dụ: mèo con bên cửa sổ nắng sớm)…"
                type="text"
                value={aiPromptHint}
              />
              <Button
                className="min-h-10 w-auto shrink-0 px-3.5 text-xs"
                disabled={busyAction !== null}
                fullWidth={false}
                isLoading={busyAction === "ai"}
                onClick={() => void handleGenerateAiCover()}
                type="button"
                variant="secondary"
              >
                <Sparkles aria-hidden="true" className="size-3.5" />
                Tạo bìa bằng AI
              </Button>
            </div>
            {summary && !summary.ai_image_provider_available ? (
              <p className="text-[11px] text-muted">
                {summary.ai_image_provider_message_vi}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
