"use client";

import { ArrowLeft, Send, ShieldCheck } from "lucide-react";
import { useLayoutEffect, useRef, type FormEvent } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n } from "@/hooks/use-i18n";
import { VIREAD_SUPPORT_EMAIL } from "@/lib/config/contact";
import type { SupportFeedbackCategory } from "@/types/support";

interface MobileHelpSupportProps {
  categoryValues: readonly SupportFeedbackCategory[];
  faqStructure: ReadonlyArray<{
    readonly key: "account" | "children" | "books" | "reading";
    readonly items: readonly string[];
  }>;
  category: SupportFeedbackCategory;
  subject: string;
  message: string;
  contactEmail: string;
  isSubmitting: boolean;
  showFeedbackEditor: boolean;
  errorMessage: string | null;
  isSuccess: boolean;
  onCategoryChange: (value: SupportFeedbackCategory) => void;
  onSubjectChange: (value: string) => void;
  onMessageChange: (value: string) => void;
  onContactEmailChange: (value: string) => void;
  onOpenFeedbackEditor: () => void;
  onBackFromFeedback: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function MobileFeedbackEditor({
  categoryValues,
  category,
  subject,
  message,
  contactEmail,
  isSubmitting,
  errorMessage,
  isSuccess,
  onCategoryChange,
  onSubjectChange,
  onMessageChange,
  onContactEmailChange,
  onBackFromFeedback,
  onSubmit,
}: Omit<
  MobileHelpSupportProps,
  "faqStructure" | "showFeedbackEditor" | "onOpenFeedbackEditor"
>) {
  const { t, formatNumber } = useI18n();
  const headingRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    window.scrollTo?.({ top: 0, behavior: "instant" });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section className="flex w-full flex-col gap-4 pb-2">
      <Button
        className="self-start rounded-full border border-border"
        fullWidth={false}
        onClick={onBackFromFeedback}
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
          {t("parent.support.feedbackTitle")}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("parent.support.feedbackDescription")}
        </p>
      </header>

      {isSuccess ? (
        <StatusMessage compact tone="success">
          {t("parent.support.sentSuccessDetail")}
        </StatusMessage>
      ) : null}
      {errorMessage ? (
        <StatusMessage compact tone="error">
          {errorMessage}
        </StatusMessage>
      ) : null}

      <div className="flex flex-col gap-4 rounded-3xl border border-border bg-white p-4">
        <form className="flex flex-col gap-4" noValidate onSubmit={onSubmit}>
          <div className="flex min-h-[72px] min-w-0 flex-col gap-1 rounded-control border border-border bg-white px-4 py-3">
            <label
              className="text-label font-semibold text-muted"
              htmlFor="support-category"
            >
              {t("parent.support.categoryLabel")}
            </label>
            <select
              className="min-h-11 w-full min-w-0 bg-transparent text-start text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
              id="support-category"
              onChange={(event) =>
                onCategoryChange(event.target.value as SupportFeedbackCategory)
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
              className="min-h-11 w-full min-w-0 bg-transparent text-start text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
              id="support-subject"
              maxLength={120}
              onChange={(event) => onSubjectChange(event.target.value)}
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

          <div className="flex flex-col gap-1 rounded-control border border-border bg-white px-4 py-3">
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
              onChange={(event) => onMessageChange(event.target.value)}
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

          <div className="flex min-h-[72px] min-w-0 flex-col gap-1 rounded-control border border-border bg-white px-4 py-3">
            <label
              className="text-label font-semibold text-muted"
              htmlFor="support-contact-email"
            >
              {t("parent.support.contactEmailLabel")}
            </label>
            <input
              autoComplete="email"
              className="min-h-11 w-full min-w-0 bg-transparent text-start text-body text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary"
              id="support-contact-email"
              maxLength={254}
              onChange={(event) => onContactEmailChange(event.target.value)}
              required
              type="email"
              value={contactEmail}
            />
          </div>

          <Button
            disabled={isSubmitting}
            isLoading={isSubmitting}
            type="submit"
          >
            <Send aria-hidden="true" className="size-5 viread-rtl-flip" />
            {t("parent.support.submitFeedback")}
          </Button>
        </form>

        <Button onClick={onBackFromFeedback} variant="quiet">
          {t("common.actions.cancel")}
        </Button>

        <p className="flex items-start gap-2 text-xs leading-5 text-muted">
          <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("parent.support.privacyNote")}
        </p>
      </div>
    </section>
  );
}

export function MobileHelpSupport(props: MobileHelpSupportProps) {
  const { t } = useI18n();

  if (props.showFeedbackEditor) {
    return <MobileFeedbackEditor {...props} />;
  }

  return (
    <section className="flex w-full flex-col gap-5 pb-2">
      <header className="flex flex-col gap-2">
        <span className="inline-flex w-fit items-center rounded-full bg-sky px-3 py-1 text-xs font-extrabold tracking-wide text-primary">
          {t("common.brand.name")}
        </span>
        <h1 className="book-title text-[26px] leading-tight text-ink">
          {t("parent.support.title")}
        </h1>
        <p className="text-sm leading-relaxed text-muted">
          {t("parent.support.description")}
        </p>
      </header>

      <section
        aria-labelledby="support-contact-heading"
        className="flex flex-col gap-3 rounded-3xl border border-border bg-gradient-to-br from-sky/60 via-cream to-white p-4"
      >
        <h2
          className="text-lg font-extrabold text-ink"
          id="support-contact-heading"
        >
          {t("parent.support.contactHeading")}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {t("parent.support.subtitle")}
        </p>
        <a
          className="inline-flex min-h-11 w-fit max-w-full items-center gap-2 rounded-control px-1 font-bold text-primary underline-offset-4 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
          href={"mailto:" + VIREAD_SUPPORT_EMAIL}
        >
          <span className="break-all">{VIREAD_SUPPORT_EMAIL}</span>
        </a>
        <Button onClick={props.onOpenFeedbackEditor} variant="primary">
          {t("parent.support.openFeedbackButton")}
        </Button>
      </section>

      <section
        aria-labelledby="support-faq-heading"
        className="flex flex-col gap-3"
      >
        <div>
          <h2
            className="text-lg font-extrabold text-ink"
            id="support-faq-heading"
          >
            {t("parent.support.faqHeading")}
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            {t("parent.support.faqSubtitle")}
          </p>
        </div>

        {props.faqStructure.map((group) => (
          <div
            className="flex flex-col gap-1 rounded-3xl border border-border bg-white p-4"
            key={group.key}
          >
            <h3 className="pb-1 text-base font-extrabold text-ink">
              {t(`parent.support.faq.${group.key}.title`)}
            </h3>
            <div className="divide-y divide-border/70">
              {group.items.map((itemKey) => (
                <details className="group py-1" key={itemKey}>
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-control py-2 text-start text-sm font-semibold text-ink outline-none marker:hidden hover:text-primary focus-visible:ring-2 focus-visible:ring-primary [&::-webkit-details-marker]:hidden">
                    <span>
                      {t(`parent.support.faq.${group.key}.q${itemKey}`)}
                    </span>
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-lg font-bold text-primary transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="pb-2.5 pt-1 text-sm leading-6 text-muted">
                    {t(`parent.support.faq.${group.key}.a${itemKey}`)}
                  </p>
                </details>
              ))}
            </div>
          </div>
        ))}
      </section>
    </section>
  );
}
