"use client";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { useTranslations } from "@/hooks/use-i18n";

export interface KaraokeConfirmRequest {
  readonly cancelLabel?: string;
  readonly confirmLabel: string;
  readonly description: string;
  readonly onConfirm: () => void;
  readonly title: string;
  readonly variant?: "primary" | "destructive";
}

export function KaraokeConfirmModal({
  busy = false,
  onClose,
  request,
}: {
  readonly busy?: boolean;
  readonly onClose: () => void;
  readonly request: KaraokeConfirmRequest | null;
}) {
  const t = useTranslations("admin");

  function handleConfirm() {
    if (!request || busy) return;
    const action = request.onConfirm;
    onClose();
    action();
  }

  return (
    <Modal
      closeOnBackdropClick={!busy}
      closeOnEscape={!busy}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            disabled={busy}
            fullWidth={false}
            onClick={onClose}
            size="admin"
            type="button"
            variant="outline"
          >
            {request?.cancelLabel ?? t("common.cancel")}
          </Button>
          <Button
            disabled={busy}
            fullWidth={false}
            isLoading={busy}
            onClick={handleConfirm}
            size="admin"
            type="button"
            variant={request?.variant ?? "primary"}
          >
            {request?.confirmLabel ?? t("common.confirm")}
          </Button>
        </div>
      }
      isOpen={request !== null}
      onClose={() => {
        if (!busy) onClose();
      }}
      role="alertdialog"
      showCloseButton={!busy}
      title={request?.title ?? t("common.confirm")}
      tone="paper"
    >
      <p className="text-sm leading-relaxed text-ink">{request?.description}</p>
    </Modal>
  );
}
