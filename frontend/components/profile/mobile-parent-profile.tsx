"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";

import { ChildProfileCard } from "@/components/children/child-profile-card";
import { Button } from "@/components/common/button";
import { InformationField } from "@/components/common/information-field";
import { ProfileAvatar } from "@/components/common/profile-avatar";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { ParentProfileForm } from "@/components/profile/parent-profile-form";
import { useI18n } from "@/hooks/use-i18n";
import type { ParentProfileDTO } from "@/types/profile";

interface MobileParentProfileLoadingProps {
  loadingAriaLabel: string;
  loadingStatusText: string;
}

export function MobileParentProfileLoading({
  loadingAriaLabel,
  loadingStatusText,
}: MobileParentProfileLoadingProps) {
  return (
    <section
      aria-busy="true"
      aria-label={loadingAriaLabel}
      className="flex w-full flex-col gap-4 pb-2"
    >
      <span className="sr-only" role="status">
        {loadingStatusText}
      </span>
      <Skeleton className="h-6 w-28 rounded-full" />
      <Skeleton className="h-9 w-3/4" />
      <div className="flex flex-col gap-4 rounded-3xl border border-border bg-white p-4">
        <Skeleton className="mx-auto h-24 w-24 rounded-full" />
        <Skeleton className="mx-auto h-7 w-1/2" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    </section>
  );
}

interface MobileParentProfileErrorProps {
  onRetry: () => void;
}

export function MobileParentProfileError({
  onRetry,
}: MobileParentProfileErrorProps) {
  const { t } = useI18n();

  return (
    <section className="flex w-full flex-col gap-4 pb-2">
      <StatusMessage
        compact
        title={t("parent.profile.loadErrorTitle")}
        tone="error"
      >
        {t("auth.errors.generic")}
      </StatusMessage>
      <Button onClick={onRetry} variant="secondary">
        <RefreshCw aria-hidden="true" className="size-5" />
        {t("common.actions.retry")}
      </Button>
    </section>
  );
}

interface MobileParentProfileProps {
  profile: ParentProfileDTO;
  displayName: string | null;
  isEditing: boolean;
  saveNotice: string | null;
  emailText: string;
  roleLabel: string;
  verificationLabel: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (updatedProfile: ParentProfileDTO, message: string) => void;
  onPartialSaved: (updatedProfile: ParentProfileDTO) => void;
}

export function MobileParentProfile({
  profile,
  displayName,
  isEditing,
  saveNotice,
  emailText,
  roleLabel,
  verificationLabel,
  onStartEdit,
  onCancelEdit,
  onSaved,
  onPartialSaved,
}: MobileParentProfileProps) {
  const { t, formatDate } = useI18n();

  if (isEditing) {
    return (
      <section className="flex w-full flex-col gap-5 pb-2">
        <header className="flex flex-col gap-2">
          <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
            {t("parent.profile.editEyebrow")}
          </span>
          <h1 className="book-title text-[26px] leading-tight text-ink">
            {t("parent.profile.editTitle")}
          </h1>
        </header>
        <div className="flex w-full flex-col gap-4 rounded-3xl border border-border bg-white p-4">
          <h2 className="text-lg font-extrabold text-ink">
            {t("parent.profile.personalInfoHeading")}
          </h2>
          <ParentProfileForm
            displayName={displayName ?? ""}
            onCancel={onCancelEdit}
            onPartialSaved={onPartialSaved}
            onSaved={onSaved}
            profile={profile}
          />
        </div>
      </section>
    );
  }

  return (
    <section className="flex w-full flex-col gap-5 pb-2">
      <header className="flex flex-col gap-2">
        <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
          {t("parent.profile.accountEyebrow")}
        </span>
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {t("parent.profile.viewTitle")}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("parent.profile.viewDescription")}
        </p>
      </header>

      {saveNotice ? (
        <StatusMessage compact role="status" tone="success">
          {saveNotice}
        </StatusMessage>
      ) : null}

      <div className="flex flex-col gap-4 rounded-3xl border border-border bg-gradient-to-b from-sky/55 via-cream to-white p-5">
        <div className="flex flex-col items-center gap-3 text-center">
          <ProfileAvatar
            ariaLabel={t("parent.profile.avatarAria", {
              name: displayName ?? t("parent.profile.parentFallback"),
            })}
            displayName={displayName}
            imageUrl={profile.avatar_url}
            size="lg"
          />
          <div className="flex min-w-0 max-w-full flex-col items-center gap-1.5">
            <h2 className="max-w-full break-words text-xl font-extrabold text-ink">
              {displayName || t("parent.profile.noDisplayName")}
            </h2>
            <p className="max-w-full break-all text-sm leading-relaxed text-muted">
              {emailText} · {roleLabel}
            </p>
            <span
              className={`mt-1 inline-flex items-center rounded-full px-3 py-1 text-xs font-bold ${
                profile.email_verified === true
                  ? "bg-success-surface text-success-ink"
                  : "bg-sky text-primary"
              }`}
            >
              {verificationLabel}
            </span>
          </div>
        </div>

        <Button onClick={onStartEdit} variant="secondary">
          {t("parent.profile.editButton")}
        </Button>
      </div>

      <div className="flex flex-col gap-3 rounded-3xl border border-border bg-white p-4">
        <dl className="flex flex-col gap-3">
          <InformationField label={t("parent.profile.emailLabel")}>
            {emailText}
            {profile.pending_email ? (
              <p className="mt-1.5 text-xs text-warning">
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
            {roleLabel}
          </InformationField>
        </dl>
      </div>

      <section
        aria-labelledby="parent-children-heading"
        className="flex flex-col gap-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2
            className="text-lg font-extrabold text-ink"
            id="parent-children-heading"
          >
            {t("parent.profile.linkedChildrenHeading")}
          </h2>
          <Link
            className="inline-flex min-h-11 items-center rounded-control px-2 text-sm font-bold text-primary hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
            href="/children"
          >
            {t("parent.profile.manageChildrenLink")}
          </Link>
        </div>

        {profile.children.length > 0 ? (
          <div className="flex flex-col gap-3">
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
          <StatusMessage compact tone="info">
            {t("parent.profile.noLinkedChildren")}
          </StatusMessage>
        )}
      </section>
    </section>
  );
}
