"use client";

import { RefreshCw, SlidersHorizontal, Volume2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { ReadingAutomationSettings } from "@/components/reading/reading-automation-settings";
import { VoiceEngineBadge } from "@/components/reading/voice-engine-badge";
import { useSpeechPreferences } from "@/hooks/use-speech-preferences";
import {
  createVoiceStudioService,
  type VoiceList,
  type VoiceOption,
} from "@/lib/api/voice-studio-service";
import {
  getActiveSessionVoiceLock,
  getVoicePolicyPreferences,
  inferRegionFromVoiceId,
  lockSessionVoice,
  setVoicePolicyPreferences,
  subscribeVoicePolicy,
  VOICE_REGION_LABELS,
  type VoiceProviderMode,
  type VoiceRegion,
} from "@/lib/reading/session-voice-lock";
import {
  clampSpeed,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  getSpeechPreferences,
} from "@/lib/reading/speech-preferences";
import {
  fetchVoiceEngineHealth,
  type VoiceEngineHealthSnapshot,
} from "@/lib/reading/voice-engine-status";
import {
  adaptTextToTeacherPersona,
  resolveVoiceGender,
} from "@/lib/reading/voice-persona";
import { cn } from "@/lib/utils/cn";

const PREVIEW_TEXT =
  "Chào con, hôm nay cô trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.";
const SPEED_PRESETS = [
  { label: "Chậm", value: 0.85 },
  { label: "Vừa", value: 1.0 },
  { label: "Nhanh", value: 1.15 },
] as const;
const REGION_TABS: readonly {
  readonly id: "all" | VoiceRegion;
  readonly label: string;
}[] = [
  { id: "all", label: "Tất cả vùng" },
  { id: "north", label: "Miền Bắc" },
  { id: "central", label: "Miền Trung" },
  { id: "south", label: "Miền Nam" },
];
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

function resolveVoiceRegion(voice: VoiceOption): VoiceRegion | null {
  if (
    voice.region === "north" ||
    voice.region === "central" ||
    voice.region === "south"
  ) {
    return voice.region;
  }
  const accent = (voice.accent ?? "").toLowerCase();
  if (accent.includes("bắc") || accent === "northern") return "north";
  if (accent.includes("trung") || accent === "central") return "central";
  if (accent.includes("nam") || accent === "southern") return "south";
  return null;
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
    voice.region_label ??
      (voice.accent
        ? ((
            {
              northern: "Giọng Bắc",
              southern: "Giọng Nam",
              central: "Giọng Trung",
              american: "Giọng Mỹ",
              british: "Giọng Anh",
            } as Record<string, string>
          )[voice.accent.toLowerCase()] ?? voice.accent)
        : null),
    voice.age
      ? (ages[voice.age.toLowerCase()] ?? voice.age.replaceAll("_", " "))
      : null,
    voice.provider === "google" ? "Google dự phòng" : null,
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
  const policy = useSyncExternalStore(
    subscribeVoicePolicy,
    getVoicePolicyPreferences,
    getVoicePolicyPreferences,
  );
  const [isOpen, setIsOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [regionTab, setRegionTab] = useState<"all" | VoiceRegion>("all");
  const [filter, setFilter] = useState("all");
  const [removedVoiceNotice, setRemovedVoiceNotice] = useState<string | null>(
    null,
  );
  const [voiceHealth, setVoiceHealth] =
    useState<VoiceEngineHealthSnapshot | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const mountedRef = useRef(true);
  const previewGenerationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const healthControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadControllerRef.current?.abort();
      healthControllerRef.current?.abort();
    };
  }, []);

  const loadVoiceHealth = useCallback(() => {
    healthControllerRef.current?.abort();
    const controller = new AbortController();
    healthControllerRef.current = controller;
    void fetchVoiceEngineHealth(controller.signal).then((snapshot) => {
      if (!mountedRef.current || controller.signal.aborted) return;
      if (snapshot) {
        setVoiceHealth(snapshot);
      }
    });
  }, []);

  const syncPausedSessionLock = useCallback(
    (nextVoiceId?: string | null, nextSpeed?: number, modelVer?: string) => {
      const activeLock = getActiveSessionVoiceLock();
      if (!activeLock) return;
      lockSessionVoice(activeLock.sessionId, {
        voiceId:
          nextVoiceId !== undefined
            ? nextVoiceId
            : getSpeechPreferences().voiceId,
        speed:
          nextSpeed !== undefined ? nextSpeed : getSpeechPreferences().speed,
        modelVersion: modelVer,
        forceUpdate: true,
      });
    },
    [],
  );

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
        ) {
          setRemovedVoiceNotice(
            "Giọng đã lưu trước đây không còn khả dụng, ViRead đã chuyển về giọng mặc định để phụ huynh kiểm tra lại.",
          );
          update({ voiceId: null });
          syncPausedSessionLock(null);
        }
        setLoadState({ status: "ready", data });
      })
      .catch(() => {
        if (mountedRef.current && !controller.signal.aborted)
          setLoadState({ status: "error" });
      });
  }, [voiceStudio, update, syncPausedSessionLock]);

  function change(
    value: Parameters<typeof update>[0],
    selectedOption?: VoiceOption,
  ) {
    previewGenerationRef.current += 1;
    onStopPreview();
    setPreviewError(false);
    setRemovedVoiceNotice(null);
    update(value);
    if (selectedOption) {
      const reg = resolveVoiceRegion(selectedOption);
      setVoicePolicyPreferences({
        ...(reg ? { region: reg } : {}),
        ...(selectedOption.model_version
          ? { modelVersion: selectedOption.model_version }
          : {}),
      });
    }
    syncPausedSessionLock(
      value.voiceId,
      value.speed,
      selectedOption?.model_version ?? undefined,
    );
  }

  function changeProviderPolicy(
    nextPolicy: Partial<{
      providerMode: VoiceProviderMode;
      allowGoogleSttFallback: boolean;
      allowGoogleTtsFallback: boolean;
    }>,
  ) {
    previewGenerationRef.current += 1;
    onStopPreview();
    setPreviewError(false);
    const updated = setVoicePolicyPreferences(nextPolicy);
    // If Google TTS was disabled while a Google voice was chosen, reset cleanly to local voice
    const currentVoiceId = getSpeechPreferences().voiceId;
    if (
      currentVoiceId?.startsWith("google_") &&
      (updated.providerMode !== "local_with_google_fallback" ||
        !updated.allowGoogleTtsFallback)
    ) {
      update({ voiceId: null });
      syncPausedSessionLock(null);
    }
    if (isOpen) {
      loadVoices();
    }
  }

  function selectRegionTab(nextTab: "all" | VoiceRegion) {
    setRegionTab(nextTab);
    if (nextTab === "all") return;
    setVoicePolicyPreferences({ region: nextTab });
    if (loadState.status === "ready") {
      const regionVoices = loadState.data.voices.filter(
        (v) => resolveVoiceRegion(v) === nextTab,
      );
      if (regionVoices.length > 0) {
        const currentId =
          preferences.voiceId ?? loadState.data.default_voice_id;
        if (!regionVoices.some((v) => v.voice_id === currentId)) {
          const pick = regionVoices[0];
          change(
            {
              voiceId:
                pick.voice_id === loadState.data.default_voice_id
                  ? null
                  : pick.voice_id,
            },
            pick,
          );
        }
      }
    }
  }

  function open() {
    setIsOpen(true);
    loadVoiceHealth();
    if (loadState.status === "idle" || loadState.status === "error") {
      loadVoices();
    }
  }

  function close() {
    previewGenerationRef.current += 1;
    setPreviewError(false);
    onStopPreview();
    loadControllerRef.current?.abort();
    healthControllerRef.current?.abort();
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
  const isChildVoice = (voice: VoiceOption) =>
    voice.age?.toLowerCase() === "child";

  const hasRegionalMetadata =
    loadState.status === "ready" &&
    loadState.data.voices.some((v) => resolveVoiceRegion(v) !== null);

  const matchesFilter = (voice: VoiceOption) => {
    if (regionTab !== "all" && hasRegionalMetadata) {
      if (resolveVoiceRegion(voice) !== regionTab) return false;
    }
    return (
      filter === "all" ||
      (filter === "young"
        ? isYouthful(voice)
        : filter === "child"
          ? isChildVoice(voice)
          : voice.gender?.toLowerCase() === filter)
    );
  };

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

  const activeRegionLabel = selectedVoice
    ? (VOICE_REGION_LABELS[
        resolveVoiceRegion(selectedVoice) ??
          inferRegionFromVoiceId(selectedVoice.voice_id, policy.region)
      ] ?? "Miền Bắc")
    : VOICE_REGION_LABELS[policy.region];

  return (
    <>
      <Button
        aria-haspopup="dialog"
        className="min-w-0 flex-col gap-0.5 px-1.5 py-1.5 text-xs leading-snug lg:min-h-14 lg:flex-row lg:gap-2 lg:px-3 lg:py-2 lg:text-button"
        disabled={disabled}
        onClick={open}
        size="compact"
        variant="quiet"
      >
        <SlidersHorizontal
          aria-hidden="true"
          className="size-5 shrink-0 lg:size-6"
        />
        <span className="max-w-full text-center whitespace-normal break-words">
          Giọng đọc
        </span>
      </Button>

      <Modal
        footer={
          <div className="space-y-2">
            <footer className="flex flex-wrap items-center justify-end gap-2">
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
                  const previewText = adaptTextToTeacherPersona(
                    PREVIEW_TEXT,
                    resolveVoiceGender(selectedVoiceId, selectedVoice?.gender),
                  );
                  void Promise.resolve()
                    .then(() => onPreview(previewText))
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
        }
        isOpen={isOpen}
        onClose={close}
        title="Giọng đọc mẫu"
      >
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
            · {activeRegionLabel} · {formatSpeed(preferences.speed)} ·{" "}
            {policy.providerMode === "local_only"
              ? "Chỉ máy này"
              : "Máy này + Google dự phòng"}
          </div>

          {removedVoiceNotice ? (
            <p
              role="status"
              className="rounded-control border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950"
            >
              {removedVoiceNotice}
            </p>
          ) : null}

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
              Chọn vùng miền & giọng đọc
            </h3>

            {hasRegionalMetadata ? (
              <div
                aria-label="Chọn vùng miền"
                className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
                role="group"
              >
                {REGION_TABS.map((tab) => {
                  const active = regionTab === tab.id;
                  return (
                    <button
                      aria-pressed={active}
                      className={cn(
                        "rounded-control border px-2.5 py-1.5 text-xs font-bold transition",
                        active
                          ? "border-primary bg-primary text-white"
                          : "border-border bg-white text-ink hover:border-primary",
                      )}
                      key={tab.id}
                      onClick={() => selectRegionTab(tab.id)}
                      type="button"
                    >
                      {tab.label}
                    </button>
                  );
                })}
              </div>
            ) : null}

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
                {loadState.data.voices.some(isChildVoice) ? (
                  <option value="child">Giọng trẻ em</option>
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
                trên máy này.
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
                          change(
                            {
                              voiceId:
                                voice.voice_id === defaultVoiceId
                                  ? null
                                  : voice.voice_id,
                            },
                            voice,
                          )
                        }
                      />
                    </label>
                  );
                })}
              </div>
            )}
            {loadState.status === "ready" &&
            loadState.data.local_worker_ready === false ? (
              <p
                className="rounded-control border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs leading-relaxed text-amber-950"
                data-testid="voice-offline-cache-notice"
              >
                Máy trạm giọng đọc đang ngoại tuyến. Chế độ Wi-Fi tự lập hiện có
                sẵn âm thanh dựng trước cho giọng mặc định; để nghe trực tiếp
                các giọng vùng miền khác hãy bật máy trạm giọng đọc hoặc bật chế
                độ dự phòng bên dưới.
              </p>
            ) : null}
          </section>

          <section
            aria-labelledby="voice-provider-policy-heading"
            className="space-y-2.5 rounded-control border border-border bg-white p-3"
          >
            <h3
              className="text-label font-semibold text-ink"
              id="voice-provider-policy-heading"
            >
              Chế độ xử lý giọng nói (Dành cho phụ huynh)
            </h3>
            <VoiceEngineBadge />
            {voiceHealth ? (
              <div
                data-testid="voice-health-status-pills"
                className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold"
              >
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5",
                    voiceHealth.local.available
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : "border-rose-200 bg-rose-50 text-rose-900",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      voiceHealth.local.available
                        ? "bg-emerald-500"
                        : "bg-rose-500",
                    )}
                    aria-hidden="true"
                  />
                  Local Worker:{" "}
                  {voiceHealth.local.available ? "Sẵn sàng" : "Chưa bật"}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5",
                    voiceHealth.google.stt_configured ||
                      voiceHealth.google.tts_configured
                      ? "border-sky-200 bg-sky-50 text-sky-900"
                      : "border-amber-200 bg-amber-50 text-amber-900",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      voiceHealth.google.stt_configured ||
                        voiceHealth.google.tts_configured
                        ? "bg-sky-500"
                        : "bg-amber-500",
                    )}
                    aria-hidden="true"
                  />
                  Google Cloud API:{" "}
                  {voiceHealth.google.stt_configured ||
                  voiceHealth.google.tts_configured
                    ? "Đã cấu hình"
                    : "Chưa cấu hình key"}
                </span>
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                aria-pressed={policy.providerMode === "local_only"}
                className={cn(
                  "rounded-control border-2 px-3 py-2 text-left text-xs font-bold transition",
                  policy.providerMode === "local_only"
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-cream/60 text-ink hover:border-primary",
                )}
                onClick={() =>
                  changeProviderPolicy({
                    providerMode: "local_only",
                    allowGoogleSttFallback: false,
                    allowGoogleTtsFallback: false,
                  })
                }
                type="button"
              >
                Chỉ máy này
                <span
                  className={cn(
                    "mt-0.5 block font-normal",
                    policy.providerMode === "local_only"
                      ? "text-white/90"
                      : "text-muted",
                  )}
                >
                  Chạy 100% nội bộ (máy chủ + trình duyệt), không gọi Google
                </span>
              </button>
              <button
                aria-pressed={
                  policy.providerMode === "local_with_google_fallback"
                }
                className={cn(
                  "rounded-control border-2 px-3 py-2 text-left text-xs font-bold transition",
                  policy.providerMode === "local_with_google_fallback"
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-cream/60 text-ink hover:border-primary",
                )}
                onClick={() =>
                  changeProviderPolicy(
                    policy.providerMode === "local_with_google_fallback"
                      ? { providerMode: "local_with_google_fallback" }
                      : {
                          providerMode: "local_with_google_fallback",
                          allowGoogleSttFallback: true,
                          allowGoogleTtsFallback: true,
                        },
                  )
                }
                type="button"
              >
                Máy này + Google dự phòng
                <span
                  className={cn(
                    "mt-0.5 block font-normal",
                    policy.providerMode === "local_with_google_fallback"
                      ? "text-white/90"
                      : "text-muted",
                  )}
                >
                  Ưu tiên local, bật tự động chuyển Online dự phòng
                </span>
              </button>
            </div>

            {policy.providerMode === "local_with_google_fallback" ? (
              <div className="space-y-2 rounded-lg bg-cream/70 p-2.5 text-xs">
                <label className="flex cursor-pointer items-center justify-between gap-2 font-medium text-ink">
                  <span>Dự phòng Google cho Nhận diện giọng nói (STT)</span>
                  <input
                    checked={policy.allowGoogleSttFallback}
                    className="size-4 accent-primary"
                    onChange={(e) =>
                      changeProviderPolicy({
                        allowGoogleSttFallback: e.target.checked,
                      })
                    }
                    type="checkbox"
                  />
                </label>
                <label className="flex cursor-pointer items-center justify-between gap-2 font-medium text-ink">
                  <span>Dự phòng Google cho Đọc mẫu (TTS)</span>
                  <input
                    checked={policy.allowGoogleTtsFallback}
                    className="size-4 accent-primary"
                    onChange={(e) =>
                      changeProviderPolicy({
                        allowGoogleTtsFallback: e.target.checked,
                      })
                    }
                    type="checkbox"
                  />
                </label>
                {!voiceHealth ||
                (!voiceHealth.google.stt_configured &&
                  !voiceHealth.google.tts_configured) ? (
                  <p className="text-[11px] leading-relaxed text-muted">
                    Khi máy chưa cấu hình khóa Google Cloud API trong{" "}
                    <code className="font-mono">backend/.env</code>, ViRead sẽ
                    tự động dùng Google/Trình duyệt Online làm dự phòng.
                  </p>
                ) : null}
              </div>
            ) : null}
          </section>

          <ReadingAutomationSettings />
        </div>
      </Modal>
    </>
  );
}
