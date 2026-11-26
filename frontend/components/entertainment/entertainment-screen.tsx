"use client";

import Image from "next/image";
import { ArrowRight, Music2 } from "lucide-react";

import { ButtonLink } from "@/components/common/button";
import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";
import { useTranslations } from "@/hooks/use-i18n";

export function EntertainmentScreen() {
  const t = useTranslations("entertainment");

  return (
    <section className="activity-library mx-auto flex w-full max-w-[1120px] flex-col gap-4">
      <header>
        <h1 className="book-title border-b border-border pb-5 text-4xl text-ink">
          {t("hub.heading")}
        </h1>
      </header>
      <div className="grid items-stretch gap-4 md:grid-cols-2">
        <article className="flex flex-col gap-4 rounded-card border border-border bg-white p-6 sm:p-8">
          <div
            aria-hidden="true"
            className="flex min-h-52 flex-col items-center justify-center gap-5 rounded-card bg-sky p-6"
          >
            <div
              className="viread-learning-content flex flex-wrap justify-center gap-2"
              dir="ltr"
              lang="vi"
            >
              {["Bé", "đang", "đọc", "sách."].map((word) => (
                <span
                  className="rounded-control bg-white px-4 py-2 text-xl font-extrabold text-ink"
                  key={word}
                >
                  {word}
                </span>
              ))}
            </div>
            <ToyCannon className="size-24" />
          </div>
          <h2 className="text-2xl font-extrabold text-ink">
            {t("hub.shooterTitle")}
          </h2>
          <p className="text-body leading-6 text-muted">
            {t("hub.shooterDesc")}
          </p>
          <ButtonLink
            href="/entertainment/sentence-shooter"
            size="compact"
            className="mt-auto"
          >
            {t("hub.shooterCta")}{" "}
            <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
          </ButtonLink>
        </article>
        <article className="flex flex-col gap-4 rounded-card border border-border bg-white p-6 sm:p-8">
          <div className="relative min-h-52 overflow-hidden rounded-card bg-cream">
            <Image
              alt={t("hub.pictureImageAlt")}
              className="object-cover"
              fill
              sizes="(max-width: 767px) 100vw, 480px"
              src="/images/picture-description/sunny-garden.jpg"
            />
          </div>
          <h2 className="text-2xl font-extrabold text-ink">
            {t("hub.pictureTitle")}
          </h2>
          <p className="text-body leading-6 text-muted">
            {t("hub.pictureDesc")}
          </p>
          <ButtonLink
            href="/entertainment/picture-description"
            size="compact"
            className="mt-auto"
          >
            {t("hub.pictureCta")}{" "}
            <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
          </ButtonLink>
        </article>
      </div>
      <article className="flex flex-col items-start gap-4 rounded-card border border-border bg-cream p-6 sm:flex-row sm:items-center sm:p-8">
        <div
          aria-hidden="true"
          className="grid size-16 shrink-0 place-items-center rounded-control bg-white text-primary"
        >
          <Music2 className="size-8" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-2xl font-extrabold text-ink">
            {t("hub.karaokeTitle")}
          </h2>
          <p className="mt-2 text-body text-muted">{t("hub.karaokeDesc")}</p>
        </div>
        <ButtonLink href="/karaoke" size="compact" className="w-full sm:w-auto">
          {t("hub.karaokeCta")}{" "}
          <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
        </ButtonLink>
      </article>
    </section>
  );
}
