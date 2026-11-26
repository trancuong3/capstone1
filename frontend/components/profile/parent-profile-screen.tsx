"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { InformationField } from "@/components/common/information-field";
import { PageHeader } from "@/components/common/page-header";
import {
  ProfileAvatar,
  resolveDisplayName,
} from "@/components/common/profile-avatar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ParentProfileForm } from "@/components/profile/parent-profile-form";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useI18n } from "@/hooks/use-i18n";
import { useProfileService } from "@/hooks/use-profile-service";
import type { ParentProfileDTO } from "@/types/profile";

type ProfileState =
  | { status: "loading" }
  | { status: "ready"; profile: ParentProfileDTO }
  | { status: "error" };

function ParentProfileLoadingState() {
  const { t } = useI18n();

  return (
    <section
      aria-busy="true"
      aria-label={t("parent.profile.loadingAria")}
      className="mx-auto flex w-full max-w-[1120px] flex-col gap-6"
    >
      <span className="sr-only" role="status">
        {t("common.states.loading")}
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
  const { t, formatDate } = useI18n();
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

  function getRoleLabel(role: ParentProfileDTO["role"]): string {
    return role === "admin"
      ? t("parent.profile.roleAdmin")
      : t("parent.profile.roleParent");
  }

  function contactValue(
    value: string | null,
    status: ParentProfileDTO["contact_info_status"],
  ): string {
    if (value) return value;

    switch (status) {
      case "not_configured":
        return t("parent.profile.contactNotConfigured");
      case "user_not_found":
        return t("parent.profile.contactUserNotFound");
      case "lookup_failed":
        return t("parent.profile.contactLookupFailed");
      default:
        return t("parent.profile.notUpdated");
    }
  }

  function emailVerificationLabel(
    value: string | null,
    verified: boolean | null,
    status: ParentProfileDTO["contact_info_status"],
  ): string {
    if (status !== "available") {
      return t("parent.profile.verifyUnavailable");
    }
    if (!value) return t("parent.profile.verifyNoEmail");
    if (verified === true) return t("parent.profile.verified");
    if (verified === false) return t("parent.profile.unverified");
    return t("parent.profile.verifyUnknown");
  }

  if (state.status === "loading") {
    return <ParentProfileLoadingState />;
  }

  if (state.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-4">
        <StatusMessage title={t("parent.profile.loadErrorTitle")} tone="error">
          {t("auth.errors.generic")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          {t("common.actions.retry")}
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
        <PageHeader
          eyebrow={t("parent.profile.editEyebrow")}
          title={t("parent.profile.editTitle")}
        />
        <Card className="sm:px-8 sm:py-8">
          <h2 className="text-2xl font-extrabold text-ink">
            {t("parent.profile.personalInfoHeading")}
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
    <section className="mx-auto flex w-full max-w-[1120px] flex-col gap-4">
      <PageHeader
        description={t("parent.profile.viewDescription")}
        eyebrow={t("parent.profile.accountEyebrow")}
        title={t("parent.profile.viewTitle")}
      />
      {saveNotice ? (
        <StatusMessage tone="success" role="status">
          {saveNotice}
        </StatusMessage>
      ) : null}
      <Card className="sm:px-8 sm:py-6">
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:gap-6">
          <ProfileAvatar
            ariaLabel={t("parent.profile.avatarAria", {
              name: displayName ?? t("parent.profile.parentFallback"),
            })}
            displayName={displayName}
            imageUrl={profile.avatar_url}
            size="lg"
          />
          <div className="flex min-w-0 flex-col items-start gap-3">
            <h2 className="max-w-full break-words text-2xl font-extrabold text-ink">
              {displayName || t("parent.profile.noDisplayName")}
            </h2>
            <p className="break-all text-body text-muted">
              {contactValue(profile.email, profile.contact_info_status)} ·{" "}
              {getRoleLabel(profile.role)}
            </p>
            <p
              className={`rounded-control px-3 py-2 text-sm font-bold ${profile.email_verified === true ? "bg-success-surface text-success-ink" : "bg-sky text-primary"}`}
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
          {t("parent.profile.editButton")}
        </Button>
        <dl className="grid gap-4 sm:grid-cols-2">
          <InformationField label={t("parent.profile.emailLabel")}>
            {contactValue(profile.email, profile.contact_info_status)}
            {profile.pending_email ? (
              <p className="mt-2 text-sm text-warning">
                {t("parent.profile.pendingEmailPrefix")}{" "}
                <strong>{profile.pending_email}</strong>
              </p>
            ) : null}
          </InformationField>
          <InformationField label={t("parent.profile.contactPhoneLabel")}>
            {profile.contact_phone || t("parent.profile.notUpdated")}
          </InformationField>
          <InformationField label={t("parent.profile.createdAtLabel")}>
            {formatDate(profile.created_at, {
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
              fallback: t("parent.profile.noInfo"),
            })}
          </InformationField>
          <InformationField label={t("parent.profile.roleLabel")}>
            {getRoleLabel(profile.role)}
          </InformationField>
        </dl>
      </Card>
      <section
        aria-labelledby="parent-children-heading"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            className="text-2xl font-extrabold text-ink"
            id="parent-children-heading"
          >
            {t("parent.profile.linkedChildrenHeading")}
          </h2>
          <Link
            className="text-label font-bold text-primary hover:underline"
            href="/children"
          >
            {t("parent.profile.manageChildrenLink")}
          </Link>
        </div>
        {profile.children.length > 0 ? (
          <div className="grid gap-6 sm:grid-cols-2">
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
            {t("parent.profile.noLinkedChildren")}
          </StatusMessage>
        )}
      </section>
    </section>
  );
}
