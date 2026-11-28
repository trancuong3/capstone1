"use client";

import { Lock, ShieldCheck, Unlock } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useTranslations } from "@/hooks/use-i18n";
import { createFamilyPedagogyService } from "@/lib/api/family-pedagogy-service";

export type ParentPinModalMode = "setup" | "unlock" | "manage";

interface ParentPinModalProps {
  readonly isOpen: boolean;
  readonly mode: ParentPinModalMode;
  readonly hasExistingPin?: boolean;
  readonly onClose: () => void;
  readonly onPinConfigured?: (childModeDefault: boolean) => void;
  readonly onPinVerified?: () => void;
  readonly onPinRemoved?: () => void;
}

function ParentPinForm({
  mode,
  hasExistingPin = false,
  onClose,
  onPinConfigured,
  onPinVerified,
  onPinRemoved,
}: Omit<ParentPinModalProps, "isOpen">) {
  const t = useTranslations("parent");
  const tCommon = useTranslations("common");
  const service = useMemo(() => createFamilyPedagogyService(), []);

  const [pin, setPin] = useState("");
  const [currentPin, setCurrentPin] = useState("");
  const [childModeDefault, setChildModeDefault] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const submitProgress = useAiProgress({
    active: isSubmitting,
    expectedDurationMs: 2_200,
    resetKey: mode,
  });

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMsg(null);

    if (!/^\d{4}$/.test(pin)) {
      setErrorMsg(t("childModePin.invalidFormat"));
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === "unlock") {
        const res = await service.verifyPin(pin);
        if (res.verified) {
          onPinVerified?.();
        } else {
          setErrorMsg(
            t("childModePin.wrongPinRemaining", {
              remaining: res.remaining_attempts,
            }),
          );
        }
        return;
      }

      if (hasExistingPin && !/^\d{4}$/.test(currentPin)) {
        setErrorMsg(t("childModePin.currentPinRequired"));
        return;
      }
      const saved = await service.upsertPin({
        pin,
        current_pin: hasExistingPin ? currentPin : undefined,
        child_mode_default: childModeDefault,
      });
      onPinConfigured?.(saved.child_mode_default);
    } catch {
      setErrorMsg(t("childModePin.requestFailed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRemovePin = async () => {
    if (!/^\d{4}$/.test(currentPin)) {
      setErrorMsg(t("childModePin.currentPinRequired"));
      return;
    }
    setIsSubmitting(true);
    setErrorMsg(null);
    try {
      await service.deletePin(currentPin);
      onPinRemoved?.();
    } catch {
      setErrorMsg(t("childModePin.requestFailed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
      <p className="text-sm text-muted">
        {mode === "unlock"
          ? t("childModePin.unlockDesc")
          : t("childModePin.setupDesc")}
      </p>

      {isSubmitting ? (
        <AiProgressBar
          active
          label={tCommon("aiProgress.processing")}
          percent={submitProgress.percent}
          size="compact"
          testId="parent-pin-submit-progress"
        />
      ) : null}

      {mode !== "unlock" && hasExistingPin ? (
        <label className="block space-y-1.5">
          <span className="text-xs font-bold text-ink">
            {t("childModePin.currentPinLabel")}
          </span>
          <input
            autoComplete="off"
            className="w-full rounded-control border border-border bg-white px-3.5 py-2.5 text-center text-xl font-extrabold tracking-[0.4em] text-ink focus:border-primary focus:outline-none"
            data-testid="parent-current-pin-input"
            inputMode="numeric"
            maxLength={4}
            onChange={(e) =>
              setCurrentPin(e.target.value.replace(/\D+/g, "").slice(0, 4))
            }
            pattern="\d{4}"
            placeholder="••••"
            type="password"
            value={currentPin}
          />
        </label>
      ) : null}

      <label className="block space-y-1.5">
        <span className="text-xs font-bold text-ink">
          {mode === "unlock"
            ? t("childModePin.enterPinLabel")
            : t("childModePin.newPinLabel")}
        </span>
        <input
          autoComplete="off"
          autoFocus
          className="w-full rounded-control border border-border bg-white px-3.5 py-2.5 text-center text-2xl font-extrabold tracking-[0.45em] text-ink focus:border-primary focus:outline-none"
          data-testid="parent-pin-input"
          inputMode="numeric"
          maxLength={4}
          onChange={(e) =>
            setPin(e.target.value.replace(/\D+/g, "").slice(0, 4))
          }
          pattern="\d{4}"
          placeholder="••••"
          type="password"
          value={pin}
        />
      </label>

      {mode !== "unlock" ? (
        <label className="flex items-center gap-2.5 rounded-control border border-border bg-white/85 px-3 py-2 text-xs font-semibold text-ink">
          <input
            checked={childModeDefault}
            className="size-4 accent-primary"
            onChange={(e) => setChildModeDefault(e.target.checked)}
            type="checkbox"
          />
          <span>{t("childModePin.autoEnableCheckbox")}</span>
        </label>
      ) : null}

      {errorMsg ? (
        <p
          className="rounded-control bg-danger-surface px-3 py-2 text-xs font-bold text-danger"
          data-testid="parent-pin-error"
          role="alert"
        >
          {errorMsg}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {mode !== "unlock" && hasExistingPin ? (
          <Button
            disabled={isSubmitting}
            onClick={() => void handleRemovePin()}
            size="compact"
            type="button"
            variant="quiet"
          >
            {t("childModePin.removePinButton")}
          </Button>
        ) : null}
        <Button
          disabled={isSubmitting}
          onClick={onClose}
          size="compact"
          type="button"
          variant="secondary"
        >
          {t("childModePin.cancelButton")}
        </Button>
        <Button
          data-testid="parent-pin-confirm-button"
          disabled={isSubmitting || pin.length !== 4}
          size="compact"
          type="submit"
          variant="primary"
        >
          {mode === "unlock" ? (
            <>
              <Unlock aria-hidden="true" className="size-4" />
              {t("childModePin.unlockButton")}
            </>
          ) : (
            <>
              {hasExistingPin ? (
                <ShieldCheck aria-hidden="true" className="size-4" />
              ) : (
                <Lock aria-hidden="true" className="size-4" />
              )}
              {t("childModePin.saveAndLockButton")}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

export function ParentPinModal({
  isOpen,
  mode,
  hasExistingPin = false,
  onClose,
  onPinConfigured,
  onPinVerified,
  onPinRemoved,
}: ParentPinModalProps) {
  const t = useTranslations("parent");
  const title =
    mode === "unlock"
      ? t("childModePin.unlockTitle")
      : hasExistingPin
        ? t("childModePin.manageTitle")
        : t("childModePin.setupTitle");

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} tone="cream">
      {isOpen ? (
        <ParentPinForm
          hasExistingPin={hasExistingPin}
          key={`${mode}:${hasExistingPin ? "existing" : "new"}`}
          mode={mode}
          onClose={onClose}
          onPinConfigured={onPinConfigured}
          onPinRemoved={onPinRemoved}
          onPinVerified={onPinVerified}
        />
      ) : null}
    </Modal>
  );
}
