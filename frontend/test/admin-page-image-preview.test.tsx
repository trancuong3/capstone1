import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPageImagePreview } from "@/components/admin/admin-page-image-preview";
import type { AdminPageImageUI } from "@/types/admin";

const { getImage, pages, replaceImageAndReprocess } = vi.hoisted(() => {
  const getImage = vi.fn();
  const replaceImageAndReprocess = vi.fn();
  return {
    getImage,
    replaceImageAndReprocess,
    pages: { getImage, replaceImageAndReprocess },
  };
});
vi.mock("@/hooks/use-admin-services", () => ({
  useAdminServices: () => ({ pages }),
}));
const image: AdminPageImageUI = {
  page_id: "page-1",
  page_revision_id: "revision-1",
  page_number: 1,
  preview_url: "https://example.test/first.png",
  width: 600,
  height: 800,
};

describe("admin page image preview", () => {
  beforeEach(() => {
    getImage.mockReset();
    replaceImageAndReprocess.mockReset();
  });

  it("can repair the exact page even when its preview cannot be loaded", async () => {
    getImage.mockRejectedValue(new Error("Missing source object"));
    replaceImageAndReprocess.mockResolvedValue({
      page_id: "page-1",
      page_revision_id: "replacement-1",
      verification_status: "NEEDS_REVIEW",
    });
    const onReplaced = vi.fn();
    const user = userEvent.setup();
    render(
      <AdminPageImagePreview
        pageId="page-1"
        revisionId="revision-1"
        pageNumber={1}
        onReplaced={onReplaced}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Xem ảnh / thay ảnh trang 1" }),
    );
    await screen.findByText("Chưa tải được ảnh trang 1.");
    const file = new File(["synthetic test image"], "page.png", {
      type: "image/png",
    });
    await user.upload(screen.getByLabelText("Chọn ảnh mới cho trang 1"), file);
    await user.click(screen.getByRole("button", { name: "Thay ảnh trang 1" }));
    expect(replaceImageAndReprocess).toHaveBeenCalledWith("page-1", file);
    expect(onReplaced).toHaveBeenCalledOnce();
    await screen.findByText(/Ảnh mới đang chờ duyệt/);
  });

  it("requests the exact page and revision and refreshes an expired image", async () => {
    getImage.mockResolvedValueOnce(image).mockResolvedValueOnce({
      ...image,
      preview_url: "https://example.test/refreshed.png",
    });
    const user = userEvent.setup();
    render(
      <AdminPageImagePreview
        pageId="page-1"
        revisionId="revision-1"
        pageNumber={1}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Xem ảnh / thay ảnh trang 1" }),
    );
    const first = await screen.findByRole("img", { name: "Ảnh trang 1" });
    expect(getImage).toHaveBeenCalledWith("page-1", "revision-1");
    expect(first).toHaveClass("object-contain");
    fireEvent.error(first);
    await user.click(
      screen.getByRole("button", { name: "Tải lại ảnh trang 1" }),
    );
    expect(
      await screen.findByRole("img", { name: "Ảnh trang 1" }),
    ).toHaveAttribute("src", "https://example.test/refreshed.png");
    expect(getImage).toHaveBeenCalledTimes(2);
  });

  it("ignores a late image from a previous page", async () => {
    let resolveOld!: (value: AdminPageImageUI) => void;
    getImage
      .mockImplementationOnce(
        () =>
          new Promise<AdminPageImageUI>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...image,
        page_id: "page-2",
        page_revision_id: "revision-2",
        preview_url: "https://example.test/second.png",
      });
    const user = userEvent.setup();
    const view = render(
      <AdminPageImagePreview
        pageId="page-1"
        revisionId="revision-1"
        pageNumber={1}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: "Xem ảnh / thay ảnh trang 1" }),
    );
    view.rerender(
      <AdminPageImagePreview
        pageId="page-2"
        revisionId="revision-2"
        pageNumber={2}
      />,
    );
    await screen.findByRole("img", { name: "Ảnh trang 2" });
    await act(async () => resolveOld(image));
    expect(screen.getByRole("img", { name: "Ảnh trang 2" })).toHaveAttribute(
      "src",
      "https://example.test/second.png",
    );
  });
});
