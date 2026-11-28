import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { CameraSpotlightOverlay } from "@/components/reading/camera-preview";
import { I18nProvider } from "@/components/i18n/i18n-provider";
import { encodeQrMatrix, renderQrCodeSvg } from "@/lib/books/qr-code-svg";
import {
  clearAllOfflineReadingPacks,
  clearOfflineReadingPacksForUser,
  enqueueOfflineReadingSession,
  listPendingOfflineSessions,
} from "@/lib/offline/offline-reading-pack";
import {
  analyzeLucBatPage,
  doVietnameseSyllablesRhyme,
  isBangTone,
} from "@/lib/reading/luc-bat-cadence";
import type { ReadingPageDTO } from "@/types/reading";

function buildLucBatSamplePage(): ReadingPageDTO {
  const line0 = ["Công", "cha", "như", "núi", "Thái", "Sơn"];
  const line1 = ["Nghĩa", "mẹ", "như", "nước", "trong", "nguồn", "chảy", "ra"];
  const words = [
    ...line0.map((text, idx) => ({
      word_id: `w-0-${idx}`,
      word_index: idx,
      line_index: 0,
      text,
      bbox: [0.1 + idx * 0.1, 0.2, 0.08, 0.04] as [
        number,
        number,
        number,
        number,
      ],
    })),
    ...line1.map((text, idx) => ({
      word_id: `w-1-${idx}`,
      word_index: 6 + idx,
      line_index: 1,
      text,
      bbox: [0.1 + idx * 0.09, 0.3, 0.08, 0.04] as [
        number,
        number,
        number,
        number,
      ],
    })),
  ];
  return {
    page_id: "page-luc-bat-1",
    page_revision_id: "rev-luc-bat-1",
    page_number: 1,
    confidence: null,
    width: 800,
    height: 1120,
    image_url: null,
    image_overlay_safe: false,
    page_kind: "POEM",
    text: `${line0.join(" ")}\n${line1.join(" ")}`,
    words,
    paragraph_start_line_indices: [0],
    indented_line_indices: [0],
  };
}

describe("Wave 3 — Offline Packs, Printable QR, Spotlight & Lục Bát Cadence", () => {
  beforeEach(async () => {
    await clearAllOfflineReadingPacks();
  });

  it("encodes valid ISO/IEC 18004 QR matrix with 3 finder patterns and renders crisp SVG", () => {
    const matrix = encodeQrMatrix(
      "https://viread-frontend.vercel.app/books/123?qr=1",
    );
    expect(matrix.length).toBeGreaterThanOrEqual(29);
    expect(matrix[0].length).toBe(matrix.length);
    // Top-left, top-right, bottom-left 7x7 finder corners must be dark
    expect(matrix[0][0]).toBe(true);
    expect(matrix[0][6]).toBe(true);
    expect(matrix[6][0]).toBe(true);
    expect(matrix[0][matrix.length - 1]).toBe(true);
    expect(matrix[matrix.length - 1][0]).toBe(true);

    const svg = renderQrCodeSvg("https://viread.local/books/abc", {
      size: 200,
      title: "Ca dao Lục Bát",
    });
    expect(svg).toContain("<svg");
    expect(svg).toContain("<title>Ca dao Lục Bát</title>");
    expect(svg).toContain('<path d="M');
  });

  it("strictly isolates offline session outbox by userId and wipes cleanly on actor switch", async () => {
    await enqueueOfflineReadingSession("parent-a", {
      clientSyncId: "sync-a-1",
      childId: "child-a",
      bookId: "book-1",
      startedAt: "2026-11-28T09:00:00Z",
      endedAt: "2026-11-28T09:05:00Z",
      pages: [
        {
          page_id: "p1",
          page_revision_id: "r1",
          completed: true,
          transcript: "Công cha như núi Thái Sơn",
        },
      ],
    });
    await enqueueOfflineReadingSession("parent-b", {
      clientSyncId: "sync-b-1",
      childId: "child-b",
      bookId: "book-2",
      startedAt: "2026-11-28T09:10:00Z",
      endedAt: "2026-11-28T09:15:00Z",
      pages: [
        {
          page_id: "p2",
          page_revision_id: "r2",
          completed: true,
        },
      ],
    });

    const listA = await listPendingOfflineSessions("parent-a");
    const listB = await listPendingOfflineSessions("parent-b");
    expect(listA).toHaveLength(1);
    expect(listA[0].client_sync_id).toBe("sync-a-1");
    expect(listB).toHaveLength(1);
    expect(listB[0].client_sync_id).toBe("sync-b-1");

    await clearOfflineReadingPacksForUser("parent-a");
    expect(await listPendingOfflineSessions("parent-a")).toHaveLength(0);
    expect(await listPendingOfflineSessions("parent-b")).toHaveLength(1);
  });

  it("detects 6-8 Lục Bát couplets & 6th-syllable tones while preserving BookPageViewer DOM invariants", () => {
    expect(isBangTone("Sơn")).toBe(true);
    expect(isBangTone("nguồn")).toBe(true);
    expect(isBangTone("núi")).toBe(false);
    expect(doVietnameseSyllablesRhyme("trăm", "năm")).toBe(true);

    const page = buildLucBatSamplePage();
    const guide = analyzeLucBatPage(page);
    expect(guide.isLucBat).toBe(true);
    expect(guide.couplets).toHaveLength(1);
    expect(guide.couplets[0].lucSixthWord).toBe("Sơn");
    expect(guide.couplets[0].batSixthWord).toBe("nguồn");
    expect(guide.wordAnnotations.get("w-0-5")?.role).toBe("rhyme6_luc");
    expect(guide.wordAnnotations.get("w-1-5")?.role).toBe("rhyme6_bat");
    expect(guide.wordAnnotations.get("w-0-1")?.caesuraAfter).toBe(true);

    const { container } = render(
      <I18nProvider initialLocale="vi">
        <BookPageViewer
          currentWordId="w-0-0"
          lucBatAnnotations={guide.wordAnnotations}
          page={page}
        />
      </I18nProvider>,
    );

    // Must add ZERO extra buttons beyond the 14 word tokens and zero extra aria-hidden spans on POEM pages
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(14);
    expect(container.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(
      0,
    );
    expect(
      container.querySelector('[data-luc-bat-role="rhyme6_luc"]'),
    ).not.toBeNull();
  });

  it("renders projected H^-1 camera line spotlight SVG polygons", () => {
    render(
      <I18nProvider initialLocale="vi">
        <CameraSpotlightOverlay
          activeIndex={0}
          matchedPageNumber={3}
          onActiveIndexChange={() => undefined}
          pageQuad={[
            [0.08, 0.06],
            [0.92, 0.08],
            [0.94, 0.92],
            [0.06, 0.9],
          ]}
          spotlightLines={[
            {
              line_index: 0,
              text: "Công cha như núi Thái Sơn",
              word_count: 6,
              points: [
                [0.12, 0.2],
                [0.82, 0.21],
                [0.82, 0.26],
                [0.12, 0.25],
              ],
            },
          ]}
        />
      </I18nProvider>,
    );

    expect(screen.getByTestId("camera-line-spotlight-svg")).toBeInTheDocument();
    expect(screen.getByText("Công cha như núi Thái Sơn")).toBeInTheDocument();
  });
});
