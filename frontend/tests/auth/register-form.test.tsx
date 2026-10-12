import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RegisterForm } from "@/components/auth/register-form";
import { RegisterScreen } from "@/components/auth/register-screen";
import { AuthServiceError } from "@/lib/api/auth-service";
import {
  createAuthServiceFixture,
  withAuthFixture,
} from "@/test/fixtures/auth-service-fixture";
import type { ParentRegistrationResult } from "@/types/auth";

const { confirmationMock, refreshMock, replaceMock } = vi.hoisted(() => ({
  confirmationMock: vi.fn(),
  refreshMock: vi.fn(),
  replaceMock: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, replace: replaceMock }),
}));
const safeRegistrationError =
  "Không thể hoàn tất đăng ký. Ba mẹ vui lòng kiểm tra thông tin hoặc đăng nhập nếu đã có tài khoản.";

function renderRegisterForm(service = createAuthServiceFixture()) {
  return render(
    withAuthFixture(
      <RegisterForm
        onEmailConfirmationRequired={confirmationMock}
        scenario="default"
      />,
      service,
    ),
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
    const service = createAuthServiceFixture();
    renderRegisterForm(service);
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
    expect(service.registerParent).not.toHaveBeenCalled();
  });

  it("navigates to the first child profile step after registration", async () => {
    const user = userEvent.setup();
    const service = createAuthServiceFixture();
    renderRegisterForm(service);
    await fillValidRegistration(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    await waitFor(() =>
      expect(replaceMock).toHaveBeenCalledWith("/children/new?from=register"),
    );
    expect(service.registerParent).toHaveBeenCalledWith({
      displayName: "Nguyễn Minh Anh",
      email: "minhanh@example.com",
      password: "matkhau123",
    });
    expect(refreshMock).toHaveBeenCalledOnce();
  });

  it("uses a safe message for a provider failure", async () => {
    const service = createAuthServiceFixture();
    service.registerParent.mockRejectedValue(
      new Error("Sensitive provider details"),
    );
    const user = userEvent.setup();
    renderRegisterForm(service);
    await fillValidRegistration(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(safeRegistrationError);
    expect(alert).not.toHaveTextContent("Sensitive provider details");
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("does not treat a confirmed duplicate rejection as a confirmation success", async () => {
    const service = createAuthServiceFixture();
    // The SDK adapter already maps a confirmed duplicate to this safe failure.
    service.registerParent.mockRejectedValue(
      new AuthServiceError(
        "unexpected",
        "Authentication could not be completed.",
      ),
    );
    const user = userEvent.setup();
    renderRegisterForm(service);
    await fillValidRegistration(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      safeRegistrationError,
    );
    expect(confirmationMock).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("renders a neutral check-email screen when confirmation is required", async () => {
    const service = createAuthServiceFixture();
    service.registerParent.mockResolvedValue({
      status: "email-confirmation-required",
      session: null,
    });
    const user = userEvent.setup();
    render(withAuthFixture(<RegisterScreen scenario="default" />, service));
    await fillValidRegistration(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    expect(
      await screen.findByRole("heading", { name: "Kiểm tra email nhé" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "không xác nhận một email đã có tài khoản hay chưa",
    );
    expect(service.getCurrentRole).not.toHaveBeenCalled();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("fails closed when a new account has no parent profile role", async () => {
    const service = createAuthServiceFixture();
    service.getCurrentRole.mockResolvedValue(null);
    const user = userEvent.setup();
    renderRegisterForm(service);
    await fillValidRegistration(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      safeRegistrationError,
    );
    expect(service.signOut).toHaveBeenCalledOnce();
    expect(replaceMock).not.toHaveBeenCalled();
  });

  it("maps a provider validation error to a safe message", async () => {
    const service = createAuthServiceFixture();
    service.registerParent.mockRejectedValue(
      new AuthServiceError(
        "registration-validation",
        "Sensitive provider validation",
      ),
    );
    const user = userEvent.setup();
    renderRegisterForm(service);
    await fillValidRegistration(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Thông tin đăng ký chưa hợp lệ",
    );
  });

  it("disables submission while the request is pending", async () => {
    const service = createAuthServiceFixture();
    let settle: (result: ParentRegistrationResult) => void = () => undefined;
    service.registerParent.mockImplementation(
      () =>
        new Promise<ParentRegistrationResult>((resolve) => {
          settle = resolve;
        }),
    );
    const user = userEvent.setup();
    renderRegisterForm(service);
    await fillValidRegistration(user);
    await user.click(screen.getByRole("button", { name: "Tạo tài khoản" }));
    expect(
      screen.getByRole("button", { name: "Đang tạo tài khoản…" }),
    ).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "Đang tạo tài khoản…" }),
    );
    expect(service.registerParent).toHaveBeenCalledOnce();
    expect(confirmationMock).not.toHaveBeenCalled();
    await act(async () => {
      settle({ status: "email-confirmation-required", session: null });
    });
    expect(confirmationMock).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Tạo tài khoản" })).toBeEnabled();
  });

  it("links back to login", () => {
    renderRegisterForm();
    expect(
      screen.getByRole("link", { name: "Đã có tài khoản? Đăng nhập" }),
    ).toHaveAttribute("href", "/login");
  });
});
