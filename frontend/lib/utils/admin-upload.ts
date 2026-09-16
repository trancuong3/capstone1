import type { AdminPageUploadInputUI } from "@/types/admin";

export const MAX_PAGE_UPLOAD_BYTES = 12 * 1024 * 1024;
export const MAX_PAGE_IMAGE_DIMENSION = 6000;

const allowedTypes = new Set<AdminPageUploadInputUI["mime_type"]>([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface ValidatedUploadFileUI {
  readonly input: AdminPageUploadInputUI | null;
  readonly error: string | null;
}

function isAllowedType(
  value: string,
): value is AdminPageUploadInputUI["mime_type"] {
  return allowedTypes.has(value as AdminPageUploadInputUI["mime_type"]);
}

export function validateUploadFile(
  file: File,
  pageNumber: number,
): ValidatedUploadFileUI {
  if (!isAllowedType(file.type)) {
    return {
      input: null,
      error: `${file.name}: chỉ chấp nhận JPEG, PNG hoặc WebP.`,
    };
  }
  if (file.size > MAX_PAGE_UPLOAD_BYTES) {
    return { input: null, error: `${file.name}: dung lượng vượt quá 12 MB.` };
  }

  return {
    input: {
      client_id: `${pageNumber}-${file.name}-${file.size}`,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
      page_number: pageNumber,
      width: 1200,
      height: 1600,
    },
    error: null,
  };
}

export function validateUploadDimensions(
  input: AdminPageUploadInputUI,
): string | null {
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    return `${input.file_name}: kích thước ảnh không hợp lệ.`;
  }

  return input.width > MAX_PAGE_IMAGE_DIMENSION ||
    input.height > MAX_PAGE_IMAGE_DIMENSION
    ? `${input.file_name}: kích thước ảnh vượt quá 6000 × 6000 px.`
    : null;
}

export function validateUploadInput(
  input: AdminPageUploadInputUI,
): string | null {
  if (!input.file_name.trim() || !isAllowedType(input.mime_type)) {
    return `${input.file_name || "Tệp"}: chỉ chấp nhận JPEG, PNG hoặc WebP.`;
  }

  if (
    !Number.isSafeInteger(input.size_bytes) ||
    input.size_bytes <= 0 ||
    input.size_bytes > MAX_PAGE_UPLOAD_BYTES
  ) {
    return `${input.file_name}: dung lượng phải lớn hơn 0 và không vượt quá 12 MB.`;
  }

  if (!Number.isSafeInteger(input.page_number) || input.page_number < 1) {
    return `${input.file_name}: số trang không hợp lệ.`;
  }

  return validateUploadDimensions(input);
}
