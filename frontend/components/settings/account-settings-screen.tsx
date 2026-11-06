"use client";

import {
  ArrowRight,
  CalendarClock,
  Eye,
  EyeOff,
  LockKeyhole,
  Mail,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { PageHeader } from "@/components/common/page-header";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthService } from "@/hooks/use-auth-service";
import { AuthServiceError } from "@/lib/api/auth-service";
import { createProfileService } from "@/lib/api/profile-service";
import type { AuthUserSnapshot } from "@/types/auth";
import type { ParentProfileDTO } from "@/types/profile";

type SettingsState =
  | { status: "loading" }
  | { status: "ready"; profile: ParentProfileDTO; user: AuthUserSnapshot }
  | { status: "error" };

type Notice = { tone: "success" | "error"; message: string };

function verificationLabel(profile: ParentProfileDTO): string {
  if (profile.pending_email) return "Đang chờ xác nhận email mới";
  if (profile.contact_info_status !== "available")
    return "Không thể tải thông tin";
  if (profile.email_verified === true) return "Đã xác minh";
  if (profile.email_verified === false) return "Chưa xác minh";
  return "Không thể tải thông tin";
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  visible,
  onToggle,
  autoComplete,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  visible: boolean;
  onToggle: () => void;
  autoComplete: string;
}) {
  return (
    <div className="flex min-h-[88px] w-full flex-col gap-2 rounded-control border border-border bg-white px-4 py-3">
      <label className="text-label font-bold text-muted" htmlFor={id}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <input
          autoComplete={autoComplete}
          className="min-w-0 flex-1 bg-transparent text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
          id={id}
          onChange={(event) => onChange(event.target.value)}
          required
          type={visible ? "text" : "password"}
          value={value}
        />
        <button
          aria-label={
            visible
              ? "Ẩn " + label.toLowerCase()
              : "Hiện " + label.toLowerCase()
          }
          className="flex size-10 shrink-0 items-center justify-center rounded-control text-muted hover:bg-sky hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          onClick={onToggle}
          type="button"
        >
          {visible ? (
            <EyeOff aria-hidden="true" className="size-5" />
          ) : (
            <Eye aria-hidden="true" className="size-5" />
          )}
        </button>
      </div>
    </div>
  );
}

