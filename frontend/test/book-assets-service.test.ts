import { render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookCover } from "@/components/books/book-cover";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { isStudioAuthenticatedMediaUrl } from "@/lib/api/book-assets-service";
import type { BookListItemDTO } from "@/types/book";
import type { ReadingPageDTO } from "@/types/reading";

const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "m2-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

const BOOK_ID = "11111111-1111-4111-8111-111111111111";
const ASSET_ID = "22222222-2222-4222-8222-222222222222";
const ILL_ASSET_ID = "33333333-3333-4333-8333-333333333333";

const sampleBook: BookListItemDTO = {
  id: BOOK_ID,
  title: "Mèo Con Ra Vườn",
  author: "Tác giả ViRead",
  min_grade: 1,
  max_grade: 3,
  lifecycle_status: "ACTIVE",
};

const samplePage: ReadingPageDTO = {
  page_id: "44444444-4444-4444-8444-444444444444",
  page_revision_id: "55555555-5555-4555-8555-555555555555",
  page_number: 1,
  confidence: 0.98,
  width: 800,
  height: 1200,
  image_url:
    "https://proj.supabase.co/storage/v1/object/sign/readalong-book-pages/books/1/p1.png?token=sig-page",
  text: "Mèo con đi học",
  words: [
    {
      word_id: "w-0",
      word_index: 0,
      text: "Mèo",
      bbox: [0.1, 0.2, 0.12, 0.05],
      line_index: 0,
    },
  ],
};

describe("isStudioAuthenticatedMediaUrl & M2 direct Supabase signed URL routing", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: vi.fn(() => "blob:auth-media"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("distinguishes direct Supabase signed URLs from authenticated proxy media URLs", () => {
    const supabaseSignedCover =
      "https://proj.supabase.co/storage/v1/object/sign/readalong-book-pages/studio/covers/catalog/cover.webp?token=jwt-sig";
    const supabaseSignedIll =
      "https://proj.supabase.co/storage/v1/object/sign/readalong-book-pages/studio/illustrations/catalog/ill.webp?token=jwt-sig";

    expect(isStudioAuthenticatedMediaUrl(supabaseSignedCover)).toBe(false);
    expect(isStudioAuthenticatedMediaUrl(supabaseSignedIll)).toBe(false);
    expect(isStudioAuthenticatedMediaUrl(null)).toBe(false);
    expect(isStudioAuthenticatedMediaUrl(undefined)).toBe(false);
    expect(isStudioAuthenticatedMediaUrl("")).toBe(false);

    expect(
      isStudioAuthenticatedMediaUrl(`/studio/assets/${ASSET_ID}/media`),
    ).toBe(true);
    expect(
      isStudioAuthenticatedMediaUrl(
        `http://127.0.0.1:8000/studio/assets/${ASSET_ID}/media`,
      ),
    ).toBe(true);
    expect(
      isStudioAuthenticatedMediaUrl(
        `/books/my-books/${BOOK_ID}/pages/p1/image?token=abc`,
      ),
    ).toBe(true);
    expect(
      isStudioAuthenticatedMediaUrl(
        `/books/admin/quality/user-books/${BOOK_ID}/pages/p1/image`,
      ),
    ).toBe(true);
  });

  it("renders direct Supabase signed catalog cover URL without authenticated proxy fetch", () => {
    const directUrl =
      "https://proj.supabase.co/storage/v1/object/sign/readalong-book-pages/studio/covers/catalog/c.webp?token=sig-1";

    render(
      createElement(BookCover, {
        book: sampleBook,
        coverSourceType: "USER_UPLOAD",
        coverUrl: directUrl,
      }),
    );

    const img = screen.getByRole("img", {
      name: `Ảnh bìa sách ${sampleBook.title}`,
    });
    expect(img).toHaveAttribute("src", directUrl);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders direct Supabase signed catalog illustration URL directly without Bearer fetch, while private proxy still uses Bearer fetch", async () => {
    const directIllUrl =
      "https://proj.supabase.co/storage/v1/object/sign/readalong-book-pages/studio/illustrations/catalog/i1.webp?token=sig-ill";

    const { unmount } = render(
      createElement(BookPageViewer, {
        currentWordId: "w-0",
        illustrationTextFree: true,
        illustrationUrl: directIllUrl,
        page: samplePage,
        title: sampleBook.title,
      }),
    );

    const illCard = await screen.findByTestId("storybook-illustration-card");
    expect(
      within(illCard).getByRole("img", { name: "Tranh minh họa trang 1" }),
    ).toHaveAttribute("src", directIllUrl);
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();

    fetchMock.mockResolvedValueOnce(
      new Response("webp-bytes", {
        status: 200,
        headers: { "Content-Type": "image/webp" },
      }),
    );

    render(
      createElement(BookPageViewer, {
        currentWordId: "w-0",
        illustrationTextFree: true,
        illustrationUrl: `/studio/assets/${ILL_ASSET_ID}/media`,
        page: samplePage,
        title: sampleBook.title,
      }),
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `http://127.0.0.1:8000/studio/assets/${ILL_ASSET_ID}/media`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer m2-test-token",
          }),
        }),
      );
    });
  });
});
