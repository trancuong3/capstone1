"use client";

import {
  CalendarDays,
  Pencil,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";

import { ParentProfileForm } from "@/components/profile/parent-profile-form";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
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
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ProfileState>({ status: "loading" });
  const [isEditing, setIsEditing] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    let isActive = true;

    async function loadProfile() {
      setState({ status: "loading" });

      try {
        const profile = await profileService.get();
        if (isActive) {
          setState({ status: "ready", profile });
        }
      } catch {
        if (isActive) {
          setState({ status: "error" });
        }
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

  const { profile } = state;

  return (
    <section className="mx-auto flex w-full max-w-[800px] flex-col gap-6">
      <header>
        <p className="text-label font-bold text-primary">HỒ SƠ BA MẸ</p>
        <h1 className="mt-2 text-heading font-extrabold text-ink">
          Thông tin tài khoản
        </h1>
        <p className="mt-2 text-body text-muted">
          Ba mẹ có thể xem và cập nhật tên hiển thị của mình.
        </p>
      </header>

      {showSuccess ? (
        <StatusMessage title="Đã cập nhật hồ sơ" tone="success">
          Thay đổi của ba mẹ đã được lưu thành công.
        </StatusMessage>
      ) : null}

      <Card className="sm:p-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex size-24 shrink-0 items-center justify-center rounded-full bg-sky text-primary">
            <UserRound aria-hidden="true" className="size-12" />
          </div>
          <div className="min-w-0">
            <h2 className="break-words text-2xl font-extrabold leading-[1.4] text-ink">
              {profile.display_name || "Chưa cập nhật tên hiển thị"}
            </h2>
            <p className="mt-1 text-body text-muted">
              {getRoleLabel(profile.role)}
            </p>
          </div>
        </div>

        {isEditing ? (
          <ParentProfileForm
            onCancel={() => setIsEditing(false)}
            onUpdated={(updatedProfile) => {
              setState({ status: "ready", profile: updatedProfile });
              setIsEditing(false);
              setShowSuccess(true);
            }}
            profile={profile}
          />
        ) : (
          <>
            <dl className="grid gap-4 sm:grid-cols-2">
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

            <Button
              className="sm:w-auto sm:self-start sm:px-8"
              onClick={() => {
                setShowSuccess(false);
                setIsEditing(true);
              }}
              variant="secondary"
            >
              <Pencil aria-hidden="true" className="size-5" />
              Chỉnh sửa hồ sơ
            </Button>
          </>
        )}
      </Card>
    </section>
  );
}
