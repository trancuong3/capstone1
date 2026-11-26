import { isPrivateApiMediaUrl, requestApi } from "@/lib/api/api-client";
import {
  bookAssetsSummarySchema,
  bookCoverDeleteResponseSchema,
  bookCoverGenerateResponseSchema,
  bookPresentationAssetSchema,
  bookStyleBibleSchema,
  pageIllustrationExtractResponseSchema,
  pageIllustrationGenerateResponseSchema,
  type BookAssetsSummaryDTO,
  type BookCoverDeleteResponseDTO,
  type BookCoverGenerateResponseDTO,
  type BookPresentationAssetDTO,
  type BookStyleBibleDTO,
  type CoverCropRect,
  type CoverRotationDegrees,
  type PageIllustrationExtractResponseDTO,
  type PageIllustrationGenerateResponseDTO,
} from "@/types/book-assets";

export function isStudioAuthenticatedMediaUrl(
  url: string | null | undefined,
): boolean {
  if (!url) return false;
  return isPrivateApiMediaUrl(url) || url.includes("/studio/assets/");
}

export interface UploadBookCoverOptions {
  readonly crop?: CoverCropRect | null;
  readonly rotation?: CoverRotationDegrees;
}

export interface GenerateBookCoverOptions {
  readonly prompt_hint?: string | null;
  readonly idempotency_key?: string | null;
  readonly force_regenerate?: boolean;
}

export interface ExtractPageIllustrationOptions {
  readonly word_bboxes?: number[][];
  readonly canonical_text?: string | null;
  readonly apply_clahe_restore?: boolean;
  readonly min_area_ratio?: number;
}

export interface BookAssetsService {
  getBookAssets(
    bookId: string,
    signal?: AbortSignal,
  ): Promise<BookAssetsSummaryDTO>;
  uploadCover(
    bookId: string,
    file: File,
    options?: UploadBookCoverOptions,
  ): Promise<BookPresentationAssetDTO>;
  deleteCover(bookId: string): Promise<BookCoverDeleteResponseDTO>;
  generateAiCover(
    bookId: string,
    options?: GenerateBookCoverOptions,
  ): Promise<BookCoverGenerateResponseDTO>;
  buildStyleBible(
    bookId: string,
    options?: { force_refresh?: boolean; sample_texts?: string[] },
  ): Promise<BookStyleBibleDTO>;
  extractPageIllustration(
    bookId: string,
    pageId: string,
    options?: ExtractPageIllustrationOptions,
  ): Promise<PageIllustrationExtractResponseDTO>;
  generatePageIllustration(
    bookId: string,
    pageId: string,
    options?: { prompt_hint?: string | null; idempotency_key?: string | null },
  ): Promise<PageIllustrationGenerateResponseDTO>;
  moderatePageIllustration(
    bookId: string,
    pageId: string,
    assetId: string,
    action: "APPROVE" | "REJECT" | "RESTORE",
    reason?: string | null,
  ): Promise<BookPresentationAssetDTO>;
}

export function createBookAssetsService(): BookAssetsService {
  return {
    getBookAssets: (bookId, signal) =>
      requestApi(
        `/studio/books/${encodeURIComponent(bookId)}/assets`,
        bookAssetsSummarySchema,
        signal,
        { bypassCache: true },
      ),

    uploadCover: (bookId, file, options) => {
      const form = new FormData();
      form.append("file", file);
      if (options?.rotation !== undefined) {
        form.append("rotation", String(options.rotation));
      }
      if (options?.crop) {
        form.append("crop_x", String(options.crop.crop_x));
        form.append("crop_y", String(options.crop.crop_y));
        form.append("crop_w", String(options.crop.crop_w));
        form.append("crop_h", String(options.crop.crop_h));
      }
      return requestApi(
        `/studio/books/${encodeURIComponent(bookId)}/cover/upload`,
        bookPresentationAssetSchema,
        undefined,
        { method: "POST", body: form },
      );
    },

    deleteCover: (bookId) =>
      requestApi(
        `/studio/books/${encodeURIComponent(bookId)}/cover`,
        bookCoverDeleteResponseSchema,
        undefined,
        { method: "DELETE" },
      ),

    generateAiCover: (bookId, options) =>
      requestApi(
        `/studio/books/${encodeURIComponent(bookId)}/cover/generate`,
        bookCoverGenerateResponseSchema,
        undefined,
        {
          method: "POST",
          body: {
            prompt_hint: options?.prompt_hint?.trim() || null,
            idempotency_key: options?.idempotency_key?.trim() || null,
            force_regenerate: options?.force_regenerate ?? false,
          },
        },
      ),

    buildStyleBible: (bookId, options) =>
      requestApi(
        `/studio/books/${encodeURIComponent(bookId)}/style-bible`,
        bookStyleBibleSchema,
        undefined,
        {
          method: "POST",
          body: {
            force_refresh: options?.force_refresh ?? false,
            sample_texts: options?.sample_texts ?? [],
          },
        },
      ),

    extractPageIllustration: (bookId, pageId, options) =>
      requestApi(
        `/studio/books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}/illustration/extract`,
        pageIllustrationExtractResponseSchema,
        undefined,
        {
          method: "POST",
          body: {
            word_bboxes: options?.word_bboxes ?? [],
            canonical_text: options?.canonical_text ?? null,
            apply_clahe_restore: options?.apply_clahe_restore ?? true,
            min_area_ratio: options?.min_area_ratio ?? 0.12,
          },
        },
      ),

    generatePageIllustration: (bookId, pageId, options) =>
      requestApi(
        `/studio/books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}/illustration/generate`,
        pageIllustrationGenerateResponseSchema,
        undefined,
        {
          method: "POST",
          body: {
            prompt_hint: options?.prompt_hint?.trim() || null,
            idempotency_key: options?.idempotency_key?.trim() || null,
          },
        },
      ),

    moderatePageIllustration: (bookId, pageId, assetId, action, reason) =>
      requestApi(
        `/studio/books/${encodeURIComponent(bookId)}/pages/${encodeURIComponent(pageId)}/illustration/${encodeURIComponent(assetId)}`,
        bookPresentationAssetSchema,
        undefined,
        {
          method: "PATCH",
          body: {
            action,
            reason: reason?.trim() || null,
          },
        },
      ),
  };
}
