"use client";

import { ArrowRight, Globe, Mail } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { FormPage } from "@/components/common/form-page";
import { PageHeader } from "@/components/common/page-header";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useIsMobileViewport } from "@/components/dashboard/use-is-mobile-viewport";
import { LanguageSelector } from "@/components/i18n/language-selector";
import {
  MobileAccountSettings,
  MobileAccountSettingsError,
  MobileAccountSettingsLoading,
} from "@/components/settings/mobile-account-settings";
import { ParentEmailPreferencesCard } from "@/components/settings/parent-email-preferences-card";
import { PasswordField } from "@/components/settings/password-field";
import { useAuthService } from "@/hooks/use-auth-service";
import { useI18n } from "@/hooks/use-i18n";
import { AuthServiceError } from "@/lib/api/auth-service";
import { createProfileService } from "@/lib/api/profile-service";
import { getLocaleMetadata, type SupportedLocale } from "@/lib/i18n/locales";
import type { AuthUserSnapshot } from "@/types/auth";
import type { ParentProfileDTO } from "@/types/profile";

type SettingsState =
  | { status: "loading" }
  | { status: "ready"; profile: ParentProfileDTO; user: AuthUserSnapshot }
  | { status: "error" };

type SettingsNoticeKind =
  | "current_required"
  | "new_min_length"
  | "mismatch"
  | "changed_success"
  | "current_invalid"
  | "change_error"
  | "no_email_recovery"
  | "recovery_sent"
  | "recovery_error";

type NoticeState = {
  tone: "success" | "error";
  kind: SettingsNoticeKind;
};

