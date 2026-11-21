"use client";

import { RefreshCw, SlidersHorizontal, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { ReadingAutomationSettings } from "@/components/reading/reading-automation-settings";
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
  getSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import { cn } from "@/lib/utils/cn";

const PREVIEW_TEXT = "Chào bé, mình cùng đọc sách nhé.";
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
  fallbackNotice?: string | null;
  /** Speaks a short sample with the currently chosen voice and speed. */
  onPreview: (sample: string) => void | Promise<void>;
  onStopPreview: () => void;
}

function voiceTitle(voice: VoiceOption): string {
  return voice.name.split(" - ")[0] ?? voice.name;
}

function voiceDetails(voice: VoiceOption): string {
  const ages: Record<string, string> = {
    young: "Trẻ trung",
    young_adult: "Trẻ trung",
    youthful: "Trẻ trung",
    child: "Giọng trẻ em",
    middle_aged: "Trung niên",
    old: "Lớn tuổi",
  };
  return [
    voice.gender ? (GENDER_LABELS[voice.gender] ?? voice.gender) : null,
    voice.accent
      ? ((
          {
            northern: "Giọng Bắc",
            southern: "Giọng Nam",
            central: "Giọng Trung",
            american: "Giọng Mỹ",
            british: "Giọng Anh",
          } as Record<string, string>
        )[voice.accent.toLowerCase()] ?? voice.accent)
      : null,
    voice.age
      ? (ages[voice.age.toLowerCase()] ?? voice.age.replaceAll("_", " "))
      : null,
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
  fallbackNotice = null,
  onPreview,
  onStopPreview,
}: ReadingVoiceSettingsProps) {
  const voiceStudio = useMemo(() => createVoiceStudioService(), []);
  const { preferences, update } = useSpeechPreferences();
  const [isOpen, setIsOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [filter, setFilter] = useState("all");
  const [previewError, setPreviewError] = useState(false);
  const mountedRef = useRef(true);
  const previewGenerationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadControllerRef.current?.abort();
    };
  }, []);

  const loadVoices = useCallback(() => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    setLoadState({ status: "loading" });
    voiceStudio
      .listVoices(controller.signal)
      .then((data) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        const storedVoice = getSpeechPreferences().voiceId;
        if (
          storedVoice &&
          !data.voices.some((voice) => voice.voice_id === storedVoice)
        )
          update({ voiceId: null });
        setLoadState({ status: "ready", data });
      })
      .catch(() => {
        if (mountedRef.current && !controller.signal.aborted)
          setLoadState({ status: "error" });
      });
  }, [voiceStudio, update]);

  function change(value: Parameters<typeof update>[0]) {
    previewGenerationRef.current += 1;
    onStopPreview();
    setPreviewError(false);
    update(value);
  }

  function open() {
    setIsOpen(true);
    if (loadState.status === "idle" || loadState.status === "error") {
      loadVoices();
    }
  }

  function close() {
    previewGenerationRef.current += 1;
    setPreviewError(false);
    onStopPreview();
    loadControllerRef.current?.abort();
    if (loadState.status === "loading") setLoadState({ status: "idle" });
    setIsOpen(false);
  }

  const defaultVoiceId =
    loadState.status === "ready" ? loadState.data.default_voice_id : null;
  const selectedVoiceId = preferences.voiceId ?? defaultVoiceId;
  const isYouthful = (voice: VoiceOption) =>
    ["young", "young_adult", "youthful"].includes(
      voice.age?.toLowerCase() ?? "",
    );
  const matchesFilter = (voice: VoiceOption) =>
    filter === "all" ||
    (filter === "young"
      ? isYouthful(voice)
      : voice.gender?.toLowerCase() === filter);

  const selectedVoice =
    loadState.status === "ready"
      ? loadState.data.voices.find(
          (voice) => voice.voice_id === selectedVoiceId,
        )
      : undefined;
  const filteredVoices =
    loadState.status === "ready"
      ? loadState.data.voices.filter(matchesFilter)
      : [];
  return (
    <>
      <Button
        aria-haspopup="dialog"
        className="min-h-14 min-w-0 gap-2 px-3 text-base"
        disabled={disabled}
        onClick={open}
        variant="quiet"
      >
        <SlidersHorizontal aria-hidden="true" className="size-6 shrink-0" />
        <span className="max-w-full text-center whitespace-normal break-words">
          Giọng đọc
        </span>
      </Button>

      <Modal isOpen={isOpen} onClose={close} title="Giọng đọc mẫu">
        <div className="space-y-4">
          <div
            className="rounded-control bg-sky px-3 py-2 text-sm font-semibold text-primary"
            aria-live="polite"
          >
            {selectedVoice
              ? voiceTitle(selectedVoice)
              : preferences.voiceId
                ? "Giọng đã lưu"
                : "Giọng mặc định"}{" "}
            · {formatSpeed(preferences.speed)}
          </div>
          <section aria-labelledby="voice-speed-heading" className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <h3
                className="text-label font-semibold text-ink"
                id="voice-speed-heading"
              >
                Tốc độ đọc
              </h3>
              <output
                aria-live="polite"
                className="text-label font-semibold text-primary"
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
                change({ speed: clampSpeed(Number(event.target.value)) })
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
                      "rounded-control border-2 px-3 py-1.5 text-label font-semibold transition",
                      active
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-white text-ink hover:border-primary hover:bg-cream",
                    )}
                    key={preset.label}
                    onClick={() => change({ speed: preset.value })}
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
              className="text-label font-semibold text-ink"
              id="voice-choice-heading"
            >
              Chọn giọng đọc
            </h3>
            {loadState.status === "ready" &&
            loadState.data.voices.length > 0 ? (
              <select
                aria-label="Lọc giọng đọc"
                className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-body"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">Tất cả giọng đọc</option>
                {loadState.data.voices.some(
                  (voice) => voice.gender?.toLowerCase() === "male",
                ) ? (
                  <option value="male">Giọng nam</option>
                ) : null}
                {loadState.data.voices.some(
                  (voice) => voice.gender?.toLowerCase() === "female",
                ) ? (
                  <option value="female">Giọng nữ</option>
                ) : null}
                {loadState.data.voices.some(isYouthful) ? (
                  <option value="young">Giọng trẻ trung</option>
                ) : null}
              </select>
            ) : null}

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
            ) : loadState.data.voices.length === 0 ? (
              <p className="text-body text-muted">
                Chưa có giọng đọc trong danh sách. Bé có thể dùng giọng mặc định
                hoặc giọng tiếng Việt trên thiết bị nếu có.
              </p>
            ) : (
              <div
                aria-labelledby="voice-choice-heading"
                className="max-h-[min(24dvh,220px)] divide-y divide-border overflow-y-auto overscroll-contain rounded-control border border-border bg-white p-1"
                role="radiogroup"
              >
                {filteredVoices.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted">
                    Không có giọng phù hợp với bộ lọc.
                  </p>
                ) : null}
                {filteredVoices.map((voice) => {
                  const selected = voice.voice_id === selectedVoiceId;
                  return (
                    <label
                      key={voice.voice_id}
                      className={cn(
                        "flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2",
                        selected ? "bg-sky" : "bg-white hover:bg-cream",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block break-words text-sm font-bold text-ink">
                          {voiceTitle(voice)}
                        </span>
                        {voiceDetails(voice) ? (
                          <span className="block break-words text-sm text-muted">
                            {voiceDetails(voice)}
                          </span>
                        ) : null}
                      </span>
                      <input
                        type="radio"
                        name="viread-voice"
                        className="size-4 shrink-0 accent-primary"
                        checked={selected}
                        onChange={() =>
                          change({
                            voiceId:
                              voice.voice_id === defaultVoiceId
                                ? null
                                : voice.voice_id,
                          })
                        }
                      />
                    </label>
                  );
                })}
              </div>
            )}
          </section>

          <ReadingAutomationSettings />

          <footer className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-cream pt-3">
            <Button
              className="w-auto!"
              size="compact"
              onClick={() => change({ voiceId: null })}
              variant="quiet"
            >
              Dùng giọng mặc định
            </Button>
            <Button
              className="w-auto!"
              size="compact"
              onClick={() => {
                const generation = ++previewGenerationRef.current;
                if (isPreviewing) {
                  onStopPreview();
                  return;
                }
                setPreviewError(false);
                void Promise.resolve()
                  .then(() => onPreview(PREVIEW_TEXT))
                  .catch((error: unknown) => {
                    if (
                      mountedRef.current &&
                      generation === previewGenerationRef.current &&
                      !(error instanceof Error && error.name === "AbortError")
                    )
                      setPreviewError(true);
                  });
              }}
              variant="primary"
            >
              <Volume2 aria-hidden="true" className="size-5" />
              {isPreviewing ? "Dừng nghe thử" : "Nghe thử"}
            </Button>
          </footer>
          {previewError ? (
            <p role="alert" className="text-body text-muted">
              Chưa phát được giọng đọc. Bé thử lại hoặc chọn giọng khác nhé.
            </p>
          ) : fallbackNotice ? (
            <p
              role="status"
              className="rounded-control bg-warning-surface px-3 py-2 text-sm font-medium text-ink"
            >
              {fallbackNotice}
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
