"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { InformationField } from "@/components/common/information-field";
import { ChildProfileCard } from "@/components/children/child-profile-card";
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
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useProfileService } from "@/hooks/use-profile-service";
import type { ParentProfileDTO } from "@/types/profile";

type ProfileState =
  | { status: "loading" }
  | { status: "ready"; profile: ParentProfileDTO }
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
      return "Chưa thể tải email tài khoản";
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
      className="mx-auto flex w-full max-w-[1120px] flex-col gap-6"
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
  const authRuntime = useAuthRuntime();
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ProfileState>({ status: "loading" });
  const [isEditing, setIsEditing] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;

    async function loadProfile() {
      setState({ status: "loading" });

      try {
        const profile = await profileService.get();
        if (!isActive) return;
        setState({ status: "ready", profile });
      } catch {
        if (isActive) setState({ status: "error" });
      }
    }

    void loadProfile();
    return () => {
      isActive = false;
    };
  }, [profileService, requestKey]);

  if (state.status === "loading") {
    return <ParentProfileLoadingState />;
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-4">
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

  const { profile } = state;
  const displayName = resolveDisplayName(
    profile.display_name,
    authRuntime.session?.user.display_name ?? null,
    profile.email,
  );

  function handleSaved(updatedProfile: ParentProfileDTO, message: string) {
    setState({ status: "ready", profile: updatedProfile });
    window.dispatchEvent(
      new CustomEvent("viread:profile-updated", {
        detail: { displayName: updatedProfile.display_name ?? "" },
      }),
    );
    setIsEditing(false);
    setSaveNotice(message);
  }

  function handlePartialSaved(updatedProfile: ParentProfileDTO) {
    setState({ status: "ready", profile: updatedProfile });
  }

  if (isEditing)
    return (
      <section className="mx-auto flex w-full max-w-[744px] flex-col gap-4">
        <PageHeader eyebrow="HỒ SƠ TÀI KHOẢN" title="Chỉnh sửa hồ sơ" />
        <Card className="sm:px-8 sm:py-8">
          <h2 className="text-2xl font-extrabold text-ink">
            Thông tin cá nhân
          </h2>
          <ParentProfileForm
            displayName={displayName ?? ""}
            onCancel={() => setIsEditing(false)}
            onPartialSaved={handlePartialSaved}
            onSaved={handleSaved}
            profile={profile}
          />
        </Card>
      </section>
    );

  return (
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-3.5 md:gap-4">
      <PageHeader
        description="Quản lý hồ sơ ba mẹ và các hồ sơ bé liên kết."
        eyebrow="TÀI KHOẢN VIREAD"
        title="Thông tin tài khoản"
      />
      {saveNotice ? (
        <StatusMessage tone="success" role="status">
          {saveNotice}
        </StatusMessage>
      ) : null}
      <Card className="p-4 sm:px-8 sm:py-6">
        <div className="flex flex-row items-center gap-3.5 sm:items-start sm:gap-6">
          <div className="shrink-0">
            <ProfileAvatar
              ariaLabel={`Ảnh đại diện của ${displayName ?? "ba mẹ"}`}
              displayName={displayName}
              imageUrl={profile.avatar_url}
              size="lg"
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 sm:gap-3">
            <h2 className="max-w-full break-words text-lg font-extrabold text-ink md:text-2xl">
              {displayName || "Chưa cập nhật tên hiển thị"}
            </h2>
            <p className="break-all text-sm text-muted md:text-body">
              {contactValue(profile.email, profile.contact_info_status)} ·{" "}
              {getRoleLabel(profile.role)}
            </p>
            <p
              className={`rounded-control px-2.5 py-1 text-xs font-bold md:px-3 md:py-2 md:text-sm ${profile.email_verified === true ? "bg-success-surface text-success-ink" : "bg-sky text-primary"}`}
            >
              {emailVerificationLabel(
                profile.email,
                profile.email_verified,
                profile.contact_info_status,
              )}
            </p>
          </div>
        </div>
        <Button
          className="sm:max-w-80"
          onClick={() => {
            setSaveNotice(null);
            setIsEditing(true);
          }}
          variant="secondary"
        >
          Chỉnh sửa hồ sơ
        </Button>
        <dl className="grid gap-3 sm:grid-cols-2 sm:gap-4">
          <InformationField label="Email">
            {contactValue(profile.email, profile.contact_info_status)}
            {profile.pending_email ? (
              <p className="mt-2 text-sm text-warning">
                Đang chờ xác minh email mới:{" "}
                <strong>{profile.pending_email}</strong>
              </p>
            ) : null}
          </InformationField>
          <InformationField label="Số điện thoại liên hệ">
            {profile.contact_phone || "Chưa cập nhật"}
          </InformationField>
          <InformationField label="Ngày tạo tài khoản">
            {formatCreatedDate(profile.created_at)}
          </InformationField>
          <InformationField label="Vai trò">
            {getRoleLabel(profile.role)}
          </InformationField>
        </dl>
      </Card>
      <section
        aria-labelledby="parent-children-heading"
        className="flex flex-col gap-3 md:gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 md:gap-3">
          <h2
            className="text-lg font-extrabold text-ink md:text-2xl"
            id="parent-children-heading"
          >
            Hồ sơ bé liên kết
          </h2>
          <Link
            className="inline-flex min-h-11 items-center text-label font-bold text-primary hover:underline"
            href="/children"
          >
            Quản lý hồ sơ trẻ
          </Link>
        </div>
        {profile.children.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2 md:gap-6">
            {profile.children.map((child) => (
              <ChildProfileCard
                key={child.id}
                child={child}
                href={`/children/${encodeURIComponent(child.id)}`}
                showEditAction
              />
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
