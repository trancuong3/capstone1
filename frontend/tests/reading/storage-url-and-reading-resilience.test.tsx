import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AdminPageImagePreview } from "@/components/admin/admin-page-image-preview";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import type { ReadingPageDTO } from "@/types/reading";

function makePage(imageUrl: string): ReadingPageDTO {
  return {
    page_id: "50000000-0000-4000-8000-000000000001",
    page_revision_id: "60000000-0000-4000-8000-000000000001",
    page_number: 1,
    image_url: imageUrl,
    width: 800,
    height: 1000,
    confidence: 0.99,
    text: "Bé đọc sách.",
    words: [
      {
        word_id: "70000000-0000-4000-8000-000000000001",
        word_index: 0,
        text: "Bé",
        bbox: [0.1, 0.1, 0.15, 0.08],
      },
      {
        word_id: "70000000-0000-4000-8000-000000000002",
        word_index: 1,
        text: "đọc",
        bbox: [0.3, 0.1, 0.15, 0.08],
      },
      {
        word_id: "70000000-0000-4000-8000-000000000003",
        word_index: 2,
        text: "sách.",
        bbox: [0.5, 0.1, 0.2, 0.08],
      },
    ],
  };
}

describe("expired storage URL refresh resilience", () => {
  it("refreshes an expired signed image URL once in BookPageViewer and caps retries on double failure", async () => {
    const refreshMock = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(
        "https://storage.example.com/fresh-signed-url.jpg",
      );

    render(
      <BookPageViewer
        page={makePage("https://storage.example.com/expired-signed-url.jpg")}
        currentWordId="70000000-0000-4000-8000-000000000001"
        onRefreshImageUrl={refreshMock}
      />,
    );

    const details = screen
      .getByText("Xem ảnh trang sách")
      .closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));

    const img = await screen.findByRole("img", {
      name: /Ảnh tham khảo trang 1/,
    });
    expect(img).toHaveAttribute(
      "src",
      "https://storage.example.com/expired-signed-url.jpg",
    );

    fireEvent.error(img);

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1);
      expect(
        screen.getByRole("img", { name: /Ảnh tham khảo trang 1/ }),
      ).toHaveAttribute(
        "src",
        "https://storage.example.com/fresh-signed-url.jpg",
      );
    });

    // If the refreshed URL also fails, stop retrying cleanly without looping
    fireEvent.error(screen.getByRole("img", { name: /Ảnh tham khảo trang 1/ }));
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1);
    });
  });

  it("refreshes an expired Admin page image preview URL once automatically before showing error state", async () => {
    const getImageMock = vi
      .fn()
      .mockResolvedValueOnce({
        page_id: "50000000-0000-4000-8000-000000000001",
        page_revision_id: "60000000-0000-4000-8000-000000000001",
        preview_url: "https://storage.example.com/admin-expired.jpg",
      })
      .mockResolvedValueOnce({
        page_id: "50000000-0000-4000-8000-000000000001",
        page_revision_id: "60000000-0000-4000-8000-000000000001",
        preview_url: "https://storage.example.com/admin-fresh.jpg",
      });

    const services = {
      pages: {
        getImage: getImageMock,
        replaceImageAndReprocess: vi.fn(),
      },
    } as unknown as AdminServices;

    render(
      <AdminServicesContext.Provider value={services}>
        <AdminPageImagePreview
          pageId="50000000-0000-4000-8000-000000000001"
          revisionId="60000000-0000-4000-8000-000000000001"
          pageNumber={1}
        />
      </AdminServicesContext.Provider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Xem ảnh \/ thay ảnh trang 1/ }),
    );

    const firstImg = await screen.findByRole("img", { name: "Ảnh trang 1" });
    expect(firstImg).toHaveAttribute(
      "src",
      "https://storage.example.com/admin-expired.jpg",
    );

    fireEvent.error(firstImg);

    const reloadButton = await screen.findByRole("button", {
      name: "Tải lại ảnh trang 1",
    });
    fireEvent.click(reloadButton);

    await waitFor(() => {
      expect(getImageMock).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("img", { name: "Ảnh trang 1" })).toHaveAttribute(
        "src",
        "https://storage.example.com/admin-fresh.jpg",
      );
    });
  });
});