export function AccountSettingsScreen() {
  const authService = useAuthService();
  const profileService = useMemo(() => createProfileService(), []);
  const [state, setState] = useState<SettingsState>({ status: "loading" });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isRequestingRecovery, setIsRequestingRecovery] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;

    async function load() {
      setState({ status: "loading" });
      try {
        const [profile, user] = await Promise.all([
          profileService.get(),
          authService.getCurrentUser(),
        ]);
        if (!active) return;
        if (!user) {
          setState({ status: "error" });
          return;
        }
        setState({ status: "ready", profile, user });
      } catch {
        if (active) setState({ status: "error" });
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [authService, profileService, retryKey]);

  async function handlePasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isChangingPassword) return;
    setNotice(null);

    if (!currentPassword.trim()) {
      setNotice({
        tone: "error",
        message: "Ba mẹ vui lòng nhập mật khẩu hiện tại.",
      });
      return;
    }
    if (newPassword.length < 8) {
      setNotice({
        tone: "error",
        message: "Mật khẩu mới cần có ít nhất 8 ký tự.",
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      setNotice({ tone: "error", message: "Hai mật khẩu mới chưa khớp." });
      return;
    }

    setIsChangingPassword(true);
    try {
      await authService.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice({
        tone: "success",
        message:
          "Mật khẩu đã được cập nhật. Phiên đăng nhập hiện tại vẫn được giữ nguyên.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        message:
          error instanceof AuthServiceError &&
          error.reason === "invalid-credentials"
            ? "Mật khẩu hiện tại chưa chính xác."
            : "Chưa thể đổi mật khẩu. Ba mẹ vui lòng kiểm tra kết nối và thử lại.",
      });
    } finally {
      setIsChangingPassword(false);
    }
  }

  async function handlePasswordRecovery() {
    if (state.status !== "ready" || isRequestingRecovery) return;
    const email = state.profile.email ?? state.user.email;
    if (!email) {
      setNotice({
        tone: "error",
        message: "Tài khoản chưa có email để gửi liên kết đặt mật khẩu.",
      });
      return;
    }

    setNotice(null);
    setIsRequestingRecovery(true);
    try {
      await authService.requestPasswordReset({ email });
      setNotice({
        tone: "success",
        message:
          "Supabase Auth đã tiếp nhận yêu cầu gửi liên kết đặt mật khẩu. Ba mẹ hãy kiểm tra hộp thư và thư rác.",
      });
    } catch {
      setNotice({
        tone: "error",
        message:
          "Chưa gửi được liên kết đặt mật khẩu. Ba mẹ vui lòng thử lại sau.",
      });
    } finally {
      setIsRequestingRecovery(false);
    }
  }

  if (state.status === "loading") {
    return (
      <section
        aria-busy="true"
        aria-label="Đang tải cài đặt tài khoản"
        className="mx-auto flex w-full max-w-[960px] flex-col gap-6"
      >
        <span className="sr-only" role="status">
          Đang tải…
        </span>
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-4">
        <PageHeader
          description="Quản lý thông tin tài khoản, bảo mật và các tùy chọn sử dụng ViRead."
          title="Cài đặt tài khoản"
        />
        <StatusMessage tone="error" title="Không thể tải thông tin">
          ViRead chưa thể tải dữ liệu tài khoản. Ba mẹ vui lòng thử tải lại
          trang hoặc đăng nhập lại.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start"
          onClick={() => setRetryKey((key) => key + 1)}
          variant="secondary"
        >
          Thử tải lại
        </Button>
      </section>
    );
  }

  const { profile, user } = state;
  const email = profile.email ?? user.email;
  const displayName =
    profile.display_name?.trim() ||
    user.display_name?.trim() ||
    "Chưa cập nhật";
  const isEmailPasswordAccount = user.providers?.includes("email") ?? false;
  const emailStatus = verificationLabel(profile);

  return (
    <section className="mx-auto flex w-full max-w-[960px] flex-col gap-6">
      <PageHeader
        description="Quản lý thông tin tài khoản, bảo mật và các tùy chọn sử dụng ViRead."
        eyebrow="Tài khoản ViRead"
        title="Cài đặt tài khoản"
      />

      <Card>
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-full bg-sky text-primary">
            <UserRound aria-hidden="true" className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-extrabold text-ink">
              Thông tin tài khoản
            </h2>
            <p className="text-sm text-muted">
              Thông tin lấy từ Supabase Auth và hồ sơ phụ huynh.
            </p>
          </div>
        </div>

        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-control bg-canvas p-4">
            <dt className="text-label font-bold text-muted">Tên hiển thị</dt>
            <dd className="mt-1 break-words text-body font-bold text-ink">
              {displayName}
            </dd>
          </div>
          <div className="rounded-control bg-canvas p-4">
            <dt className="text-label font-bold text-muted">Email tài khoản</dt>
            <dd className="mt-1 break-all text-body font-bold text-ink">
              {email || "Không thể tải thông tin"}
            </dd>
            <p className="mt-1 text-label text-muted">{emailStatus}</p>
            {profile.pending_email ? (
              <p className="mt-2 break-all text-sm text-amber-700">
                Email mới đang chờ xác nhận:{" "}
                <strong>{profile.pending_email}</strong>
              </p>
            ) : null}
          </div>
          <div className="rounded-control bg-canvas p-4">
            <dt className="text-label font-bold text-muted">
              Vai trò tài khoản
            </dt>
            <dd className="mt-1 text-body font-bold text-ink">
              {profile.role === "admin" ? "Quản trị viên" : "Phụ huynh"}
            </dd>
          </div>
          <div className="rounded-control bg-canvas p-4">
            <dt className="text-label font-bold text-muted">
              Trạng thái email
            </dt>
            <dd className="mt-1 flex items-center gap-2 text-body font-bold text-ink">
              <ShieldCheck aria-hidden="true" className="size-5 text-primary" />
              {emailStatus}
            </dd>
          </div>
        </dl>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/profile"
          variant="secondary"
        >
          Quản lý hồ sơ <ArrowRight aria-hidden="true" className="size-5" />
        </ButtonLink>
      </Card>

      <Card>
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-full bg-sky text-primary">
            <LockKeyhole aria-hidden="true" className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-extrabold text-ink">Đổi mật khẩu</h2>
            <p className="text-sm text-muted">
              Cập nhật mật khẩu để bảo vệ tài khoản ViRead của bạn.
            </p>
          </div>
        </div>

        {notice ? (
          <StatusMessage tone={notice.tone}>{notice.message}</StatusMessage>
        ) : null}

        {isEmailPasswordAccount ? (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={handlePasswordChange}
          >
            <PasswordField
              autoComplete="current-password"
              id="current-password"
              label="Mật khẩu hiện tại"
              onChange={setCurrentPassword}
              onToggle={() => setShowCurrentPassword((value) => !value)}
              value={currentPassword}
              visible={showCurrentPassword}
            />
            <PasswordField
              autoComplete="new-password"
              id="new-password"
              label="Mật khẩu mới"
              onChange={setNewPassword}
              onToggle={() => setShowNewPassword((value) => !value)}
              value={newPassword}
              visible={showNewPassword}
            />
            <PasswordField
              autoComplete="new-password"
              id="confirm-new-password"
              label="Xác nhận mật khẩu mới"
              onChange={setConfirmPassword}
              onToggle={() => setShowConfirmPassword((value) => !value)}
              value={confirmPassword}
              visible={showConfirmPassword}
            />
            <p className="text-sm text-muted">
              Mật khẩu mới cần có ít nhất 8 ký tự.
            </p>
            <Button
              className="sm:w-auto sm:self-start sm:px-8"
              disabled={isChangingPassword}
              isLoading={isChangingPassword}
              type="submit"
            >
              Lưu mật khẩu mới
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-body text-muted">
              Tài khoản này chưa có phương thức đăng nhập bằng mật khẩu. Ba mẹ
              có thể yêu cầu liên kết đặt mật khẩu qua email.
            </p>
            <Button
              className="sm:w-auto sm:self-start sm:px-8"
              disabled={isRequestingRecovery || !email}
              isLoading={isRequestingRecovery}
              onClick={() => void handlePasswordRecovery()}
            >
              <Mail aria-hidden="true" className="size-5" />
              Chưa có mật khẩu? Gửi liên kết đặt mật khẩu qua email
            </Button>
          </div>
        )}
      </Card>

      <Card>
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-full bg-sky text-primary">
            <Mail aria-hidden="true" className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-extrabold text-ink">
              Email và xác minh
            </h2>
            <p className="text-sm text-muted">
              Quản lý email hiện tại và yêu cầu xác minh email mới.
            </p>
          </div>
        </div>
        <p className="text-body text-muted">
          {profile.pending_email
            ? "Yêu cầu đổi email đang chờ xác minh. Email hiện tại vẫn là địa chỉ đã được xác nhận trước đó."
            : "Để đổi email hoặc gửi lại email xác minh, hãy sử dụng chức năng hiện có trong hồ sơ phụ huynh."}
        </p>
        <Link
          className="font-bold text-primary underline-offset-4 hover:underline"
          href="/profile"
        >
          Mở hồ sơ phụ huynh
        </Link>
      </Card>

      <Card>
        <div className="flex items-center gap-3">
          <div className="flex size-11 items-center justify-center rounded-full bg-sky text-primary">
            <CalendarClock aria-hidden="true" className="size-5" />
          </div>
          <div>
            <h2 className="text-lg font-extrabold text-ink">
              Quản lý lịch nhắc đọc sách
            </h2>
            <p className="text-sm text-muted">
              Điều chỉnh lịch đọc và các thông báo nhắc nhở cho bé.
            </p>
          </div>
        </div>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/reading-management"
          variant="secondary"
        >
          Quản lý lịch nhắc đọc sách{" "}
          <ArrowRight aria-hidden="true" className="size-5" />
        </ButtonLink>
      </Card>
    </section>
  );
}
