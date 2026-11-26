"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "@/hooks/use-i18n";
import {
  getVoiceEngineStatus,
  subscribeVoiceEngineStatus,
  type EngineSourceSnapshot,
  type VoiceEngineTier,
} from "@/lib/reading/voice-engine-status";

function getTierStyles(tier: VoiceEngineTier): {
  dot: string;
  chip: string;
} {
  switch (tier) {
    case "google_cloud":
      return {
        dot: "bg-amber-500",
        chip: "border-amber-200 bg-amber-50/90 text-amber-900",
      };
    case "browser_default":
      return {
        dot: "bg-orange-500",
        chip: "border-orange-200 bg-orange-50/90 text-orange-900",
      };
    case "android_native":
      return {
        dot: "bg-sky-500",
        chip: "border-sky-200 bg-sky-50/90 text-sky-900",
      };
    case "catalog_cache":
    case "browser_wasm":
    case "local_offline":
      return {
        dot: "bg-emerald-500",
        chip: "border-emerald-200 bg-emerald-50/90 text-emerald-900",
      };
    case "idle":
    default:
      return {
        dot: "bg-slate-400",
        chip: "border-slate-200 bg-slate-50/90 text-slate-700",
      };
  }
}

type SpeechTranslateFn = ReturnType<typeof useTranslations>;

function buildTooltip(
  kind: "STT" | "TTS",
  snap: EngineSourceSnapshot,
  t: SpeechTranslateFn,
): string {
  const base = `${kind}: ${snap.engineLabel}`;
  if (snap.fallbackReason) {
    return t("engineBadge.fallbackDetail", {
      base,
      reason: snap.fallbackReason,
    });
  }
  if (snap.tier === "idle") {
    return t("engineBadge.idleDetail", { base });
  }
  if (snap.tier === "android_native") {
    return t("engineBadge.androidDetail", { base });
  }
  if (snap.tier === "catalog_cache") {
    return t("engineBadge.catalogCacheDetail", { base });
  }
  if (snap.tier === "google_cloud") {
    return t("engineBadge.googleCloudDetail", { base });
  }
  if (snap.tier === "browser_default") {
    return t("engineBadge.browserDefaultDetail", { base });
  }
  if (snap.tier === "browser_wasm") {
    return t("engineBadge.wasmDetail", { base });
  }
  return t("engineBadge.localDetail", { base });
}

function resolveShortLabel(
  snap: EngineSourceSnapshot,
  t: SpeechTranslateFn,
): string {
  switch (snap.tier) {
    case "local_offline":
    case "browser_wasm":
    case "catalog_cache":
    case "android_native":
    case "google_cloud":
    case "browser_default":
    case "idle":
      return t(`engineBadge.shortLabels.${snap.tier}`);
    default:
      return snap.shortLabel;
  }
}

export interface VoiceEngineBadgeProps {
  compact?: boolean;
  className?: string;
}

export function VoiceEngineBadge({
  compact = false,
  className = "",
}: VoiceEngineBadgeProps) {
  const t = useTranslations("speech");
  const status = useSyncExternalStore(
    subscribeVoiceEngineStatus,
    getVoiceEngineStatus,
    getVoiceEngineStatus,
  );

  const sttStyles = getTierStyles(status.stt.tier);
  const ttsStyles = getTierStyles(status.tts.tier);

  return (
    <div
      data-testid="voice-engine-status-badge"
      data-stt-tier={status.stt.tier}
      data-tts-tier={status.tts.tier}
      className={`inline-flex flex-wrap items-center gap-1.5 ${className}`}
      aria-label={t("engineBadge.ariaLabel", {
        stt: status.stt.engineLabel,
        tts: status.tts.engineLabel,
      })}
    >
      <span
        data-testid="voice-engine-stt-chip"
        title={buildTooltip("STT", status.stt, t)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-tight ${sttStyles.chip}`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${sttStyles.dot}`}
          aria-hidden="true"
        />
        <span>
          STT:{" "}
          {compact ? resolveShortLabel(status.stt, t) : status.stt.engineLabel}
        </span>
      </span>

      <span
        data-testid="voice-engine-tts-chip"
        title={buildTooltip("TTS", status.tts, t)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-tight ${ttsStyles.chip}`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${ttsStyles.dot}`}
          aria-hidden="true"
        />
        <span>
          TTS:{" "}
          {compact ? resolveShortLabel(status.tts, t) : status.tts.engineLabel}
        </span>
      </span>
    </div>
  );
}