export function AccountSettingsScreen() {
  const { t } = useI18n();
  const authService = useAuthService();
  const profileService = useMemo(() => createProfileService(), []);
  const isMobile = useIsMobileViewport();
  const [state, setState] = useState<SettingsState>({ status: "loading" });
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [isRequestingRecovery, setIsRequestingRecovery] = useState(false);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [languageChangedTo, setLanguageChangedTo] =
    useState<SupportedLocale | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [showPasswordEditor, setShowPasswordEditor] = useState(false);

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

  function resolveVerificationLabel(profile: ParentProfileDTO): string {
    if (profile.pending_email) return t("settings.account.emailStatusPending");
    if (profile.contact_info_status !== "available")
      return t("common.states.unavailable");
    if (profile.email_verified === true)
      return t("settings.account.emailVerified");
    if (profile.email_verified === false)
      return t("settings.account.emailUnverified");
    return t("common.states.unavailable");
  }

  function resolveNoticeMessage(kind: SettingsNoticeKind): string {
    switch (kind) {
      case "current_required":
        return t("validation.currentPasswordRequired");
      case "new_min_length":
        return t("validation.passwordMinLength", { min: 8 });
      case "mismatch":
        return t("validation.passwordMismatch");
      case "changed_success":
        return t("settings.password.changedSuccess");
      case "current_invalid":
        return t("settings.password.currentInvalid");
      case "change_error":
        return t("settings.password.changeError");
      case "no_email_recovery":
        return t("settings.password.noEmailForRecovery");
      case "recovery_sent":
        return t("settings.password.recoverySent");
      case "recovery_error":
        return t("settings.password.recoveryError");
    }
  }

  async function handlePasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isChangingPassword) return;
    setNotice(null);

    if (!currentPassword.trim()) {
      setNotice({ tone: "error", kind: "current_required" });
      return;
    }
    if (newPassword.length < 8) {
      setNotice({ tone: "error", kind: "new_min_length" });
      return;
    }
    if (newPassword !== confirmPassword) {
      setNotice({ tone: "error", kind: "mismatch" });
      return;
    }

    setIsChangingPassword(true);
    try {
      await authService.changePassword({ currentPassword, newPassword });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setNotice({ tone: "success", kind: "changed_success" });
    } catch (error) {
      setNotice({
        tone: "error",
        kind:
          error instanceof AuthServiceError &&
          error.reason === "invalid-credentials"
            ? "current_invalid"
            : "change_error",
      });
    } finally {
      setIsChangingPassword(false);
    }
  }

  async function handlePasswordRecovery() {
    if (state.status !== "ready" || isRequestingRecovery) return;
    const email = state.profile.email ?? state.user.email;
    if (!email) {
      setNotice({ tone: "error", kind: "no_email_recovery" });
      return;
    }

    setNotice(null);
    setIsRequestingRecovery(true);
    try {
      await authService.requestPasswordReset({ email });
      setNotice({ tone: "success", kind: "recovery_sent" });
    } catch {
      setNotice({ tone: "error", kind: "recovery_error" });
    } finally {
      setIsRequestingRecovery(false);
    }
  }

  if (state.status === "loading") {
    if (isMobile) {
      return <MobileAccountSettingsLoading />;
    }

    return (
      <section
        aria-busy="true"
        aria-label={t("settings.account.loadingAria")}
        className="mx-auto flex w-full max-w-[960px] flex-col gap-6"
      >
        <span className="sr-only" role="status">
          {t("common.states.loading")}
        </span>
        <Skeleton className="h-12 w-2/3" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
      </section>
    );
  }

  if (state.status === "error") {
    if (isMobile) {
      return (
        <MobileAccountSettingsError
          onRetry={() => setRetryKey((key) => key + 1)}
        />
      );
    }

    return (
      <section className="mx-auto flex w-full max-w-[960px] flex-col gap-6 pb-4">
        <PageHeader
          className="mb-0"
          description={t("settings.account.description")}
          title={t("settings.account.title")}
        />
        <StatusMessage title={t("common.states.unavailable")} tone="error">
          {t("settings.account.loadErrorBody")}
        </StatusMessage>
        <Button
          className="sm:w-auto sm:self-start"
          onClick={() => setRetryKey((key) => key + 1)}
          variant="secondary"
        >
          {t("common.states.retryReload")}
        </Button>
      </section>
    );
  }

  const { profile, user } = state;
  const email = profile.email ?? user.email;
  const displayName =
    profile.display_name?.trim() ||
    user.display_name?.trim() ||
    t("settings.account.notUpdated");
  const isEmailPasswordAccount = user.providers?.includes("email") ?? false;
  const emailStatus = resolveVerificationLabel(profile);

  if (isMobile) {
    return (
      <MobileAccountSettings
        confirmPassword={confirmPassword}
        currentPassword={currentPassword}
        displayName={displayName}
        email={email}
        emailStatus={emailStatus}
        isChangingPassword={isChangingPassword}
        isEmailPasswordAccount={isEmailPasswordAccount}
        isRequestingRecovery={isRequestingRecovery}
        languageChangedTo={languageChangedTo}
        newPassword={newPassword}
        noticeMessage={notice ? resolveNoticeMessage(notice.kind) : null}
        noticeTone={notice ? notice.tone : null}
        onBackFromPasswordEditor={() => setShowPasswordEditor(false)}
        onConfirmPasswordChange={setConfirmPassword}
        onCurrentPasswordChange={setCurrentPassword}
        onLocaleChange={(next) => setLanguageChangedTo(next)}
        onNewPasswordChange={setNewPassword}
        onOpenPasswordEditor={() => setShowPasswordEditor(true)}
        onPasswordChange={(event) => void handlePasswordChange(event)}
        onPasswordRecovery={() => void handlePasswordRecovery()}
        onToggleConfirmPassword={() =>
          setShowConfirmPassword((value) => !value)
        }
        onToggleCurrentPassword={() =>
          setShowCurrentPassword((value) => !value)
        }
        onToggleNewPassword={() => setShowNewPassword((value) => !value)}
        profile={profile}
        showConfirmPassword={showConfirmPassword}
        showCurrentPassword={showCurrentPassword}
        showNewPassword={showNewPassword}
        showPasswordEditor={showPasswordEditor}
      />
    );
  }

  const currentPasswordLabel = t("auth.fields.currentPassword");
  const newPasswordLabel = t("auth.fields.newPassword");
  const confirmPasswordLabel = t("auth.fields.confirmPassword");

  if (showPasswordEditor)
    return (
      <FormPage
        description={t("settings.password.description")}
        onBack={() => setShowPasswordEditor(false)}
        title={t("settings.password.title")}
        width="standard"
      >
        {notice ? (
          <StatusMessage tone={notice.tone}>
            {resolveNoticeMessage(notice.kind)}
          </StatusMessage>
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
              label={currentPasswordLabel}
              onChange={setCurrentPassword}
              onToggle={() => setShowCurrentPassword((value) => !value)}
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
              onChange={setNewPassword}
              onToggle={() => setShowNewPassword((value) => !value)}
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
              onChange={setConfirmPassword}
              onToggle={() => setShowConfirmPassword((value) => !value)}
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
              className="sm:w-auto sm:self-start sm:px-8"
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
              className="sm:w-auto sm:self-start sm:px-8"
              disabled={isRequestingRecovery || !email}
              isLoading={isRequestingRecovery}
              onClick={() => void handlePasswordRecovery()}
            >
              <Mail aria-hidden="true" className="size-5" />
              {t("settings.password.requestRecoveryButton")}
            </Button>
          </div>
        )}
      </FormPage>
    );

  return (
    <section className="settings-sheet mx-auto flex w-full max-w-[960px] flex-col gap-6 pb-4">
      <PageHeader
        className="mb-0"
        description={t("settings.account.description")}
        eyebrow={t("settings.account.eyebrow")}
        title={t("settings.account.title")}
      />

      <Card>
        <div className="flex items-start gap-3">
          <Globe
            aria-hidden="true"
            className="mt-1 size-6 shrink-0 text-primary"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-extrabold text-ink">
              {t("settings.language.heading")}
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-muted">
              {t("settings.language.description")}
            </p>
          </div>
        </div>
        <div className="max-w-md">
          <LanguageSelector
            onLocaleChange={(next) => setLanguageChangedTo(next)}
            variant="settings"
          />
        </div>
        <StatusMessage tone="info">
          {t("settings.language.learningContentNote")}
        </StatusMessage>
        {languageChangedTo ? (
          <StatusMessage role="status" tone="success">
            {t("notifications.updates.localeChanged", {
              language: getLocaleMetadata(languageChangedTo).nativeName,
            })}
          </StatusMessage>
        ) : null}
      </Card>

      <Card>
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-2xl font-extrabold text-ink">
              {t("settings.account.infoHeading")}
            </h2>
          </div>
        </div>

        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-control border border-border bg-white px-4 py-3">
            <dt className="text-sm font-semibold text-muted">
              {t("settings.account.displayName")}
            </dt>
            <dd className="mt-1 break-words text-body font-semibold text-ink">
              {displayName}
            </dd>
          </div>
          <div className="rounded-control border border-border bg-white px-4 py-3">
            <dt className="text-sm font-semibold text-muted">
              {t("settings.account.email")}
            </dt>
            <dd className="mt-1 break-all text-body font-semibold text-ink">
              {email || t("common.states.unavailable")}
            </dd>
            {profile.pending_email ? (
              <p className="mt-2 break-all text-sm text-warning">
                {t("settings.account.pendingEmailNotice")}{" "}
                <strong>{profile.pending_email}</strong>
              </p>
            ) : null}
          </div>
          <div className="rounded-control border border-border bg-white px-4 py-3">
            <dt className="text-sm font-semibold text-muted">
              {t("settings.account.role")}
            </dt>
            <dd className="mt-1 text-body font-semibold text-ink">
              {profile.role === "admin"
                ? t("parent.profile.roleAdmin")
                : t("parent.profile.roleParent")}
            </dd>
          </div>
          <div className="rounded-control border border-border bg-white px-4 py-3">
            <dt className="text-sm font-semibold text-muted">
              {t("settings.account.emailStatus")}
            </dt>
            <dd className="mt-1 flex items-center gap-2 text-body font-semibold text-ink">
              {emailStatus}
            </dd>
          </div>
        </dl>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/profile"
          variant="secondary"
        >
          {t("settings.account.manageProfile")}{" "}
          <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
        </ButtonLink>
      </Card>

      <Button
        className="sm:max-w-72"
        onClick={() => setShowPasswordEditor(true)}
        variant="secondary"
      >
        {t("settings.account.changePassword")}
      </Button>

      <ParentEmailPreferencesCard emailVerified={profile.email_verified} />

      <Card>
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-2xl font-extrabold text-ink">
              {t("settings.account.emailVerificationHeading")}
            </h2>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-muted">
          {profile.pending_email
            ? t("settings.account.emailPendingBody")
            : t("settings.account.emailDefaultBody")}
        </p>
        <Link
          className="inline-flex min-h-11 w-fit items-center text-base font-semibold text-primary underline-offset-4 hover:underline"
          href="/profile"
        >
          {t("settings.account.openParentProfile")}
        </Link>
      </Card>

      <Card>
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-2xl font-extrabold text-ink">
              {t("settings.account.readingRemindersHeading")}
            </h2>
            <p className="mt-0.5 text-sm leading-relaxed text-muted">
              {t("settings.account.readingRemindersDescription")}
            </p>
          </div>
        </div>
        <ButtonLink
          className="sm:w-auto sm:self-start"
          href="/reading-management"
          variant="secondary"
        >
          {t("settings.account.readingRemindersHeading")}{" "}
          <ArrowRight aria-hidden="true" className="size-5 viread-rtl-flip" />
        </ButtonLink>
      </Card>
    </section>
  );
}
