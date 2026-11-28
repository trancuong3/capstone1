import { render, screen } from "@testing-library/react";
import Link from "next/link";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookChildHeader } from "@/components/books/book-child-header";
import { ButtonLink } from "@/components/common/button";
import { PageHeader } from "@/components/common/page-header";
import { StatusMessage } from "@/components/common/status-message";
import { SiteFooter } from "@/components/layout/site-footer";
import { SiteHeader } from "@/components/layout/site-header";
import { ReportPageHeader } from "@/components/reports/report-page-header";

const navigationState = vi.hoisted(() => ({
  pathname: "/login",
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigationState.pathname,
}));

describe("M1.1 shared headers, footers, and common primitives", () => {
  beforeEach(() => {
    navigationState.pathname = "/login";
  });

  it("enforces >=44px mobile touch targets on BookChildHeader", () => {
    render(
      <BookChildHeader
        child={{
          id: "child-1",
          parent_id: "parent-1",
          alias: "Bé An",
          grade: 2,
          settings: {},
          created_at: "2026-10-01T00:00:00Z",
        }}
        mobileLabel="Tủ sách"
      />,
    );

    const header = screen.getByRole("banner");
    expect(header.className).toContain("min-h-14");

    const backLink = screen.getByRole("link", { name: /Tủ sách/ });
    expect(backLink.className).toContain("min-h-11");

    const childSwitcher = screen.getByRole("link", {
      name: /Đổi hồ sơ: Bé An/,
    });
    expect(childSwitcher.className).toContain("min-h-11");
    expect(childSwitcher.className).toContain("sm:min-h-12");
    expect(childSwitcher.className).not.toContain("min-h-9");
  });

  it("enforces >=44px mobile touch targets on ReportPageHeader and PageHeader actions", () => {
    render(
      <>
        <ReportPageHeader
          action={<Link href="/books">Mở tủ sách</Link>}
          description="Theo dõi tiến độ"
          eyebrow="Báo cáo"
          title="Tiến độ đọc"
        />
        <PageHeader
          action={<button type="button">Cập nhật</button>}
          description="Quản lý hồ sơ"
          title="Hồ sơ phụ huynh"
        />
      </>,
    );

    const reportActionLink = screen.getByRole("link", { name: "Mở tủ sách" });
    expect(reportActionLink.parentElement?.className).toContain(
      "max-sm:[&>a]:min-h-11",
    );
    expect(reportActionLink.parentElement?.className).toContain(
      "max-sm:[&>button]:min-h-11",
    );

    const pageActionButton = screen.getByRole("button", { name: "Cập nhật" });
    expect(pageActionButton.parentElement?.className).toContain(
      "max-sm:[&>a]:min-h-11",
    );
    expect(pageActionButton.parentElement?.className).toContain(
      "max-sm:[&>button]:min-h-11",
    );
  });

  it("hides redundant current auth link below sm on SiteHeader without cn() class collisions", () => {
    navigationState.pathname = "/login";
    const { rerender } = render(<SiteHeader variant="auth" />);

    const loginLink = screen.getByRole("link", { name: "Đăng nhập" });
    const registerLink = screen.getByRole("link", { name: "Đăng ký" });

    expect(loginLink.parentElement?.className).toContain("hidden");
    expect(loginLink.parentElement?.className).toContain("sm:inline-flex");
    const loginClasses = loginLink.className.split(/\s+/);
    expect(loginClasses).toContain("min-h-11");
    expect(loginClasses).not.toContain("px-4");
    expect(loginClasses).not.toContain("text-label");
    expect(loginClasses).not.toContain("w-full");
    expect(registerLink.parentElement?.className).not.toContain("hidden");

    navigationState.pathname = "/register";
    rerender(<SiteHeader variant="auth" />);
    const registerLinkOnRegister = screen.getByRole("link", {
      name: "Đăng ký",
    });
    expect(registerLinkOnRegister.parentElement?.className).toContain("hidden");
    expect(registerLinkOnRegister.parentElement?.className).toContain(
      "sm:inline-flex",
    );
  });

  it("keeps compact mobile padding on public SiteFooter and StatusMessage compact mode", () => {
    render(
      <>
        <SiteFooter variant="public" />
        <StatusMessage compact tone="info">
          <ButtonLink href="/dashboard" size="touch">
            Về trang chủ
          </ButtonLink>
        </StatusMessage>
      </>,
    );

    const footer = screen.getByRole("contentinfo");
    expect(footer.firstElementChild?.className).toContain("py-3");
    expect(footer.firstElementChild?.className).toContain("sm:py-6");

    const status = screen.getByRole("status");
    expect(status.className).toContain("p-3");
    expect(status.className).toContain("gap-2.5");
    expect(status.className).not.toContain("p-4");
  });
});
