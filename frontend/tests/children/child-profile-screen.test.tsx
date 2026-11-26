import fs from "node:fs";
import path from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChildProfileScreen } from "@/components/children/child-profile-screen";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { AppServicesProvider } from "@/components/providers/app-services-provider";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";
import {
  childFixture,
  TEST_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock,
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

beforeEach(() => {
  installApiFetchFixture();
  routerMock.push.mockReset();
  routerMock.replace.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChildProfileScreen & SelectedChildIdentity", () => {
  it("renders edit mode with break-words heading, conflict-free Card classes, and min-h-11 back link", async () => {
    const longChild = {
      ...childFixture,
      alias: "BéNguyễnHoàngMinhKhuêSiêuDàiKhôngKhoảngTrắng",
    };
    apiFetchFixture.mockResolvedValueOnce(Response.json(longChild));

    const { container } = render(
      <AppServicesProvider>
        <ChildProfileScreen childId={TEST_CHILD_ID} mode="edit" />
      </AppServicesProvider>,
    );

    const heading = await screen.findByRole("heading", {
      name: `Hồ sơ của ${longChild.alias}`,
    });
    expect(heading).toHaveClass("break-words", "text-xl", "md:text-heading");

    const backLink = screen.getByRole("link", { name: /Quay lại/ });
    expect(backLink).toHaveClass("min-h-11");

    const card = container.querySelector("section > div.rounded-card");
    expect(card).toHaveClass(
      "max-[640px]:gap-3.5",
      "min-[640px]:px-6",
      "md:px-8",
    );
    expect(card).not.toHaveClass("gap-3.5");

    const chooseBookLink = screen.getByRole("link", {
      name: new RegExp(`Chọn sách cho ${longChild.alias}`),
    });
    expect(chooseBookLink).toHaveClass("break-words");
  });

  it("opens delete modal with responsive min-[640px]:flex-row actions, clears selected child, and redirects", async () => {
    const user = userEvent.setup();
    const clearSelectedChild = vi.fn();
    apiFetchFixture
      .mockResolvedValueOnce(Response.json(childFixture))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(
      <AppStoreContext.Provider
        value={{
          selectedChildId: TEST_CHILD_ID,
          validatedSelectedChild: childFixture,
          selectChild: vi.fn(),
          clearSelectedChild,
          setValidatedSelectedChild: vi.fn(),
          syncAvailableChildren: vi.fn(),
        }}
      >
        <AppServicesProvider>
          <ChildProfileScreen childId={TEST_CHILD_ID} mode="edit" />
        </AppServicesProvider>
      </AppStoreContext.Provider>,
    );

    await user.click(
      await screen.findByRole("button", { name: "Xóa hồ sơ bé" }),
    );

    const confirmText = screen.getByText(/Bạn có chắc muốn xóa hồ sơ của/);
    expect(confirmText).toHaveClass("break-words");

    const cancelBtn = screen.getByRole("button", { name: "Hủy" });
    expect(cancelBtn.parentElement).toHaveClass("min-[640px]:flex-row");

    await user.click(screen.getByRole("button", { name: "Xóa hồ sơ" }));

    await waitFor(() => {
      expect(clearSelectedChild).toHaveBeenCalledOnce();
      expect(routerMock.replace).toHaveBeenCalledWith("/children");
    });
  });

  it("preserves SelectedChildIdentity hidden md:flex contract and prevents action wrapping", () => {
    const { container } = render(
      <SelectedChildIdentity
        child={{ ...childFixture, alias: "Bé An Khang Thịnh Vượng" }}
      />,
    );

    const root = container.firstElementChild;
    expect(root).toHaveClass(
      "hidden",
      "md:flex",
      "md:w-fit",
      "md:min-w-[320px]",
    );
    expect(root?.className).not.toMatch(/(?:^|\s)sm:/);

    const switchLink = screen.getByRole("link", { name: "Đổi hồ sơ" });
    expect(switchLink).toHaveClass("min-h-11", "shrink-0", "whitespace-nowrap");
  });

  it("contains zero legacy sm:, max-sm:, max-[639px]:, or max-[767px]: classes across children components", () => {
    const rootDir = path.resolve(process.cwd(), "components/children");
    const files = fs
      .readdirSync(rootDir)
      .filter((name) => /\.(tsx?|css)$/.test(name));
    const forbidden = /(?<![\w-])(sm:|max-sm:|max-\[639px\]:|max-\[767px\]:)/;
    for (const file of files) {
      const content = fs.readFileSync(path.join(rootDir, file), "utf8");
      expect(content).not.toMatch(forbidden);
    }
  });
});
