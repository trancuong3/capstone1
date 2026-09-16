import { Check, X } from "lucide-react";
import Image from "next/image";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { cn } from "@/lib/utils/cn";
import type { BookPagePreviewDTO } from "@/types/book";

interface ManualPageSelectorProps {
  error?: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onSelect: (pageId: string) => void;
  pages: readonly BookPagePreviewDTO[];
  selectedPageId: string | null;
}

export function ManualPageSelector({
  error = false,
  isSaving,
  onCancel,
  onConfirm,
  onSelect,
  pages,
  selectedPageId,
}: ManualPageSelectorProps) {
  return (
    <Modal
      closeOnEscape
      isOpen
      onClose={onCancel}
      showCloseButton={false}
      title="Bé đang đọc trang nào?"
    >
      {error ? (
        <StatusMessage title="Chưa tải được các trang sách" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>
      ) : pages.length === 0 ? (
        <StatusMessage title="Chưa có trang phù hợp" tone="warning">
          Cuốn sách này chưa có trang ACTIVE và VERIFIED để lựa chọn.
        </StatusMessage>
      ) : (
        <div
          aria-label="Các trang cùng cuốn sách có thể chọn"
          className="grid gap-4 sm:grid-cols-3"
        >
          {pages.map((page) => {
            const isSelected = selectedPageId === page.page_id;
            return (
              <button
                aria-label={`Chọn trang ${page.page_number}`}
                aria-pressed={isSelected}
                className={cn(
                  "flex min-h-44 flex-col gap-3 rounded-card border bg-white p-3 text-left text-body font-bold text-ink focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary",
                  isSelected
                    ? "border-primary ring-2 ring-primary"
                    : "border-border",
                )}
                key={page.page_id}
                onClick={() => onSelect(page.page_id)}
                type="button"
              >
                <span className="relative block h-28 w-full overflow-hidden rounded-control bg-cream">
                  <Image
                    alt=""
                    aria-hidden="true"
                    className="object-cover"
                    fill
                    sizes="(max-width: 767px) 100vw, 180px"
                    src={page.preview_url}
                  />
                </span>
                <span>Trang {page.page_number}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button
          disabled={!selectedPageId || pages.length === 0 || error}
          isLoading={isSaving}
          onClick={onConfirm}
        >
          <Check aria-hidden="true" className="size-5" />
          Đúng trang này
        </Button>
        <Button onClick={onCancel} variant="quiet">
          <X aria-hidden="true" className="size-5" />
          Hủy
        </Button>
      </div>
    </Modal>
  );
}
