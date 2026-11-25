"use client";

import { useSyncExternalStore } from "react";
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
    case "local_offline":
    case "idle":
    default:
      return {
        dot: "bg-emerald-500",
        chip: "border-emerald-200 bg-emerald-50/90 text-emerald-900",
      };
  }
}

function buildTooltip(kind: "STT" | "TTS", snap: EngineSourceSnapshot): string {
  const base = `${kind}: ${snap.engineLabel}`;
  if (snap.fallbackReason) {
    return `${base} (Dự phòng: ${snap.fallbackReason})`;
  }
  if (snap.tier === "android_native") {
    return `${base} (Thiết bị · Giọng Android vi-VN)`;
  }
  if (snap.tier === "catalog_cache") {
    return `${base} (Cache chuẩn · Đọc mẫu 0 độ trễ)`;
  }
  if (snap.tier === "google_cloud") {
    return `${base} (Online · Đang dùng dự phòng Google Cloud API)`;
  }
  if (snap.tier === "browser_default") {
    return `${base} (Online · Dự phòng Google/Trình duyệt)`;
  }
  return `${base} (Offline · Chạy trực tiếp trên máy này)`;
}

export interface VoiceEngineBadgeProps {
  compact?: boolean;
  className?: string;
}

export function VoiceEngineBadge({
  compact = false,
  className = "",
}: VoiceEngineBadgeProps) {
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
      aria-label={`Nguồn giọng nói: STT ${status.stt.engineLabel}, TTS ${status.tts.engineLabel}`}
    >
      <span
        data-testid="voice-engine-stt-chip"
        title={buildTooltip("STT", status.stt)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-tight ${sttStyles.chip}`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${sttStyles.dot}`}
          aria-hidden="true"
        />
        <span>
          STT: {compact ? status.stt.shortLabel : status.stt.engineLabel}
        </span>
      </span>

      <span
        data-testid="voice-engine-tts-chip"
        title={buildTooltip("TTS", status.tts)}
        className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-tight ${ttsStyles.chip}`}
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${ttsStyles.dot}`}
          aria-hidden="true"
        />
        <span>
          TTS: {compact ? status.tts.shortLabel : status.tts.engineLabel}
        </span>
      </span>
    </div>
  );
}
