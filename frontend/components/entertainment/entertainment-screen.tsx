"use client";

import Image from "next/image";
import { ArrowRight, Music2 } from "lucide-react";

import { ButtonLink } from "@/components/common/button";
import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";
import { useTranslations } from "@/hooks/use-i18n";

export function EntertainmentScreen() {
  const t = useTranslations("entertainment");

  return (
    <section className="activity-library mx-auto flex w-full max-w-[1120px] flex-col gap-3.5 pb-2">
      <header className="border-b border-border pb-3">
        <h1 className="book-title text-2xl text-ink sm:text-[32px]">
          {t("hub.heading")}
        </h1>
      </header>
      <div className="grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <article className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 shadow-2xs transition-colors hover:border-primary/40">
          <div
            aria-hidden="true"
            className="flex h-36 flex-col items-center justify-center gap-2.5 rounded-control bg-[#e0f4f8] p-3.5"
          >
            <div
              className="viread-learning-content flex flex-wrap justify-center gap-1.5"
              dir="ltr"
              lang="vi"
            >
              {["Bé", "đang", "đọc", "sách."].map((word) => (
                <span
                  className="rounded-control bg-white px-2.5 py-0.5 text-sm font-extrabold text-ink shadow-2xs"
                  key={word}
                >
                  {word}
                </span>
              ))}
            </div>
            <ToyCannon className="size-14" />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <h2 className="text-lg font-extrabold leading-snug text-ink">
              {t("hub.shooterTitle")}
            </h2>
            <p className="text-sm leading-relaxed text-muted">
              {t("hub.shooterDesc")}
            </p>
          </div>
          <ButtonLink
            href="/entertainment/sentence-shooter"
            size="compact"
            className="mt-auto min-h-11! py-2!"
          >
            {t("hub.shooterCta")}{" "}
            <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
          </ButtonLink>
        </article>

        <article className="flex flex-col gap-3 rounded-card border border-border bg-white p-4 shadow-2xs transition-colors hover:border-primary/40">
          <div className="relative h-36 overflow-hidden rounded-control bg-cream">
            <Image
              alt={t("hub.pictureImageAlt")}
              className="object-cover"
              fill
              loading="eager"
              sizes="(max-width: 767px) 100vw, 360px"
              src="/images/picture-description/sunny-garden.jpg"
            />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <h2 className="text-lg font-extrabold leading-snug text-ink">
              {t("hub.pictureTitle")}
            </h2>
            <p className="text-sm leading-relaxed text-muted">
              {t("hub.pictureDesc")}
            </p>
          </div>
          <ButtonLink
            href="/entertainment/picture-description"
            size="compact"
            className="mt-auto min-h-11! py-2!"
          >
            {t("hub.pictureCta")}{" "}
            <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
          </ButtonLink>
        </article>

        <article className="flex flex-col gap-3 rounded-card border border-[#e5cc83] bg-cream p-4 shadow-2xs transition-colors hover:border-primary/40 sm:col-span-2 lg:col-span-1">
          <div
            aria-hidden="true"
            className="flex h-36 flex-col items-center justify-center gap-2.5 rounded-control bg-[#fff0be] p-3.5"
          >
            <div className="grid size-14 place-items-center rounded-2xl bg-white text-primary shadow-sm">
              <Music2 className="size-7" />
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-6 rounded-full bg-primary/25" />
              <span className="h-2 w-10 rounded-full bg-primary/50" />
              <span className="h-2 w-6 rounded-full bg-primary/25" />
            </div>
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <h2 className="text-lg font-extrabold leading-snug text-ink">
              {t("hub.karaokeTitle")}
            </h2>
            <p className="text-sm leading-relaxed text-muted">
              {t("hub.karaokeDesc")}
            </p>
          </div>
          <ButtonLink
            href="/karaoke"
            size="compact"
            className="mt-auto min-h-11! py-2!"
          >
            {t("hub.karaokeCta")}{" "}
            <ArrowRight aria-hidden="true" className="viread-rtl-flip size-4" />
          </ButtonLink>
        </article>
      </div>
    </section>
  );
}
