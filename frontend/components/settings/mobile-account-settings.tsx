"use client";

import { ArrowLeft, ArrowRight, Globe, Mail } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { LanguageSelector } from "@/components/i18n/language-selector";
import { ParentEmailPreferencesCard } from "@/components/settings/parent-email-preferences-card";
import { PasswordField } from "@/components/settings/password-field";
import { useI18n } from "@/hooks/use-i18n";
import { getLocaleMetadata, type SupportedLocale } from "@/lib/i18n/locales";
import type { ParentProfileDTO } from "@/types/profile";

export function MobileAccountSettingsLoading() {
  const { t } = useI18n();

  return (
    <section
      aria-busy="true"
      aria-label={t("settings.account.loadingAria")}
      className="flex w-full flex-col gap-4 pb-2"
    >
      <span className="sr-only" role="status">
        {t("common.states.loading")}
      </span>
      <Skeleton className="h-6 w-28 rounded-full" />
      <Skeleton className="h-9 w-3/4" />
      <Skeleton className="h-44 w-full rounded-3xl" />
      <Skeleton className="h-56 w-full rounded-3xl" />
    </section>
  );
}

export function MobileAccountSettingsError({
  onRetry,
}: {
  onRetry: () => void;
}) {
  const { t } = useI18n();

  return (
    <section className="flex w-full flex-col gap-4 pb-2">
      <header className="flex flex-col gap-2">
        <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
          {t("settings.account.eyebrow")}
        </span>
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {t("settings.account.title")}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("settings.account.description")}
        </p>
      </header>
      <StatusMessage
        compact
        title={t("common.states.unavailable")}
        tone="error"
      >
        {t("settings.account.loadErrorBody")}
      </StatusMessage>
      <Button onClick={onRetry} variant="secondary">
        {t("common.states.retryReload")}
      </Button>
    </section>
  );
}

interface MobileAccountSettingsProps {
  profile: ParentProfileDTO;
  displayName: string;
  email: string | null | undefined;
  emailStatus: string;
  isEmailPasswordAccount: boolean;
  showPasswordEditor: boolean;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  showCurrentPassword: boolean;
  showNewPassword: boolean;
  showConfirmPassword: boolean;
  isChangingPassword: boolean;
  isRequestingRecovery: boolean;
  noticeTone: "success" | "error" | null;
  noticeMessage: string | null;
  languageChangedTo: SupportedLocale | null;
  onLocaleChange: (next: SupportedLocale) => void;
  onOpenPasswordEditor: () => void;
  onBackFromPasswordEditor: () => void;
  onCurrentPasswordChange: (value: string) => void;
  onNewPasswordChange: (value: string) => void;
  onConfirmPasswordChange: (value: string) => void;
  onToggleCurrentPassword: () => void;
  onToggleNewPassword: () => void;
  onToggleConfirmPassword: () => void;
  onPasswordChange: (event: FormEvent<HTMLFormElement>) => void;
  onPasswordRecovery: () => void;
}

