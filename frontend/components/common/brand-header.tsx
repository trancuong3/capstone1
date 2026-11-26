"use client";

import { ViReadLogo } from "@/components/common/viread-logo";
import { useTranslations } from "@/hooks/use-i18n";

export function BrandHeader() {
  const tAuth = useTranslations("auth");

  return (
    <header className="flex min-h-11 w-full max-w-[1376px] items-center sm:h-16">
      <ViReadLogo
        ariaLabel={tAuth("brandHeaderAria")}
        href="/login"
        size="sm"
      />
    </header>
  );
}
