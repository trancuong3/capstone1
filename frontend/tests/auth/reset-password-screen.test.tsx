import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  AuthServiceContext,
  AuthServiceProvider,
} from "@/components/auth/auth-service-provider";
import { ResetPasswordScreen } from "@/components/auth/reset-password-screen";
import { AuthServiceError } from "@/lib/api/auth-service";
import { createMockAuthService } from "@/lib/mock/mock-auth-service";
import type { AuthMockScenario } from "@/types/auth";

function renderResetScreen(scenario: AuthMockScenario = "default") {
  return render(
    <AuthServiceProvider mode="mock" scenario={scenario}>
      <ResetPasswordScreen scenario={scenario} />
    </AuthServiceProvider>,
  );
}

async function fillValidReset(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Mật khẩu mới"), "matkhau123");
  await user.type(screen.getByLabelText("Nhập lại mật khẩu mới"), "matkhau123");
}

describe("ResetPasswordScreen", () => {
  it.each([
    ["invalid-token", "Liên kết không hợp lệ"],
    ["expired-token", "Liên kết đã hết hạn"],
  ] as const)("renders the %s recovery state", (scenario, heading) => {
    renderResetScreen(scenario);

    expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "không thể được sử dụng",
    );
  });

  it("validates password confirmation at the matching field", async () => {
    const user = userEvent.setup();
    renderResetScreen();

    await user.type(screen.getByLabelText("Mật khẩu mới"), "matkhau123");
    await user.type(
      screen.getByLabelText("Nhập lại mật khẩu mới"),
      "khacmatkhau",
    );
    await user.click(screen.getByRole("button", { name: "Lưu mật khẩu mới" }));

    expect(
      await screen.findByText("Hai mật khẩu chưa khớp."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Nhập lại mật khẩu mới")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("moves to the success state after a valid mock reset", async () => {
    const user = userEvent.setup();
    renderResetScreen();

    await fillValidReset(user);
    await user.click(screen.getByRole("button", { name: "Lưu mật khẩu mới" }));

    expect(
      await screen.findByRole("heading", { name: "Đã đổi mật khẩu" }),
    ).toBeInTheDocument();
  });

  it.each([
    ["invalid-recovery-context", "Liên kết không hợp lệ"],
    ["expired-recovery-context", "Liên kết đã hết hạn"],
  ] as const)(
    "maps a live %s failure to the recovery screen",
    async (reason, heading) => {
      const service = createMockAuthService("default");
      vi.spyOn(service, "resetPassword").mockRejectedValue(
        new AuthServiceError(reason, "Sensitive provider details"),
      );
      const user = userEvent.setup();
      render(
        <AuthServiceContext.Provider value={service}>
          <ResetPasswordScreen scenario="default" />
        </AuthServiceContext.Provider>,
      );

      await fillValidReset(user);
      await user.click(
        screen.getByRole("button", { name: "Lưu mật khẩu mới" }),
      );

      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeInTheDocument();
    },
  );

  it.each([
    [null, "Liên kết không hợp lệ"],
    ["expired-recovery-context", "Liên kết đã hết hạn"],
  ] as const)(
    "maps the live initialization state %s before rendering the form",
    (initializationFailure, heading) => {
      render(
        <AuthRuntimeContext.Provider
          value={{
            initializationFailure,
            isPasswordRecovery: false,
            lastEvent: "INITIAL_SESSION",
            mode: "supabase",
            session: null,
            status: initializationFailure ? "error" : "ready",
          }}
        >
          <ResetPasswordScreen scenario="default" />
        </AuthRuntimeContext.Provider>,
      );

      expect(
        screen.getByRole("heading", { name: heading }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Lưu mật khẩu mới" }),
      ).not.toBeInTheDocument();
    },
  );
});
