"use client";

import {
  CalendarDays,
  Mail,
  Pencil,
  Phone,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import {
  ProfileAvatar,
  resolveDisplayName,
} from "@/components/common/profile-avatar";
import { PageHeader } from "@/components/common/page-header";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ParentProfileForm } from "@/components/profile/parent-profile-form";
import { useAuthService } from "@/hooks/use-auth-service";
import { useProfileService } from "@/hooks/use-profile-service";
import type { AuthUserSnapshot } from "@/types/auth";
import type { ParentProfileDTO } from "@/types/profile";

type ProfileState =
  | { status: "loading" }
  | {
      status: "ready";
      profile: ParentProfileDTO;
      metadataName: string | null;
    }
  | { status: "error" };

function formatCreatedDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Chưa có thông tin";
  }

  return new Intl.DateTimeFormat("vi-VN", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function getRoleLabel(role: ParentProfileDTO["role"]): string {
  return role === "admin" ? "Quản trị viên" : "Phụ huynh";
}

function contactValue(
  value: string | null,
  status: ParentProfileDTO["contact_info_status"],
): string {
  if (value) return value;

  switch (status) {
    case "not_configured":
      return "Chưa thể tải email từ Supabase Auth";
    case "user_not_found":
      return "Không tìm thấy tài khoản xác thực";
    case "lookup_failed":
      return "Chưa tải được email";
    default:
      return "Chưa cập nhật";
  }
}

function emailVerificationLabel(
  value: string | null,
  verified: boolean | null,
  status: ParentProfileDTO["contact_info_status"],
): string {
  if (status !== "available") {
    return "Chưa thể kiểm tra trạng thái xác minh";
  }
  if (!value) return "Chưa có email";
  if (verified === true) return "Đã xác minh";
  if (verified === false) return "Chưa xác minh";
  return "Chưa có thông tin xác minh";
}

function ParentProfileLoadingState() {
  return (
    <section
      aria-busy="true"
      aria-label="Đang tải hồ sơ ba mẹ"
      className="mx-auto flex w-full max-w-[800px] flex-col gap-6"
    >
      <span className="sr-only" role="status">
        Đang tải…
      </span>
      <Skeleton className="h-11 w-2/3" />
      <Skeleton className="h-7 w-full" />
      <Card>
        <Skeleton className="h-24 w-24 rounded-full" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
      </Card>
    </section>
  );
}

export function ParentProfileScreen() {
  const profileService = useProfileService();
  const authService = useAuthService();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ProfileState>({ status: "loading" });
  const [isEditing, setIsEditing] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    async function loadProfile() {
      setState({ status: "loading" });
      const [profileResult, userResult] = await Promise.allSettled([
        profileService.get(),
        authService.getCurrentUser(),
      ]);

      if (!isActive) return;
      if (profileResult.status === "rejected") {
        setState({ status: "error" });
        return;
      }

      const user: AuthUserSnapshot | null =
        userResult.status === "fulfilled" ? userResult.value : null;
      setState({
        status: "ready",
        profile: profileResult.value,
        metadataName: user?.display_name ?? null,
      });
    }

    void loadProfile();
    return () => {
      isActive = false;
    };
  }, [authService, profileService, requestKey]);

  if (state.status === "loading") {
    return <ParentProfileLoadingState />;
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[800px] flex-col gap-4">
        <StatusMessage title="Chưa tải được hồ sơ ba mẹ" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

  const { profile, metadataName } = state;
  const displayName = resolveDisplayName(
    profile.display_name,
    metadataName,
    profile.email,
  );

  function handleSaved(updatedProfile: ParentProfileDTO, message: string) {
    setState({ status: "ready", profile: updatedProfile, metadataName });
    setIsEditing(false);
    setSaveNotice(message);
  }

  function handlePartialSaved(updatedProfile: ParentProfileDTO) {
    setState({ status: "ready", profile: updatedProfile, metadataName });
  }

  return (
    <section className="mx-auto flex w-full max-w-[800px] flex-col gap-6">
      <PageHeader
        className="mb-0 gap-4"
        description="Xem và cập nhật thông tin liên hệ cùng các hồ sơ trẻ đã liên kết với ViRead."
        eyebrow="Hồ sơ ba mẹ"
        title="Thông tin tài khoản"
      />

      {saveNotice ? (
        <StatusMessage tone="success" role="status">
          {saveNotice}
        </StatusMessage>
      ) : null}

      <Card className="sm:p-10">
        {isEditing ? (
          <ParentProfileForm
            displayName={displayName ?? ""}
            onCancel={() => setIsEditing(false)}
            onPartialSaved={handlePartialSaved}
            onSaved={handleSaved}
            profile={profile}
          />
        ) : (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <ProfileAvatar
                ariaLabel={`Ảnh đại diện của ${displayName ?? "ba mẹ"}`}
                displayName={displayName}
                imageUrl={profile.avatar_url}
                size="lg"
              />
              <div className="min-w-0 flex-1">
                <h2 className="break-words text-2xl font-extrabold leading-[1.4] text-ink">
                  {displayName || "Chưa cập nhật tên hiển thị"}
                </h2>
                <p className="mt-1 text-body text-muted">
                  {getRoleLabel(profile.role)}
                </p>
              </div>
              <Button
                className="sm:w-auto sm:px-6"
                onClick={() => {
                  setSaveNotice(null);
                  setIsEditing(true);
                }}
                type="button"
                variant="secondary"
              >
                <Pencil aria-hidden="true" className="size-5" />
                Chỉnh sửa
              </Button>
            </div>

            <dl className="mt-8 grid gap-4 sm:grid-cols-2">
              <div className="min-w-0 rounded-control bg-white p-4">
                <dt className="flex items-center gap-2 text-label font-bold text-muted">
                  <Mail aria-hidden="true" className="size-5" />
                  Email
                </dt>
                <dd className="mt-2 break-words text-body font-bold text-ink">
                  {contactValue(profile.email, profile.contact_info_status)}
                </dd>
                <p className="mt-1 text-label text-muted">
                  {emailVerificationLabel(
                    profile.email,
                    profile.email_verified,
                    profile.contact_info_status,
                  )}
                </p>
                {profile.pending_email ? (
                  <p className="mt-2 break-words text-sm text-amber-800">
                    Đang chờ xác minh email mới:{" "}
                    <strong>{profile.pending_email}</strong>
                  </p>
                ) : null}
              </div>

              <div className="min-w-0 rounded-control bg-white p-4">
                <dt className="flex items-center gap-2 text-label font-bold text-muted">
                  <Phone aria-hidden="true" className="size-5" />
                  Số điện thoại liên hệ
                </dt>
                <dd className="mt-2 break-words text-body font-bold text-ink">
                  {profile.contact_phone || "Chưa cập nhật"}
                </dd>
              </div>

              <div className="rounded-control bg-white p-4">
                <dt className="flex items-center gap-2 text-label font-bold text-muted">
                  <ShieldCheck aria-hidden="true" className="size-5" />
                  Vai trò
                </dt>
                <dd className="mt-2 text-body font-bold text-ink">
                  {getRoleLabel(profile.role)}
                </dd>
              </div>

              <div className="rounded-control bg-white p-4">
                <dt className="flex items-center gap-2 text-label font-bold text-muted">
                  <CalendarDays aria-hidden="true" className="size-5" />
                  Ngày tạo tài khoản
                </dt>
                <dd className="mt-2 text-body font-bold text-ink">
                  {formatCreatedDate(profile.created_at)}
                </dd>
              </div>
            </dl>
          </>
        )}
      </Card>

      <section
        aria-labelledby="parent-children-heading"
        className="flex flex-col gap-4"
      >
        <header className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-label font-bold text-primary">GIA ĐÌNH</p>
            <h2
              className="mt-1 text-xl font-extrabold text-ink"
              id="parent-children-heading"
            >
              Hồ sơ của trẻ
            </h2>
            <p className="mt-1 text-body text-muted">
              {profile.children.length} hồ sơ trẻ đang liên kết với tài khoản.
            </p>
          </div>
          <Link
            className="text-body font-bold text-primary underline-offset-4 hover:underline"
            href="/children"
          >
            Quản lý hồ sơ trẻ
          </Link>
        </header>

        {profile.children.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {profile.children.map((child) => (
              <Card className="gap-3" key={child.id}>
                <div className="flex items-start gap-3">
                  <ProfileAvatar
                    ariaLabel={`Ảnh đại diện của ${child.alias}`}
                    displayName={child.alias}
                    imageUrl={child.avatar_url}
                    size="md"
                  />
                  <div className="min-w-0">
                    <h3 className="break-words text-lg font-extrabold text-ink">
                      {child.alias}
                    </h3>
                    <p className="mt-1 text-body text-muted">
                      Lớp {child.grade}
                    </p>
                    <p className="mt-1 text-label text-muted">
                      Tạo ngày {formatCreatedDate(child.created_at)}
                    </p>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <StatusMessage tone="info">
            Chưa có hồ sơ trẻ nào được liên kết với tài khoản.
          </StatusMessage>
        )}
      </section>
    </section>
  );
}
