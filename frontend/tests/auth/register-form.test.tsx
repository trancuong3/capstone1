import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthServiceContext,
  AuthServiceProvider,
} from "@/components/auth/auth-service-provider";
import { RegisterForm } from "@/components/auth/register-form";
import { RegisterScreen } from "@/components/auth/register-screen";
import { createMockAuthService } from "@/lib/mock/mock-auth-service";
import type { AuthMockScenario } from "@/types/auth";

const { confirmationMock, refreshMock, replaceMock } = vi.hoisted(() => ({
  confirmationMock: vi.fn(),
  refreshMock: vi.fn(),
  replaceMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, replace: replaceMock }),
}));

function renderRegisterForm(scenario: AuthMockScenario = "default") {
  return render(
    <AuthServiceProvider mode="mock" scenario={scenario}>
      <RegisterForm
        onEmailConfirmationRequired={confirmationMock}
        scenario={scenario}
      />
    </AuthServiceProvider>,
  );
}

async function fillValidRegistration(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText("Họ và tên ba mẹ"), "Nguyễn Minh Anh");
  await user.type(
    screen.getByLabelText("Email của ba mẹ"),
    "minhanh@example.com",
  );
  await user.type(screen.getByLabelText("Mật khẩu"), "matkhau123");
}

describe("RegisterForm", () => {
  beforeEach(() => {
    confirmationMock.mockClear();
    refreshMock.mockClear();
    replaceMock.mockClear();
  });

  it("shows field-level validation for all three registration fields", async () => {
    const user = userEvent.setup();
    renderRegisterForm();

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(
      await screen.findByText("Ba mẹ vui lòng nhập họ và tên."),
    ).toBeInTheDocument();
    expect(screen.getByText("Ba mẹ vui lòng nhập email.")).toBeInTheDocument();
    expect(
      screen.getByText("Mật khẩu cần có ít nhất 8 ký tự."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Họ và tên ba mẹ")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("navigates to the first child profile step after registration", async () => {
    const user = userEvent.setup();
    renderRegisterForm();
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/children/new?from=register");
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("uses a safe message for a provider failure", async () => {
    const user = userEvent.setup();
    renderRegisterForm("safe-error");
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chưa thể tạo tài khoản lúc này. Ba mẹ vui lòng thử lại sau.",
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("uses the neutral confirmation outcome for an existing email", async () => {
    const user = userEvent.setup();
    renderRegisterForm("email-used");
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    await waitFor(() => expect(confirmationMock).toHaveBeenCalledOnce());
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("renders a non-enumerating check-email screen", async () => {
    const user = userEvent.setup();
    render(
      <AuthServiceProvider mode="mock" scenario="email-used">
        <RegisterScreen scenario="email-used" />
      </AuthServiceProvider>,
    );
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(
      await screen.findByRole("heading", { name: "Kiểm tra email nhé" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "không xác nhận một email đã có tài khoản hay chưa",
    );
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("fails closed when a new account has no parent profile role", async () => {
    const service = createMockAuthService("default");
    vi.spyOn(service, "getCurrentRole").mockResolvedValue(null);
    const signOut = vi.spyOn(service, "signOut");
    const user = userEvent.setup();
    render(
      <AuthServiceContext.Provider value={service}>
        <RegisterForm
          onEmailConfirmationRequired={confirmationMock}
          scenario="default"
        />
      </AuthServiceContext.Provider>,
    );
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Chưa thể tạo tài khoản lúc này",
    );
    expect(signOut).toHaveBeenCalledOnce();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("supports a safe provider validation-error scenario", async () => {
    const user = userEvent.setup();
    renderRegisterForm("validation-error");
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Thông tin đăng ký chưa hợp lệ",
    );
  });

  it("disables submission while the request is pending", async () => {
    const pendingService = createMockAuthService("default");
    const registerParent = vi
      .spyOn(pendingService, "registerParent")
      .mockImplementation(() => new Promise(() => undefined));
    const user = userEvent.setup();
    render(
      <AuthServiceContext.Provider value={pendingService}>
        <RegisterForm
          onEmailConfirmationRequired={confirmationMock}
          scenario="default"
        />
      </AuthServiceContext.Provider>,
    );
    await fillValidRegistration(user);

    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));

    expect(
      screen.getByRole("button", { name: "Đang tạo tài khoản…" }),
    ).toBeDisabled();
    expect(registerParent).toHaveBeenCalledTimes(1);
  });

  it("links back to login", () => {
    renderRegisterForm();

    expect(
      screen.getByRole("link", { name: "Đã có tài khoản? Đăng nhập" }),
    ).toHaveAttribute("href", "/login?state=default");
  });
});
