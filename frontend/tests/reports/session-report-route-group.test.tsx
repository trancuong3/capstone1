import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appShell: vi.fn(),
  getServerI18n: vi.fn(),
  requireAppRole: vi.fn(),
}));

vi.mock("@/lib/i18n/server", () => ({
  getServerI18n: mocks.getServerI18n,
}));

vi.mock("@/components/layout/app-shell", () => ({
  AppShell: ({ children }: { readonly children: ReactNode }) => {
    mocks.appShell();
    return <div data-testid="mock-app-shell">{children}</div>;
  },
}));

vi.mock("@/lib/auth/server-authorization", () => ({
  requireAppRole: mocks.requireAppRole,
}));

import SessionReportLayout, {
  generateMetadata,
} from "@/app/(app)/sessions/[sessionId]/report/layout";
import { getLocaleMetadata } from "@/lib/i18n/locales";
import { loadLocaleMessages } from "@/messages/loader";
import { viMessages } from "@/messages/vi";

describe("(app)/sessions/[sessionId]/report route-group layout", () => {
  beforeEach(() => {
    mocks.appShell.mockReset();
    mocks.getServerI18n.mockReset();
    mocks.requireAppRole.mockReset();
  });

  it("generates localized page title metadata from server i18n", async () => {
    mocks.getServerI18n.mockResolvedValueOnce({
      locale: "vi",
      dir: "ltr",
      metadata: getLocaleMetadata("vi"),
      messages: viMessages,
    });

    const viMetadata = await generateMetadata();
    expect(viMetadata).toEqual({ title: "Báo cáo đọc" });

    const enMessages = await loadLocaleMessages("en");
    mocks.getServerI18n.mockResolvedValueOnce({
      locale: "en",
      dir: "ltr",
      metadata: getLocaleMetadata("en"),
      messages: enMessages,
    });

    const enMetadata = await generateMetadata();
    expect(enMetadata).toEqual({ title: "Reading Report" });
  });

  it("renders children directly without mounting a duplicate AppShell", () => {
    const { container } = render(
      <SessionReportLayout>
        <section data-testid="report-body">Reading report body</section>
      </SessionReportLayout>,
    );

    const reportBody = screen.getByTestId("report-body");
    expect(reportBody).toHaveTextContent("Reading report body");
    expect(container.firstElementChild).toBe(reportBody);
    expect(screen.queryByTestId("mock-app-shell")).not.toBeInTheDocument();
    expect(mocks.appShell).not.toHaveBeenCalled();
    expect(mocks.requireAppRole).not.toHaveBeenCalled();
  });

  it("moves the report route under app/(app) without legacy files", () => {
    const cwd = process.cwd();
    const groupDir = resolve(cwd, "app/(app)/sessions/[sessionId]/report");
    const legacyDir = resolve(cwd, "app/sessions/[sessionId]/report");

    expect(existsSync(resolve(groupDir, "layout.tsx"))).toBe(true);
    expect(existsSync(resolve(groupDir, "page.tsx"))).toBe(true);
    expect(existsSync(resolve(legacyDir, "layout.tsx"))).toBe(false);
    expect(existsSync(resolve(legacyDir, "page.tsx"))).toBe(false);
  });
});