function MobilePasswordEditor({
  email,
  isEmailPasswordAccount,
  currentPassword,
  newPassword,
  confirmPassword,
  showCurrentPassword,
  showNewPassword,
  showConfirmPassword,
  isChangingPassword,
  isRequestingRecovery,
  noticeTone,
  noticeMessage,
  onBackFromPasswordEditor,
  onCurrentPasswordChange,
  onNewPasswordChange,
  onConfirmPasswordChange,
  onToggleCurrentPassword,
  onToggleNewPassword,
  onToggleConfirmPassword,
  onPasswordChange,
  onPasswordRecovery,
}: Pick<
  MobileAccountSettingsProps,
  | "email"
  | "isEmailPasswordAccount"
  | "currentPassword"
  | "newPassword"
  | "confirmPassword"
  | "showCurrentPassword"
  | "showNewPassword"
  | "showConfirmPassword"
  | "isChangingPassword"
  | "isRequestingRecovery"
  | "noticeTone"
  | "noticeMessage"
  | "onBackFromPasswordEditor"
  | "onCurrentPasswordChange"
  | "onNewPasswordChange"
  | "onConfirmPasswordChange"
  | "onToggleCurrentPassword"
  | "onToggleNewPassword"
  | "onToggleConfirmPassword"
  | "onPasswordChange"
  | "onPasswordRecovery"
>) {
  const { t } = useI18n();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    window.scrollTo?.({ top: 0, behavior: "instant" });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const currentPasswordLabel = t("auth.fields.currentPassword");
  const newPasswordLabel = t("auth.fields.newPassword");
  const confirmPasswordLabel = t("auth.fields.confirmPassword");

  return (
    <section className="flex w-full flex-col gap-4 pb-2">
      <Button
        className="self-start rounded-full border border-border"
        fullWidth={false}
        onClick={onBackFromPasswordEditor}
        size="touch"
        variant="quiet"
      >
        <ArrowLeft aria-hidden="true" className="size-4 viread-rtl-flip" />
        {t("common.actions.back")}
      </Button>

      <header className="flex flex-col gap-1.5">
        <h1
          className="book-title text-[26px] leading-tight text-ink outline-none"
          ref={headingRef}
          tabIndex={-1}
        >
          {t("settings.password.title")}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("settings.password.description")}
        </p>
      </header>

      {noticeTone && noticeMessage ? (
        <StatusMessage compact tone={noticeTone}>
          {noticeMessage}
        </StatusMessage>
      ) : null}

      <div className="flex flex-col gap-4 rounded-3xl border border-border bg-white p-4">
        {isEmailPasswordAccount ? (
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={onPasswordChange}
          >
            <PasswordField
              autoComplete="current-password"
              id="current-password"
              label={currentPasswordLabel}
              onChange={onCurrentPasswordChange}
              onToggle={onToggleCurrentPassword}
              toggleAriaLabel={
                showCurrentPassword
                  ? t("settings.password.hideFieldAria", {
                      label: currentPasswordLabel.toLowerCase(),
                    })
                  : t("settings.password.showFieldAria", {
                      label: currentPasswordLabel.toLowerCase(),
                    })
              }
              value={currentPassword}
              visible={showCurrentPassword}
            />
            <PasswordField
              autoComplete="new-password"
              id="new-password"
              label={newPasswordLabel}
              onChange={onNewPasswordChange}
              onToggle={onToggleNewPassword}
              toggleAriaLabel={
                showNewPassword
                  ? t("settings.password.hideFieldAria", {
                      label: newPasswordLabel.toLowerCase(),
                    })
                  : t("settings.password.showFieldAria", {
                      label: newPasswordLabel.toLowerCase(),
                    })
              }
              value={newPassword}
              visible={showNewPassword}
            />
            <PasswordField
              autoComplete="new-password"
              id="confirm-new-password"
              label={confirmPasswordLabel}
              onChange={onConfirmPasswordChange}
              onToggle={onToggleConfirmPassword}
              toggleAriaLabel={
                showConfirmPassword
                  ? t("settings.password.hideFieldAria", {
                      label: confirmPasswordLabel.toLowerCase(),
                    })
                  : t("settings.password.showFieldAria", {
                      label: confirmPasswordLabel.toLowerCase(),
                    })
              }
              value={confirmPassword}
              visible={showConfirmPassword}
            />
            <p className="text-sm leading-relaxed text-muted">
              {t("settings.password.minLengthHint", { min: 8 })}
            </p>
            <Button
              disabled={isChangingPassword}
              isLoading={isChangingPassword}
              type="submit"
            >
              {t("auth.resetPassword.submit")}
            </Button>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed text-muted">
              {t("settings.password.noPasswordDescription")}
            </p>
            <Button
              disabled={isRequestingRecovery || !email}
              isLoading={isRequestingRecovery}
              onClick={onPasswordRecovery}
            >
              <Mail aria-hidden="true" className="size-5" />
              {t("settings.password.requestRecoveryButton")}
            </Button>
          </div>
        )}

        <Button onClick={onBackFromPasswordEditor} variant="quiet">
          {t("common.actions.cancel")}
        </Button>
      </div>
    </section>
  );
}

