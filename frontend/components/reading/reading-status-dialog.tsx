import Image from "next/image";
import type { ReactNode } from "react";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";

interface DialogAction {
  disabled?: boolean;
  isLoading?: boolean;
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary" | "quiet";
}

interface ReadingStatusDialogProps {
  body: ReactNode;
  closeOnEscape?: boolean;
  onClose: () => void;
  primaryAction: DialogAction;
  secondaryAction?: DialogAction;
  title: string;
}

export function ReadingStatusDialog({
  body,
  closeOnEscape = false,
  onClose,
  primaryAction,
  secondaryAction,
  title,
}: ReadingStatusDialogProps) {
  return (
    <Modal
      closeOnEscape={closeOnEscape}
      isOpen
      onClose={onClose}
      showCloseButton={false}
      title={title}
    >
      <Image
        alt=""
        aria-hidden="true"
        className="mx-auto -mt-3 mb-4"
        height={72}
        src="/images/figma/owl-mascot.svg"
        width={72}
      />
      <div className="text-body text-muted">{body}</div>
      <div className="mt-6 flex flex-col gap-3">
        <Button
          disabled={primaryAction.disabled}
          isLoading={primaryAction.isLoading}
          onClick={primaryAction.onClick}
          variant={primaryAction.variant}
        >
          {primaryAction.label}
        </Button>
        {secondaryAction ? (
          <Button
            disabled={secondaryAction.disabled}
            isLoading={secondaryAction.isLoading}
            onClick={secondaryAction.onClick}
            variant={secondaryAction.variant ?? "quiet"}
          >
            {secondaryAction.label}
          </Button>
        ) : null}
      </div>
    </Modal>
  );
}
