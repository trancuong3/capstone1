"use client";

import { BookOpenCheck, Bot, Send, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { openViReadAssistant } from "@/components/assistant/viread-assistant-widget";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { FormPage } from "@/components/common/form-page";
import { PageHeader } from "@/components/common/page-header";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthService } from "@/hooks/use-auth-service";
import { useI18n } from "@/hooks/use-i18n";
import {
  createSupportService,
  SupportFeedbackError,
} from "@/lib/api/support-service";
import { VIREAD_SUPPORT_EMAIL } from "@/lib/config/contact";
import type { SupportFeedbackCategory } from "@/types/support";

type SupportErrorState =
  | { readonly kind: "required" }
  | { readonly kind: "length" }
  | { readonly kind: "email" }
  | { readonly kind: "submit"; readonly rawMessage?: string };

const categoryValues: readonly SupportFeedbackCategory[] = [
  "technical_issue",
  "feature_feedback",
  "account_support",
  "how_to",
  "feature_request",
  "other",
];

const faqStructure = [
  { key: "account", items: ["1", "2", "3"] },
  { key: "children", items: ["1", "2"] },
  { key: "books", items: ["1", "2"] },
  { key: "reading", items: ["1", "2", "3"] },
] as const;

export function HelpSupportScreen() {
  const { t, formatNumber } = useI18n();
  const authService = useAuthService();
  const supportService = useMemo(() => createSupportService(), []);
  const [category, setCategory] =
    useState<SupportFeedbackCategory>("technical_issue");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [hasEditedEmail, setHasEditedEmail] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showFeedbackEditor, setShowFeedbackEditor] = useState(false);
  const [errorState, setErrorState] = useState<SupportErrorState | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    let active = true;
    void authService
      .getCurrentUser()
      .then((user) => {
        if (active && !hasEditedEmail && user?.email) {
          setContactEmail(user.email);
        }
      })
      .catch(() => {
        // Email remains editable if Auth lookup is temporarily unavailable.
      });

    return () => {
      active = false;
    };
  }, [authService, hasEditedEmail]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setErrorState(null);
    setIsSuccess(false);

    const normalizedSubject = subject.trim();
    const normalizedMessage = message.trim();
    const normalizedEmail = contactEmail.trim().toLowerCase();

    if (!normalizedSubject || !normalizedMessage || !normalizedEmail) {
      setErrorState({ kind: "required" });
      return;
    }
    if (normalizedSubject.length > 120 || normalizedMessage.length > 5000) {
      setErrorState({ kind: "length" });
      return;
    }
    if (
      normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      setErrorState({ kind: "email" });
      return;
    }

    setIsSubmitting(true);
    try {
      await supportService.submitFeedback({
        category,
        subject: normalizedSubject,
        message: normalizedMessage,
        contact_email: normalizedEmail,
      });
      setSubject("");
      setMessage("");
      setIsSuccess(true);
    } catch (error) {
      setErrorState({
        kind: "submit",
        rawMessage:
          error instanceof SupportFeedbackError ? error.message : undefined,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  const errorMessage =
    errorState?.kind === "required"
      ? t("validation.supportRequiredFields")
      : errorState?.kind === "length"
        ? t("validation.supportLengthExceeded")
        : errorState?.kind === "email"
          ? t("validation.supportContactEmailInvalid")
          : errorState?.kind === "submit"
            ? (errorState.rawMessage ?? t("parent.support.submitError"))
            : null;

  if (showFeedbackEditor)
    return (
      <FormPage
        title={t("parent.support.feedbackTitle")}
        description={t("parent.support.feedbackDescription")}
        onBack={() => setShowFeedbackEditor(false)}
      >
        {isSuccess ? (
          <StatusMessage tone="success">
            {t("parent.support.sentSuccessDetail")}
          </StatusMessage>
        ) : null}
        {errorMessage ? (
          <StatusMessage tone="error">{errorMessage}</StatusMessage>
        ) : null}

        <form
          className="grid gap-4 sm:grid-cols-2"
          noValidate
          onSubmit={handleSubmit}
        >
          <div className="flex min-h-[72px] min-w-0 flex-col gap-1 rounded-control border border-border bg-white px-4 py-3">
            <label
              className="text-label font-semibold text-muted"
              htmlFor="support-category"
            >
              {t("parent.support.categoryLabel")}
            </label>
            <select
              className="min-w-0 flex-1 bg-transparent text-start text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
              id="support-category"
              onChange={(event) =>
                setCategory(event.target.value as SupportFeedbackCategory)
              }
              value={category}
            >
              {categoryValues.map((value) => (
                <option key={value} value={value}>
                  {t(`parent.support.categories.${value}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex min-h-[72px] min-w-0 flex-col gap-1 rounded-control border border-border bg-white px-4 py-3">
            <label
              className="text-label font-semibold text-muted"
              htmlFor="support-subject"
            >
              {t("parent.support.subjectLabel")}
            </label>
            <input
              className="min-w-0 flex-1 bg-transparent text-start text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
              id="support-subject"
              maxLength={120}
              onChange={(event) => setSubject(event.target.value)}
              required
              value={subject}
            />
            <span className="text-end text-xs text-muted tabular-nums">
              {t("parent.support.charCount", {
                count: formatNumber(subject.length),
                max: formatNumber(120),
              })}
            </span>
          </div>

          <div className="flex flex-col gap-1 rounded-control sm:col-span-2 border border-border bg-white px-4 py-3">
            <label
              className="text-label font-semibold text-muted"
              htmlFor="support-message"
            >
              {t("parent.support.messageLabel")}
            </label>
            <textarea
              className="min-h-36 resize-y bg-transparent text-start text-body leading-6 text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
              id="support-message"
              maxLength={5000}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t("parent.support.messagePlaceholder")}
              required
              rows={6}
              value={message}
            />
            <span className="text-end text-xs text-muted tabular-nums">
              {t("parent.support.charCount", {
                count: formatNumber(message.length),
                max: formatNumber(5000),
              })}
            </span>
          </div>

          <div className="flex min-h-[72px] min-w-0 flex-col gap-1 sm:col-span-2 rounded-control border border-border bg-white px-4 py-3">
            <label
              className="text-label font-semibold text-muted"
              htmlFor="support-contact-email"
            >
              {t("parent.support.contactEmailLabel")}
            </label>
            <input
              autoComplete="email"
              className="min-w-0 flex-1 bg-transparent text-start text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
              id="support-contact-email"
              maxLength={254}
              onChange={(event) => {
                setHasEditedEmail(true);
                setContactEmail(event.target.value);
              }}
              required
              type="email"
              value={contactEmail}
            />
          </div>

          <Button
            className="sm:w-auto sm:self-start sm:px-8"
            disabled={isSubmitting}
            isLoading={isSubmitting}
            type="submit"
          >
            <Send aria-hidden="true" className="size-5 viread-rtl-flip" />
            {t("parent.support.submitFeedback")}
          </Button>
        </form>

        <p className="flex items-start gap-2 text-xs leading-5 text-muted">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("parent.support.privacyNote")}
        </p>
      </FormPage>
    );

  return (
    <section className="support-sheet mx-auto flex w-full max-w-[1120px] flex-col gap-4">
      <PageHeader
        description={t("parent.support.description")}
        title={t("parent.support.title")}
      />

      <section
        aria-labelledby="support-quick-guide-heading"
        className="flex flex-col gap-4 rounded-card border border-border bg-white p-4 sm:px-8 sm:py-6"
        id="user-guide"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sky text-primary"
          >
            <BookOpenCheck className="size-5" />
          </span>
          <div>
            <h2
              className="text-xl font-extrabold text-ink sm:text-2xl"
              id="support-quick-guide-heading"
            >
              {t("navigation.guide.title")}
            </h2>
            <p className="text-sm text-muted">
              {t("navigation.guide.subtitle")}
            </p>
          </div>
        </div>

        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(
            [
              { key: "1", href: "/children" },
              { key: "2", href: "/my-books" },
              { key: "3", href: "/device-permissions" },
              { key: "4", href: "/reports/difficult-words" },
              { key: "5", href: "/reading-management" },
            ] as const
          ).map((step) => (
            <li
              className="flex flex-col justify-between gap-2.5 rounded-control border border-border bg-canvas/60 p-3.5"
              key={step.key}
            >
              <div>
                <p className="text-sm font-extrabold text-ink">
                  {t(`navigation.guide.steps.${step.key}.title`)}
                </p>
                <p className="mt-1 text-xs leading-5 text-muted">
                  {t(`navigation.guide.steps.${step.key}.body`)}
                </p>
              </div>
              <Link
                className="inline-flex min-h-9 self-start items-center rounded-control border border-primary/30 bg-white px-3 text-xs font-bold text-primary transition-colors hover:bg-sky"
                href={step.href}
              >
                {t(`navigation.guide.steps.${step.key}.action`)}
              </Link>
            </li>
          ))}
        </ol>
      </section>

      <section
        aria-labelledby="support-faq-heading"
        className="flex flex-col gap-4 rounded-card border border-border bg-white p-4 sm:px-8 sm:py-6"
      >
        <div className="flex items-center gap-3">
          <div>
            <h2
              className="text-2xl font-extrabold text-ink"
              id="support-faq-heading"
            >
              {t("parent.support.faqHeading")}
            </h2>
            <p className="text-sm text-muted">
              {t("parent.support.faqSubtitle")}
            </p>
          </div>
        </div>

        {faqStructure.map((group) => (
          <div className="flex flex-col gap-2" key={group.key}>
            <h3 className="text-xl font-extrabold text-ink">
              {t(`parent.support.faq.${group.key}.title`)}
            </h3>
            <div className="flex flex-col gap-1">
              {group.items.map((itemKey) => (
                <details className="group py-1" key={itemKey}>
                  <summary className="flex cursor-pointer list-none items-center gap-3 rounded-control py-2 text-start text-body text-ink outline-none marker:hidden hover:text-primary focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
                    <span>
                      {t(`parent.support.faq.${group.key}.q${itemKey}`)}
                    </span>
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-lg text-primary transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="pb-2 pt-1 text-sm leading-6 text-muted">
                    {t(`parent.support.faq.${group.key}.a${itemKey}`)}
                  </p>
                </details>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section
        aria-labelledby="support-contact-heading"
        className="flex flex-col gap-4"
      >
        <Card>
          <div className="flex items-center gap-3">
            <div>
              <h2
                className="text-2xl font-extrabold text-ink"
                id="support-contact-heading"
              >
                {t("parent.support.contactHeading")}
              </h2>
            </div>
          </div>
          <a
            className="inline-flex min-h-11 w-fit max-w-full items-center gap-3 rounded-control font-bold text-primary underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
            href={"mailto:" + VIREAD_SUPPORT_EMAIL}
          >
            <span className="break-all">{VIREAD_SUPPORT_EMAIL}</span>
          </a>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              className="sm:max-w-72"
              variant="secondary"
              onClick={() => setShowFeedbackEditor(true)}
            >
              {t("parent.support.openFeedbackButton")}
            </Button>
            <Button
              className="sm:max-w-72"
              variant="outline"
              onClick={() => openViReadAssistant()}
            >
              <Bot aria-hidden="true" className="size-4" />
              {t("common.assistant.openFromSupport")}
            </Button>
          </div>
        </Card>
      </section>
    </section>
  );
}
