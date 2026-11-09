"use client";

import { Check, RefreshCw, SlidersHorizontal, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { useSpeechPreferences } from "@/hooks/use-speech-preferences";
import {
  createVoiceStudioService,
  type VoiceList,
  type VoiceOption,
} from "@/lib/api/voice-studio-service";
import {
  clampSpeed,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
} from "@/lib/reading/speech-preferences";
import { cn } from "@/lib/utils/cn";

const PREVIEW_TEXT = "Chào bé, mình cùng đọc sách nhé!";
const SPEED_PRESETS = [
  { label: "Chậm", value: 0.8 },
  { label: "Vừa", value: 0.9 },
  { label: "Nhanh", value: 1.1 },
] as const;
const GENDER_LABELS: Record<string, string> = { female: "Nữ", male: "Nam" };

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: VoiceList }
  | { status: "error" };

interface ReadingVoiceSettingsProps {
  disabled?: boolean;
  isPreviewing?: boolean;
  /** Speaks a short sample with the currently chosen voice and speed. */
  onPreview: (sample: string) => void;
  onStopPreview: () => void;
}

function voiceTitle(voice: VoiceOption): string {
  return voice.name.split(" - ")[0] ?? voice.name;
}

function voiceDetails(voice: VoiceOption): string {
  return [
    voice.gender ? (GENDER_LABELS[voice.gender] ?? voice.gender) : null,
    voice.accent,
    voice.age ? voice.age.replace("_", " ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatSpeed(speed: number): string {
  return `${speed.toFixed(2).replace(".", ",")}×`;
}

export function ReadingVoiceSettings({
  disabled = false,
  isPreviewing = false,
  onPreview,
  onStopPreview,
}: ReadingVoiceSettingsProps) {
  const voiceStudio = useMemo(() => createVoiceStudioService(), []);
  const { preferences, update } = useSpeechPreferences();
  const [isOpen, setIsOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadVoices = useCallback(() => {
    setLoadState({ status: "loading" });
    voiceStudio
      .listVoices()
      .then((data) => {
        if (mountedRef.current) setLoadState({ status: "ready", data });
      })
      .catch(() => {
        if (mountedRef.current) setLoadState({ status: "error" });
      });
  }, [voiceStudio]);

  function open() {
    setIsOpen(true);
    if (loadState.status === "idle" || loadState.status === "error") {
      loadVoices();
    }
  }

  function close() {
    onStopPreview();
    setIsOpen(false);
  }

  const defaultVoiceId =
    loadState.status === "ready" ? loadState.data.default_voice_id : null;
  const selectedVoiceId = preferences.voiceId ?? defaultVoiceId;

  return (
    <>
      <Button
        aria-haspopup="dialog"
        className="h-[68px] min-w-0 flex-col gap-0 px-1 text-label sm:h-16 sm:flex-row sm:gap-2 sm:px-3 sm:text-button"
        disabled={disabled}
        onClick={open}
        variant="quiet"
      >
        <SlidersHorizontal aria-hidden="true" className="size-6 shrink-0" />
        <span className="truncate">Giọng đọc</span>
      </Button>

      <Modal isOpen={isOpen} onClose={close} title="Giọng đọc mẫu">
        <div className="space-y-5">
          <section aria-labelledby="voice-speed-heading" className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <h3
                className="text-label font-extrabold text-ink"
                id="voice-speed-heading"
              >
                Tốc độ đọc
              </h3>
              <output
                aria-live="polite"
                className="text-label font-extrabold text-primary"
              >
                {formatSpeed(preferences.speed)}
              </output>
            </div>
            <input
              aria-labelledby="voice-speed-heading"
              aria-valuetext={formatSpeed(preferences.speed)}
              className="w-full accent-primary"
              max={SPEED_MAX}
              min={SPEED_MIN}
              onChange={(event) =>
                update({ speed: clampSpeed(Number(event.target.value)) })
              }
              step={SPEED_STEP}
              type="range"
              value={preferences.speed}
            />
            <div className="flex flex-wrap gap-2">
              {SPEED_PRESETS.map((preset) => {
                const active =
                  Math.abs(preferences.speed - preset.value) < 0.001;
                return (
                  <button
                    aria-pressed={active}
                    className={cn(
                      "rounded-control border-2 px-3 py-1.5 text-label font-bold transition",
                      active
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-white text-ink hover:border-primary hover:bg-cream",
                    )}
                    key={preset.label}
                    onClick={() => update({ speed: preset.value })}
                    type="button"
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </section>

          <section aria-labelledby="voice-choice-heading" className="space-y-3">
            <h3
              className="text-label font-extrabold text-ink"
              id="voice-choice-heading"
            >
              Chọn giọng đọc
            </h3>

            {loadState.status === "loading" || loadState.status === "idle" ? (
              <p className="text-body text-muted">Đang tải danh sách giọng…</p>
            ) : loadState.status === "error" ? (
              <div className="space-y-2">
                <p className="text-body text-muted">
                  Chưa tải được danh sách giọng. Giọng mặc định vẫn dùng được.
                </p>
                <Button onClick={loadVoices} variant="secondary">
                  <RefreshCw aria-hidden="true" className="size-4" />
                  Thử lại
                </Button>
              </div>
            ) : (
              <div
                aria-labelledby="voice-choice-heading"
                className="max-h-64 space-y-2 overflow-y-auto pr-1"
                role="radiogroup"
              >
                {loadState.data.voices.map((voice) => {
                  const selected = voice.voice_id === selectedVoiceId;
                  return (
                    <button
                      aria-checked={selected}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-card border-2 p-3 text-left transition",
                        selected
                          ? "border-primary bg-cream font-extrabold"
                          : "border-border bg-white font-bold hover:border-primary hover:bg-cream",
                      )}
                      key={voice.voice_id}
                      onClick={() =>
                        update({
                          voiceId:
                            voice.voice_id === defaultVoiceId
                              ? null
                              : voice.voice_id,
                        })
                      }
                      role="radio"
                      type="button"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body text-ink">
                          {voiceTitle(voice)}
                        </span>
                        {voiceDetails(voice) ? (
                          <span className="block truncate text-label font-medium text-muted">
                            {voiceDetails(voice)}
                          </span>
                        ) : null}
                      </span>
                      {selected ? (
                        <Check
                          aria-hidden="true"
                          className="size-5 shrink-0 text-primary"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <Button
            className="w-full"
            onClick={() =>
              isPreviewing ? onStopPreview() : onPreview(PREVIEW_TEXT)
            }
            variant="secondary"
          >
            <Volume2 aria-hidden="true" className="size-5" />
            {isPreviewing ? "Dừng nghe thử" : "Nghe thử"}
          </Button>
        </div>
      </Modal>
    </>
  );
}
