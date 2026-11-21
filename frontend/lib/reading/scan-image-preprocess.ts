/**
 * Client-side mobile camera photo pre-processing for ViRead OCR & page scanning.
 *
 * Keeps the backend OCR pipeline (PaddleOCR + VietOCR + Tesseract `vie`) 100% unchanged
 * while ensuring phone camera captures (12-48 MP, EXIF-rotated portrait photos) are:
 * 1. Normalized to upright orientation (EXIF Orientation 1..8 -> upright pixels)
 * 2. Downscaled cleanly when exceeding `maxLongEdge` (default 2048px) so uploads stay well
 *    under the 12 MB limit and complete fast over mobile Wi-Fi/4G while preserving sharp
 *    Vietnamese diacritics (`ấ, ể, ữ, ặ, đ`) at high JPEG quality (0.90).
 * 3. Passed through untouched for multipage/document formats (PDF, DOCX, BMP, TIFF) or
 *    already-compact upright images.
 */

const DEFAULT_MAX_LONG_EDGE = 2048;
const DEFAULT_JPEG_QUALITY = 0.9;
const DEFAULT_MAX_PASSTHROUGH_BYTES = 2_200_000;

const RASTER_PHOTO_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/png",
  "image/x-png",
  "image/webp",
]);

export interface PreprocessScanImageOptions {
  readonly maxLongEdge?: number;
  readonly jpegQuality?: number;
  readonly maxPassThroughBytes?: number;
  readonly signal?: AbortSignal;
}

export interface PreprocessScanImageResult {
  readonly file: File;
  readonly wasTransformed: boolean;
  readonly exifOrientation: number;
  readonly width: number;
  readonly height: number;
}

export interface OcrTargetDimensions {
  readonly width: number;
  readonly height: number;
  readonly swappedAxes: boolean;
  readonly scaled: boolean;
}

function isOptimizableRasterPhoto(file: File): boolean {
  const mime = (file.type || "").toLowerCase();
  if (RASTER_PHOTO_MIMES.has(mime)) return true;
  if (mime && !mime.startsWith("image/")) return false;
  const lower = file.name.toLowerCase();
  return (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg") ||
    lower.endsWith(".png") ||
    lower.endsWith(".webp")
  );
}

/**
 * Parse EXIF Orientation tag (0x0112) from the first 64 KB of a JPEG file.
 * Returns 1..8 when present and valid; returns 1 for non-JPEG or untagged files.
 */
export function readJpegExifOrientation(buffer: ArrayBuffer): number {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || view.getUint16(0, false) !== 0xffd8) {
    return 1;
  }

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    const marker = view.getUint16(offset, false);
    offset += 2;
    if (marker === 0xffda || marker === 0xffd9) {
      break;
    }
    if ((marker & 0xff00) !== 0xff00) {
      break;
    }
    if (offset + 2 > view.byteLength) break;
    const segmentLength = view.getUint16(offset, false);
    if (segmentLength < 2 || offset + segmentLength > view.byteLength) {
      break;
    }

    // APP1 marker (0xFFE1) starting with "Exif\0\0"
    if (marker === 0xffe1 && segmentLength >= 10) {
      const exifHeader = view.getUint32(offset + 2, false);
      const exifNull = view.getUint16(offset + 6, false);
      if (exifHeader === 0x45786966 && exifNull === 0x0000) {
        const tiffStart = offset + 8;
        if (tiffStart + 8 > view.byteLength) return 1;
        const byteOrder = view.getUint16(tiffStart, false);
        const littleEndian = byteOrder === 0x4949;
        if (!littleEndian && byteOrder !== 0x4d4d) return 1;
        if (view.getUint16(tiffStart + 2, littleEndian) !== 0x002a) return 1;

        const ifdOffset = view.getUint32(tiffStart + 4, littleEndian);
        const ifdStart = tiffStart + ifdOffset;
        if (ifdStart + 2 > view.byteLength) return 1;

        const entries = view.getUint16(ifdStart, littleEndian);
        for (let i = 0; i < entries; i += 1) {
          const entryOffset = ifdStart + 2 + i * 12;
          if (entryOffset + 12 > view.byteLength) break;
          const tag = view.getUint16(entryOffset, littleEndian);
          if (tag === 0x0112) {
            const value = view.getUint16(entryOffset + 8, littleEndian);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
        return 1;
      }
    }
    offset += segmentLength;
  }
  return 1;
}

export function computeOcrOptimalDimensions(
  rawWidth: number,
  rawHeight: number,
  exifOrientation: number,
  maxLongEdge = DEFAULT_MAX_LONG_EDGE,
): OcrTargetDimensions {
  const safeW = Math.max(1, Math.round(rawWidth));
  const safeH = Math.max(1, Math.round(rawHeight));
  const swappedAxes = exifOrientation >= 5 && exifOrientation <= 8;
  const uprightW = swappedAxes ? safeH : safeW;
  const uprightH = swappedAxes ? safeW : safeH;

  const longEdge = Math.max(uprightW, uprightH);
  if (longEdge <= maxLongEdge) {
    return {
      width: uprightW,
      height: uprightH,
      swappedAxes,
      scaled: false,
    };
  }

  const ratio = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(uprightW * ratio)),
    height: Math.max(1, Math.round(uprightH * ratio)),
    swappedAxes,
    scaled: true,
  };
}

