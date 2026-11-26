"use client";

import { useContext, useEffect, useId, useState } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import { useAutomationPreferences } from "@/hooks/use-automation-preferences";
import { useTranslations } from "@/hooks/use-i18n";
import { announcePresenceOptIn } from "@/lib/reading/presence-opt-in";
import type { CoachingStyle } from "@/lib/reading/automation-preferences";
import { cn } from "@/lib/utils/cn";

type EmailState =
  "loading" | "off" | "on" | "saving" | "error" | "camera-needed";

const COACHING_STYLE_OPTIONS: readonly {
  readonly value: CoachingStyle;
  readonly labelKey: string;
  readonly hintKey: string;
}[] = [
  {
    value: "gentle",
    labelKey: "automation.gentleLabel",
    hintKey: "automation.gentleHint",
  },
  {
    value: "concise",
    labelKey: "automation.conciseLabel",
    hintKey: "automation.conciseHint",
  },
];

/** Ask for the camera once, at the parent's explicit request, then release it. */
async function confirmCameraAccess(): Promise<boolean> {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

function Switch({
  checked,
  description,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input
        aria-checked={checked}
        aria-describedby={`${id}-description`}
        checked={checked}
        className="mt-1 size-5 shrink-0 accent-primary"
        disabled={disabled}
        id={id}
        onChange={(event) => onChange(event.target.checked)}
        role="switch"
        type="checkbox"
      />
      <label className="min-w-0 flex-1" htmlFor={id}>
        <span className="block text-sm font-bold text-ink">{label}</span>
        <span
          className={cn("block text-sm text-muted")}
          id={`${id}-description`}
        >
          {description}
        </span>
      </label>
    </div>
  );
}

/**
 * The three parent switches for the automatic reading flow plus the teacher
 * coaching style selector (G14, G28).
 */
export function ReadingAutomationSettings() {
  const t = useTranslations("reading");
  const services = useContext(AppServicesContext);
  const presence = services?.readingPresenceService;
  const { preferences, update, coachingStyle, updateCoachingStyle } =
    useAutomationPreferences();
  const [email, setEmail] = useState<EmailState>(presence ? "loading" : "off");

  useEffect(() => {
    if (!presence) return;
    let active = true;
    presence
      .getSettings()
      .then((settings) => {
        if (active) setEmail(settings.emailEnabled ? "on" : "off");
      })
      .catch(() => {
        if (active) setEmail("error");
      });
    return () => {
      active = false;
    };
  }, [presence]);

  async function changeEmail(next: boolean) {
    if (!presence) return;
    setEmail("saving");
    try {
      if (next && !(await confirmCameraAccess())) {
        setEmail("camera-needed");
        return;
      }
      const saved = await presence.setEmailEnabled(next);
      announcePresenceOptIn(saved.emailEnabled);
      setEmail(saved.emailEnabled ? "on" : "off");
    } catch {
      setEmail("error");
    }
  }

  return (
    <section
      aria-labelledby="automation-settings-heading"
      className="space-y-3"
    >
      <h3
        className="text-label font-semibold text-ink"
        id="automation-settings-heading"
      >
        {t("automation.sectionTitle")}
      </h3>
      <Switch
        checked={preferences.assist}
        description={t("automation.autoHelpDesc")}
        label={t("automation.autoHelpLabel")}
        onChange={(assist) => update({ assist })}
      />
      <div
        aria-label={t("automation.styleGroupAria")}
        className="ms-8 space-y-1.5"
        role="group"
      >
        <span className="block text-xs font-semibold text-muted">
          {t("automation.styleTitle")}
        </span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {COACHING_STYLE_OPTIONS.map((option) => {
            const selected = coachingStyle === option.value;
            return (
              <button
                aria-pressed={selected}
                className={cn(
                  "flex min-h-11 flex-col items-start rounded-control border px-3 py-2 text-start transition-colors",
                  selected
                    ? "border-primary bg-sky text-ink"
                    : "border-border bg-white text-ink hover:bg-canvas",
                  !preferences.assist && "opacity-60",
                )}
                disabled={!preferences.assist}
                key={option.value}
                onClick={() => updateCoachingStyle(option.value)}
                type="button"
              >
                <span className="text-xs font-bold">{t(option.labelKey)}</span>
                <span className="mt-0.5 text-xs text-muted">
                  {t(option.hintKey)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <Switch
        checked={preferences.autoAdvance}
        description={t("automation.autoAdvanceDesc")}
        label={t("automation.autoAdvanceLabel")}
        onChange={(autoAdvance) => update({ autoAdvance })}
      />
      {presence ? (
        <div className="space-y-1">
          <Switch
            checked={email === "on" || email === "saving"}
            description={t("automation.presenceAlertDesc")}
            disabled={email === "loading" || email === "saving"}
            label={t("automation.presenceAlertLabel")}
            onChange={(next) => void changeEmail(next)}
          />
          {email === "camera-needed" ? (
            <p
              className="rounded-control bg-warning-surface px-3 py-2 text-sm font-medium text-ink"
              role="status"
            >
              {t("automation.cameraRequiredNotice")}
            </p>
          ) : null}
          {email === "error" ? (
            <p
              className="rounded-control bg-warning-surface px-3 py-2 text-sm font-medium text-ink"
              role="status"
            >
              {t("automation.saveEmailError")}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
