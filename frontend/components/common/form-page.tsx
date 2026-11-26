"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { useTranslations } from "@/hooks/use-i18n";

/** A separate editor view, matching Figma's detailed-action screens. */
export function FormPage({
  title,
  description,
  children,
  onBack,
  width = "wide",
  panelTitle,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onBack: () => void;
  width?: "wide" | "standard";
  panelTitle?: string;
}) {
  const tCommon = useTranslations("common");
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    window.scrollTo?.({ top: 0, behavior: "instant" });
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      className={`figma-form-page mx-auto flex w-full flex-col gap-4 ${width === "standard" ? "max-w-[960px]" : "max-w-[1120px]"}`}
    >
      <Button className="sm:max-w-60" variant="quiet" onClick={onBack}>
        <ArrowLeft aria-hidden="true" className="size-4 viread-rtl-flip" />
        {tCommon("actions.back")}
      </Button>
      <h1
        ref={heading}
        tabIndex={-1}
        className="text-heading font-extrabold text-ink outline-none"
      >
        {title}
      </h1>
      {description ? (
        <p className="text-body text-muted">{description}</p>
      ) : null}
      <Card className="gap-4 sm:px-8 sm:py-6">
        {panelTitle ? (
          <h2 className="text-2xl font-extrabold text-ink">{panelTitle}</h2>
        ) : null}
        {children}
        <Button className="sm:max-w-60" variant="quiet" onClick={onBack}>
          {tCommon("actions.cancel")}
        </Button>
      </Card>
    </section>
  );
}
