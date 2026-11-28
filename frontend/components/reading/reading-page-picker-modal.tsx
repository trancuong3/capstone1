"use client";

import { BookOpen } from "lucide-react";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useI18n, useTranslations } from "@/hooks/use-i18n";

export interface ReadingPagePickerPageItem {
  readonly page_id: string;
  readonly page_number: number;
}

export interface ReadingPagePickerModalProps {
  readonly pages: readonly ReadingPagePickerPageItem[];
  readonly pickerIndex: number;
  readonly isBusy: boolean;
  readonly pageNavigationError: string | null;
  readonly onSelectIndex: (index: number) => void;
  readonly onConfirm: (index: number) => void;
  readonly onClose: () => void;
}

export function ReadingPagePickerModal({
  pages,
  pickerIndex,
  isBusy,
  pageNavigationError,
  onSelectIndex,
  onConfirm,
  onClose,
}: ReadingPagePickerModalProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("reading");

  return (
    <Modal
      isOpen
      title={t("session.pagePickerTitle")}
      tone="paper"
      showCloseButton={false}
      closeOnEscape={!isBusy}
      onClose={onClose}
    >
      <div className="grid max-h-[45vh] grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-3">
        {pages.map((item, index) => (
          <button
            key={item.page_id}
            type="button"
            aria-pressed={pickerIndex === index}
            disabled={isBusy}
            onClick={() => onSelectIndex(index)}
            className="flex min-h-24 flex-col items-start justify-center gap-3 rounded-control border border-border bg-cream p-4 text-sm font-bold text-ink aria-pressed:border-primary aria-pressed:bg-sky"
          >
            <BookOpen aria-hidden="true" className="size-6 text-primary" />
            {t("progress.pageLabel", {
              page: formatNumber(item.page_number),
            })}
          </button>
        ))}
      </div>
      {pageNavigationError && (
        <StatusMessage className="mt-4" tone="error">
          {pageNavigationError}
        </StatusMessage>
      )}
      <Button
        className="mt-6"
        isLoading={isBusy}
        onClick={() => onConfirm(pickerIndex)}
      >
        {t("session.confirmThisPage")}
      </Button>
      <Button
        className="mt-2"
        variant="quiet"
        disabled={isBusy}
        onClick={onClose}
      >
        {t("session.cancel")}
      </Button>
    </Modal>
  );
}
