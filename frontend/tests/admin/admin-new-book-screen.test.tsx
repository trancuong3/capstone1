import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminNewBookScreen } from "@/components/admin/admin-new-book-screen";
import {
  adminBookFixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";

const { routerMock } = vi.hoisted(() => ({
  routerMock: { push: vi.fn(), refresh: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

describe("AdminNewBookScreen", () => {
  beforeEach(() => {
    routerMock.push.mockReset();
    routerMock.refresh.mockReset();
  });

  it("renders a visible required title field on the create-book form", () => {
    const services = createAdminServiceFixture();
    render(withAdminFixture(<AdminNewBookScreen />, services));

    const title = screen.getByRole("textbox", { name: "Tiêu đề sách *" });
    expect(title).toBeRequired();
    expect(title).toHaveAttribute("maxLength", "250");
  });

  it.each(["", "   "])(
    "rejects an empty or whitespace-only title (%j) without calling the service",
    async (enteredTitle) => {
      const services = createAdminServiceFixture();
      const user = userEvent.setup();
      render(withAdminFixture(<AdminNewBookScreen />, services));

      const title = screen.getByRole("textbox", { name: "Tiêu đề sách *" });
      if (enteredTitle) await user.type(title, enteredTitle);
      await user.click(screen.getByRole("button", { name: "Tạo sách" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Vui lòng nhập tiêu đề sách.",
      );
      expect(title).toHaveAttribute("aria-invalid", "true");
      expect(title).toHaveValue(enteredTitle);
      expect(services.books.create).not.toHaveBeenCalled();
      expect(routerMock.push).not.toHaveBeenCalled();
    },
  );

  it(
    "trims the title, sends the expected payload, and navigates after success",
    async () => {
      const services = createAdminServiceFixture();
      vi.mocked(services.books.create).mockResolvedValue({
        ...adminBookFixture,
        id: "81000000-0000-4000-8000-000000000099",
        title: "Sách mới",
      });
      const user = userEvent.setup();
      render(withAdminFixture(<AdminNewBookScreen />, services));

      await user.type(
        screen.getByRole("textbox", { name: "Tiêu đề sách *" }),
        "  Sách mới  ",
      );
      await user.type(screen.getByRole("textbox", { name: /Tác giả/ }), "  ");
      await user.click(screen.getByRole("button", { name: "Tạo sách" }));

      await waitFor(() => {
        expect(services.books.create).toHaveBeenCalledWith({
          title: "Sách mới",
          author: null,
          min_grade: 1,
          max_grade: 5,
        });
      });
      expect(routerMock.push).toHaveBeenCalledWith(
        "/admin/books/81000000-0000-4000-8000-000000000099",
      );
    },
  );

  it(
    "keeps entered form values and shows an error when the API rejects creation",
    async () => {
      const services = createAdminServiceFixture();
      vi.mocked(services.books.create).mockRejectedValue(
        new Error("server details must not be exposed"),
      );
      const user = userEvent.setup();
      render(withAdminFixture(<AdminNewBookScreen />, services));

      const title = screen.getByRole("textbox", { name: "Tiêu đề sách *" });
      await user.type(title, "Sách chưa được tạo");
      await user.click(screen.getByRole("button", { name: "Tạo sách" }));

      expect(
        await screen.findByText(
          "Không thể tạo sách. Hãy kiểm tra quyền Admin, kết nối Backend và thử lại.",
        ),
      ).toBeInTheDocument();
      expect(title).toHaveValue("Sách chưa được tạo");
      expect(screen.getByRole("textbox", { name: "Tác giả" })).toHaveValue("");
      expect(routerMock.push).not.toHaveBeenCalled();
    },
  );

  it(
    "blocks duplicate submissions while the create request is pending",
    async () => {
      const services = createAdminServiceFixture();
      let resolveCreate: ((book: typeof adminBookFixture) => void) | undefined;
      vi.mocked(services.books.create).mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      );
      const user = userEvent.setup();
      render(withAdminFixture(<AdminNewBookScreen />, services));

      await user.type(
        screen.getByRole("textbox", { name: "Tiêu đề sách *" }),
        "Sách một lần",
      );
      const submitButton = screen.getByRole("button", { name: "Tạo sách" });
      await user.click(submitButton);
      await waitFor(() => expect(services.books.create).toHaveBeenCalledOnce());
      await user.click(submitButton);
      expect(services.books.create).toHaveBeenCalledOnce();

      resolveCreate?.(adminBookFixture);
      await waitFor(() => {
        expect(routerMock.push).toHaveBeenCalledWith(
          `/admin/books/${adminBookFixture.id}`,
        );
      });
    },
  );
});
