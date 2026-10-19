"use client";

import {
  CalendarDays,
  Mail,
  Pencil,
  Phone,
  RefreshCw,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import {
  ParentProfileForm,
  type ParentProfileEditableField,
} from "@/components/profile/parent-profile-form";
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
  const [requestKey, setRequestKey] = useState(0);
  const [state, setState] = useState<ProfileState>({ status: "loading" });
  const [editingField, setEditingField] =
    useState<ParentProfileEditableField | null>(null);
  const [fieldNotices, setFieldNotices] = useState<
    Partial<Record<ParentProfileEditableField, string>>
  >({});

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

  function beginEditing(field: ParentProfileEditableField) {
    setFieldNotices((current) => ({ ...current, [field]: undefined }));
    setEditingField(field);
  }

  function handleSaved(
    field: ParentProfileEditableField,
    updatedProfile: ParentProfileDTO,
    message: string,
  ) {
    setState({ status: "ready", profile: updatedProfile });
    setEditingField(null);
    setFieldNotices((current) => ({ ...current, [field]: message }));
  }

  function renderInlineEditor(field: ParentProfileEditableField) {
    if (editingField !== field || state.status !== "ready") return null;

    return (
      <ParentProfileForm
        field={field}
        onCancel={() => setEditingField(null)}
        onSaved={handleSaved}
        profile={state.profile}
      />
    );
  }

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
          Xem và cập nhật thông tin liên hệ cùng các hồ sơ trẻ đã liên kết với
          ViRead.
        </p>
      </header>

      <Card className="sm:p-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex size-24 shrink-0 items-center justify-center rounded-full bg-sky text-primary">
            <UserRound aria-hidden="true" className="size-12" />
          </div>
          <div className="min-w-0 flex-1">
            {editingField === "display_name" ? (
              renderInlineEditor("display_name")
            ) : (
              <div className="flex items-center gap-2">
                <h2 className="break-words text-2xl font-extrabold leading-[1.4] text-ink">
                  {profile.display_name || "Chưa cập nhật tên hiển thị"}
                </h2>
                <Button
                  aria-label="Chỉnh sửa tên hiển thị"
                  className="!h-10 !w-10 shrink-0 px-2"
                  onClick={() => beginEditing("display_name")}
                  title="Chỉnh sửa tên hiển thị"
                  variant="quiet"
                >
                  <Pencil aria-hidden="true" className="size-4" />
                </Button>
              </div>
            )}
            {editingField !== "display_name" ? (
              <p className="mt-1 text-body text-muted">
                {getRoleLabel(profile.role)}
              </p>
            ) : null}
            {fieldNotices.display_name ? (
              <p className="mt-2 text-sm text-primary" role="status">
                {fieldNotices.display_name}
              </p>
            ) : null}
          </div>
        </div>

        <dl className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="min-w-0 rounded-control bg-white p-4">
            <dt className="flex items-center gap-2 text-label font-bold text-muted">
              <Mail aria-hidden="true" className="size-5" />
              Email
            </dt>
            {editingField === "email" ? (
              renderInlineEditor("email")
            ) : (
              <>
                <div className="mt-2 flex min-w-0 items-start gap-2">
                  <dd className="min-w-0 flex-1 break-words text-body font-bold text-ink">
                    {contactValue(profile.email, profile.contact_info_status)}
                  </dd>
                  <Button
                    aria-label="Chỉnh sửa email"
                    className="!h-10 !w-10 shrink-0 px-2"
                    onClick={() => beginEditing("email")}
                    title="Chỉnh sửa email"
                    variant="quiet"
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                  </Button>
                </div>
                <p className="mt-1 text-label text-muted">
                  {emailVerificationLabel(
                    profile.email,
                    profile.email_verified,
                    profile.contact_info_status,
                  )}
                </p>
                {profile.pending_email ? (
                  <p className="mt-2 break-words text-sm text-amber-700">
                    Đang chờ xác minh email mới:{" "}
                    <strong>{profile.pending_email}</strong>
                  </p>
                ) : null}
              </>
            )}
            {fieldNotices.email ? (
              <p
                className="mt-2 break-words text-sm text-primary"
                role="status"
              >
                {fieldNotices.email}
              </p>
            ) : null}
          </div>

          <div className="min-w-0 rounded-control bg-white p-4">
            <dt className="flex items-center gap-2 text-label font-bold text-muted">
              <Phone aria-hidden="true" className="size-5" />
              Số điện thoại liên hệ
            </dt>
            {editingField === "contact_phone" ? (
              renderInlineEditor("contact_phone")
            ) : (
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <dd className="min-w-0 flex-1 break-words text-body font-bold text-ink">
                  {profile.contact_phone || "Chưa cập nhật"}
                </dd>
                <Button
                  aria-label="Chỉnh sửa số điện thoại liên hệ"
                  className="!h-10 !w-10 shrink-0 px-2"
                  onClick={() => beginEditing("contact_phone")}
                  title="Chỉnh sửa số điện thoại liên hệ"
                  variant="quiet"
                >
                  <Pencil aria-hidden="true" className="size-4" />
                </Button>
              </div>
            )}
            {fieldNotices.contact_phone ? (
              <p
                className="mt-2 break-words text-sm text-primary"
                role="status"
              >
                {fieldNotices.contact_phone}
              </p>
            ) : null}
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
                  <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-sky text-primary">
                    <UsersRound aria-hidden="true" className="size-6" />
                  </div>
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
          <Card>
            <h3 className="text-lg font-bold text-ink">Chưa có hồ sơ trẻ</h3>
            <p className="mt-1 text-body text-muted">
              Ba mẹ có thể tạo hồ sơ cho trẻ để bắt đầu sử dụng ViRead.
            </p>
            <Link
              className="mt-3 inline-flex font-bold text-primary underline-offset-4 hover:underline"
              href="/children/new"
            >
              Tạo hồ sơ trẻ
            </Link>
          </Card>
        )}
      </section>
    </section>
  );
}