export function MobileAccountSettings(props: MobileAccountSettingsProps) {
  const { t } = useI18n();

  if (props.showPasswordEditor) {
    return <MobilePasswordEditor {...props} />;
  }

  const {
    profile,
    displayName,
    email,
    emailStatus,
    languageChangedTo,
    onLocaleChange,
    onOpenPasswordEditor,
  } = props;

  return (
    <section className="flex w-full flex-col gap-5 pb-2">
      <header className="flex flex-col gap-2">
        <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
          {t("settings.account.eyebrow")}
        </span>
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {t("settings.account.title")}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("settings.account.description")}
        </p>
      </header>

      <div className="flex flex-col gap-3.5 rounded-3xl border border-border bg-white p-4">
        <div className="flex items-start gap-2.5">
          <Globe
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-primary"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-extrabold text-ink">
              {t("settings.language.heading")}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {t("settings.language.description")}
            </p>
          </div>
        </div>
        <LanguageSelector onLocaleChange={onLocaleChange} variant="settings" />
        <StatusMessage compact tone="info">
          {t("settings.language.learningContentNote")}
        </StatusMessage>
        {languageChangedTo ? (
          <StatusMessage compact role="status" tone="success">
            {t("notifications.updates.localeChanged", {
              language: getLocaleMetadata(languageChangedTo).nativeName,
            })}
          </StatusMessage>
        ) : null}
      </div>

      <div className="flex flex-col gap-3.5 rounded-3xl border border-border bg-white p-4">
        <h2 className="text-lg font-extrabold text-ink">
          {t("settings.account.infoHeading")}
        </h2>
        <dl className="flex flex-col gap-2.5">
          <div className="rounded-control border border-border bg-canvas/60 px-3.5 py-2.5">
            <dt className="text-sm font-bold text-muted">
              {t("settings.account.displayName")}
            </dt>
            <dd className="mt-0.5 break-words text-body font-semibold text-ink">
              {displayName}
            </dd>
          </div>
          <div className="rounded-control border border-border bg-canvas/60 px-3.5 py-2.5">
            <dt className="text-sm font-bold text-muted">
              {t("settings.account.email")}
            </dt>
            <dd className="mt-0.5 break-all text-body font-semibold text-ink">
              {email || t("common.states.unavailable")}
            </dd>
            {profile.pending_email ? (
              <p className="mt-1.5 break-all text-xs text-warning">
                {t("settings.account.pendingEmailNotice")}{" "}
                <strong>{profile.pending_email}</strong>
              </p>
            ) : null}
          </div>
          <div className="rounded-control border border-border bg-canvas/60 px-3.5 py-2.5">
            <dt className="text-sm font-bold text-muted">
              {t("settings.account.role")}
            </dt>
            <dd className="mt-0.5 text-body font-semibold text-ink">
              {profile.role === "admin"
                ? t("parent.profile.roleAdmin")
                : t("parent.profile.roleParent")}
            </dd>
          </div>
          <div className="rounded-control border border-border bg-canvas/60 px-3.5 py-2.5">
            <dt className="text-sm font-bold text-muted">
              {t("settings.account.emailStatus")}
            </dt>
            <dd className="mt-0.5 flex items-center gap-2 text-body font-semibold text-ink">
              {emailStatus}
            </dd>
          </div>
        </dl>
        <div className="flex flex-col gap-2.5 pt-1">
          <ButtonLink href="/profile" variant="secondary">
            {t("settings.account.manageProfile")}{" "}
            <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
          </ButtonLink>
          <Button onClick={onOpenPasswordEditor} variant="outline">
            {t("settings.account.changePassword")}
          </Button>
        </div>
      </div>

      <ParentEmailPreferencesCard emailVerified={profile.email_verified} />

      <div className="flex flex-col gap-3 rounded-3xl border border-border bg-white p-4">
        <h2 className="text-lg font-extrabold text-ink">
          {t("settings.account.emailVerificationHeading")}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {profile.pending_email
            ? t("settings.account.emailPendingBody")
            : t("settings.account.emailDefaultBody")}
        </p>
        <Link
          className="inline-flex min-h-11 w-fit items-center rounded-control px-1 text-sm font-bold text-primary underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
          href="/profile"
        >
          {t("settings.account.openParentProfile")}
        </Link>
      </div>

      <div className="flex flex-col gap-3 rounded-3xl border border-border bg-white p-4">
        <h2 className="text-lg font-extrabold text-ink">
          {t("settings.account.readingRemindersHeading")}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {t("settings.account.readingRemindersDescription")}
        </p>
        <ButtonLink href="/reading-management" variant="secondary">
          {t("settings.account.readingRemindersHeading")}{" "}
          <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
        </ButtonLink>
      </div>
    </section>
  );
}
