"use client";

import { useContext, useEffect, useId, useState } from "react";

import { AppServicesContext } from "@/components/providers/app-services-provider";
import { useAutomationPreferences } from "@/hooks/use-automation-preferences";
import { announcePresenceOptIn } from "@/lib/reading/presence-opt-in";
import { cn } from "@/lib/utils/cn";

type EmailState =
  "loading" | "off" | "on" | "saving" | "error" | "camera-needed";

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
 * The three parent switches for the automatic reading flow. Each can be turned
 * off on its own. Assist and auto-advance are remembered on this device; the
 * email reminder is a per-parent setting stored on the server and is off until
 * a parent turns it on.
 */
export function ReadingAutomationSettings() {
  const services = useContext(AppServicesContext);
  const presence = services?.readingPresenceService;
  const { preferences, update } = useAutomationPreferences();
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
        Tự động khi đọc
      </h3>
      <Switch
        checked={preferences.assist}
        description="Tự nhắc nhẹ và đọc mẫu khi bé đọc chậm hoặc mắc kẹt."
        label="Hỗ trợ tự động"
        onChange={(assist) => update({ assist })}
      />
      <Switch
        checked={preferences.autoAdvance}
        description="Tự sang trang tiếp theo sau khi đã lưu kết quả trang."
        label="Tự chuyển trang"
        onChange={(autoAdvance) => update({ autoAdvance })}
      />
      {presence ? (
        <div className="space-y-1">
          <Switch
            checked={email === "on" || email === "saving"}
            description="Chỉ khi ViRead tạm dừng vì một lúc không thấy người đọc trong khung hình. ViRead chỉ đếm người trong khung ngay trên máy, không lưu hay gửi hình ảnh."
            disabled={email === "loading" || email === "saving"}
            label="Nhắc ba mẹ qua email"
            onChange={(next) => void changeEmail(next)}
          />
          {email === "camera-needed" ? (
            <p
              className="rounded-control bg-warning-surface px-3 py-2 text-sm font-medium text-ink"
              role="status"
            >
              Cần cho phép camera để dùng nhắc qua email. Chưa bật.
            </p>
          ) : null}
          {email === "error" ? (
            <p
              className="rounded-control bg-warning-surface px-3 py-2 text-sm font-medium text-ink"
              role="status"
            >
              Chưa lưu được cài đặt email. Ba mẹ thử lại nhé.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