function applyExifCanvasTransform(
  ctx: CanvasRenderingContext2D,
  orientation: number,
  outWidth: number,
  outHeight: number,
): void {
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, outWidth, 0);
      break;
    case 3:
      ctx.transform(-1, 0, 0, -1, outWidth, outHeight);
      break;
    case 4:
      ctx.transform(1, 0, 0, -1, 0, outHeight);
      break;
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.transform(0, 1, -1, 0, outWidth, 0);
      break;
    case 7:
      ctx.transform(0, -1, -1, 0, outWidth, outHeight);
      break;
    case 8:
      ctx.transform(0, -1, 1, 0, 0, outHeight);
      break;
    default:
      break;
  }
}

function normalizeOutputJpegName(originalName: string): string {
  const trimmed = (originalName || "page-scan").trim();
  const base = trimmed.replace(/\.(jpe?g|png|webp)$/iu, "");
  return `${base || "page-scan"}.jpg`;
}

async function decodeRawBitmap(
  file: File,
  detectedExif: number,
): Promise<{ bitmap: ImageBitmap; manualOrientation: number } | null> {
  if (typeof createImageBitmap !== "function") {
    return null;
  }
  try {
    const bitmap = await createImageBitmap(file, {
      imageOrientation: "none",
    });
    return { bitmap, manualOrientation: detectedExif };
  } catch {
    try {
      // Fallback when browser already auto-applied EXIF orientation during decode
      const bitmap = await createImageBitmap(file);
      return { bitmap, manualOrientation: 1 };
    } catch {
      return null;
    }
  }
}

export async function preprocessScanImage(
  file: File,
  options: PreprocessScanImageOptions = {},
): Promise<PreprocessScanImageResult> {
  options.signal?.throwIfAborted?.();

  if (!isOptimizableRasterPhoto(file) || typeof document === "undefined") {
    return {
      file,
      wasTransformed: false,
      exifOrientation: 1,
      width: 0,
      height: 0,
    };
  }

  const maxLongEdge = options.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
  const jpegQuality = options.jpegQuality ?? DEFAULT_JPEG_QUALITY;
  const maxPassThroughBytes =
    options.maxPassThroughBytes ?? DEFAULT_MAX_PASSTHROUGH_BYTES;

  let exifOrientation = 1;
  try {
    const headBuffer = await file.slice(0, 65_536).arrayBuffer();
    exifOrientation = readJpegExifOrientation(headBuffer);
  } catch {
    exifOrientation = 1;
  }
  options.signal?.throwIfAborted?.();

  const decoded = await decodeRawBitmap(file, exifOrientation);
  if (!decoded) {
    return {
      file,
      wasTransformed: false,
      exifOrientation,
      width: 0,
      height: 0,
    };
  }

  const { bitmap, manualOrientation } = decoded;
  try {
    options.signal?.throwIfAborted?.();
    const target = computeOcrOptimalDimensions(
      bitmap.width,
      bitmap.height,
      manualOrientation,
      maxLongEdge,
    );

    const needsTransform =
      manualOrientation !== 1 ||
      target.scaled ||
      file.size > maxPassThroughBytes;

    if (!needsTransform) {
      return {
        file,
        wasTransformed: false,
        exifOrientation,
        width: target.width,
        height: target.height,
      };
    }

    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext("2d");
    if (!ctx || typeof canvas.toBlob !== "function") {
      return {
        file,
        wasTransformed: false,
        exifOrientation,
        width: bitmap.width,
        height: bitmap.height,
      };
    }

    ctx.fillStyle = "#FFFFFF";
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    applyExifCanvasTransform(
      ctx,
      manualOrientation,
      target.width,
      target.height,
    );

    const drawWidth = target.swappedAxes ? target.height : target.width;
    const drawHeight = target.swappedAxes ? target.width : target.height;
    ctx.drawImage(bitmap, 0, 0, drawWidth, drawHeight);
    ctx.restore();

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((out) => resolve(out), "image/jpeg", jpegQuality);
    });
    options.signal?.throwIfAborted?.();

    if (!blob || blob.size <= 0) {
      return {
        file,
        wasTransformed: false,
        exifOrientation,
        width: target.width,
        height: target.height,
      };
    }

    const optimizedFile = new File([blob], normalizeOutputJpegName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified || Date.now(),
    });
    return {
      file: optimizedFile,
      wasTransformed: true,
      exifOrientation,
      width: target.width,
      height: target.height,
    };
  } finally {
    bitmap.close?.();
  }
}
