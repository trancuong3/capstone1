"use client";

import { Check, RefreshCw, SlidersHorizontal, Volume2 } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { ReadingAutomationSettings } from "@/components/reading/reading-automation-settings";
import { VoiceEngineBadge } from "@/components/reading/voice-engine-badge";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useSpeechPreferences } from "@/hooks/use-speech-preferences";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import { createChildService } from "@/lib/api/child-service";
import {
  createVoiceStudioService,
  type VoiceList,
  type VoiceOption,
} from "@/lib/api/voice-studio-service";
import {
  applyGlobalTeacherVoiceSelection,
  clearPendingSessionVoiceSwitch,
  getActiveSessionVoiceLock,
  getDefaultLocalVoiceIdForRegionAndGender,
  getDefaultVoiceIdForRegionAndGender,
  getDefaultVoicePolicyPreferences,
  getVoicePolicyPreferences,
  inferRegionFromVoiceId,
  lockSessionVoice,
  setVoicePolicyPreferences,
  subscribeVoiceLock,
  subscribeVoicePolicy,
  type VoiceProviderMode,
  type VoiceRegion,
} from "@/lib/reading/session-voice-lock";
import {
  clampSpeed,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
  getSpeechPreferences,
  getSpeechPreferencesMeta,
} from "@/lib/reading/speech-preferences";
import { detectBrowserWasmTtsSupport } from "@/lib/reading/browser-wasm-tts";
import { warmWasmTtsIfNeeded } from "@/lib/reading/voice-preloader";
import {
  fetchVoiceEngineHealth,
  getBrowserOnlineStatus,
  getCachedVoiceEngineHealth,
  isPermanentlyHostedLocalUnconfigured,
  subscribeBrowserOnlineStatus,
  subscribeVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import {
  adaptTextToTeacherPersona,
  resolveVoiceGender,
  type VoiceGender,
} from "@/lib/reading/voice-persona";
import { isAndroidNativeSpeechAvailable } from "@/lib/reading/native-speech-bridge";
import { cn } from "@/lib/utils/cn";

const PREVIEW_TEXT =
  "Chào con, hôm nay cô trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.";
const SPEED_PRESETS = [
  { labelKey: "preferences.slow", value: 0.85 },
  { labelKey: "preferences.normal", value: 1.0 },
  { labelKey: "preferences.fast", value: 1.15 },
] as const;
const REGION_TABS: readonly {
  readonly id: "all" | VoiceRegion;
  readonly labelKey: string;
}[] = [
  { id: "all", labelKey: "settings.regions.all" },
  { id: "north", labelKey: "settings.regions.north" },
  { id: "central", labelKey: "settings.regions.central" },
  { id: "south", labelKey: "settings.regions.south" },
];

type SpeechTranslateFn = ReturnType<typeof useTranslations>;

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: VoiceList }
  | { status: "error" };

interface ReadingVoiceSettingsProps {
  childId?: string | null;
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

function voiceDetails(voice: VoiceOption, t: SpeechTranslateFn): string {
  const ageKeys: Record<string, string> = {
    young: "settings.ageGroups.young",
    young_adult: "settings.ageGroups.young",
    youthful: "settings.ageGroups.young",
    child: "settings.ageGroups.child",
    middle_aged: "settings.ageGroups.middle_aged",
    old: "settings.ageGroups.old",
  };
  const accentKeys: Record<string, string> = {
    northern: "settings.accents.northern",
    southern: "settings.accents.southern",
    central: "settings.accents.central",
    american: "settings.accents.american",
    british: "settings.accents.british",
  };
  const genderKey = voice.gender?.toLowerCase();
  const genderLabel =
    genderKey === "female" || genderKey === "male"
      ? t(`settings.genders.${genderKey}`)
      : voice.gender;
  const accentKey = voice.accent?.toLowerCase();
  const ageKey = voice.age?.toLowerCase();
  return [
    voice.gender ? genderLabel : null,
    voice.region_label ??
      (voice.accent
        ? accentKey && accentKeys[accentKey]
          ? t(accentKeys[accentKey])
          : voice.accent
        : null),
    voice.age
      ? ageKey && ageKeys[ageKey]
        ? t(ageKeys[ageKey])
        : voice.age.replaceAll("_", " ")
      : null,
    voice.provider === "google" ? t("settings.googleProviderLabel") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function ReadingVoiceSettings({
  childId = null,
  disabled = false,
  isPreviewing = false,
  fallbackNotice = null,
  onPreview,
  onStopPreview,
}: ReadingVoiceSettingsProps) {
  const { formatNumber } = useI18n();
  const t = useTranslations("speech");
  const tCommon = useTranslations("common");
  const formatSpeed = (speed: number): string =>
    `${formatNumber(speed, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;
  const voiceStudio = useMemo(() => createVoiceStudioService(), []);
  const appStore = useContext(AppStoreContext);
  const appServices = useContext(AppServicesContext);
  const childService = useMemo(
    () => appServices?.childService ?? createChildService(),
    [appServices?.childService],
  );
  const selectedChildId = childId ?? appStore?.selectedChildId ?? null;
  const { preferences, update } = useSpeechPreferences();
  const teacherPersona = useTeacherPersona();
  const policy = useSyncExternalStore(
    subscribeVoicePolicy,
    getVoicePolicyPreferences,
    getDefaultVoicePolicyPreferences,
  );
  const voiceHealth = useSyncExternalStore(
    subscribeVoiceEngineHealth,
    getCachedVoiceEngineHealth,
    () => null,
  );
  const activeSessionLock = useSyncExternalStore(
    subscribeVoiceLock,
    getActiveSessionVoiceLock,
    () => null,
  );
  const isBrowserOnline = useSyncExternalStore(
    subscribeBrowserOnlineStatus,
    getBrowserOnlineStatus,
    () => true,
  );
  const [isOpen, setIsOpen] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>({ status: "idle" });
  const [regionTab, setRegionTab] = useState<"all" | VoiceRegion>("all");
  const [filter, setFilter] = useState("all");
  const [removedVoiceNotice, setRemovedVoiceNotice] = useState<string | null>(
    null,
  );
  const [previewError, setPreviewError] = useState(false);
  const [isSynthesizingPreview, setIsSynthesizingPreview] = useState(false);
  const voiceListProgress = useAiProgress({
    active: isOpen && loadState.status === "loading",
    stages: [
      { atPct: 0, label: tCommon("aiProgress.connecting") },
      { atPct: 60, label: tCommon("aiProgress.processing") },
      { atPct: 88, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 4_000,
  });
  const previewVoiceProgress = useAiProgress({
    active: isSynthesizingPreview && !isPreviewing,
    stages: [
      { atPct: 0, label: tCommon("aiProgress.synthesizingVoice") },
      { atPct: 70, label: tCommon("aiProgress.finalizing") },
    ],
    expectedDurationMs: 4_000,
  });
  const mountedRef = useRef(true);
  const previewGenerationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const healthControllerRef = useRef<AbortController | null>(null);
  const lastLoadedContextKeyRef = useRef<string | null>(null);

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
    void fetchVoiceEngineHealth(controller.signal);
  }, []);

  const syncPausedSessionLock = useCallback(
    (nextVoiceId?: string | null, nextSpeed?: number, modelVer?: string) => {
      const activeLock = getActiveSessionVoiceLock();
      if (!activeLock) return;
      const updatedLock = lockSessionVoice(activeLock.sessionId, {
        voiceId:
          nextVoiceId !== undefined
            ? nextVoiceId
            : getSpeechPreferences().voiceId,
        speed:
          nextSpeed !== undefined ? nextSpeed : getSpeechPreferences().speed,
        modelVersion: modelVer,
        forceUpdate: true,
      });
      // Explicitly resync server-side SessionVoiceLock so subsequent playback
      // never hits 409 SESSION_VOICE_LOCKED after an intentional paused voice change.
      if (
        updatedLock.voiceId !== activeLock.voiceId &&
        typeof voiceStudio.updateSessionVoiceLock === "function"
      ) {
        void voiceStudio
          .updateSessionVoiceLock({
            sessionId: activeLock.sessionId,
            voiceId: updatedLock.voiceId,
          })
          .then(() => {
            clearPendingSessionVoiceSwitch(activeLock.sessionId);
          })
          .catch(() => undefined);
      }
    },
    [voiceStudio],
  );

  const buildVoiceContextKey = useCallback(
    (healthSnap = getCachedVoiceEngineHealth()) => {
      const currentPolicy = getVoicePolicyPreferences();
      return `${currentPolicy.providerMode}:${currentPolicy.allowGoogleTtsFallback}:${healthSnap?.local.available ?? "u"}:${healthSnap?.google.tts_configured ?? "u"}:${healthSnap?.elevenlabs?.tts_configured ?? "u"}:${healthSnap?.elevenlabs?.male_tts_configured ?? "u"}`;
    },
    [],
  );

  const loadVoices = useCallback(() => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    loadControllerRef.current = controller;
    const contextKey = buildVoiceContextKey();
    setLoadState({ status: "loading" });
    voiceStudio
      .listVoices(controller.signal)
      .then((data) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        lastLoadedContextKeyRef.current = contextKey;
        const storedVoice = getSpeechPreferences().voiceId;
        if (
          storedVoice &&
          !data.voices.some((voice) => voice.voice_id === storedVoice)
        ) {
          const preservedGender = resolveVoiceGender(
            storedVoice,
            getSpeechPreferencesMeta().gender,
          );
          const preservedRegion = inferRegionFromVoiceId(
            storedVoice,
            getVoicePolicyPreferences().region,
          );
          const fallbackVoice =
            data.voices.find(
              (v) =>
                resolveVoiceRegion(v) === preservedRegion &&
                resolveVoiceGender(v.voice_id, v.gender) === preservedGender,
            ) ??
            data.voices.find(
              (v) =>
                resolveVoiceGender(v.voice_id, v.gender) === preservedGender,
            ) ??
            null;
          const fallbackVoiceId =
            fallbackVoice && fallbackVoice.voice_id !== data.default_voice_id
              ? fallbackVoice.voice_id
              : null;
          setRemovedVoiceNotice(t("settings.savedVoiceResetNotice"));
          update({
            voiceId: fallbackVoiceId,
            gender: fallbackVoiceId ? preservedGender : "female",
          });
          syncPausedSessionLock(fallbackVoiceId);
        }
        setLoadState({ status: "ready", data });
      })
      .catch(() => {
        if (mountedRef.current && !controller.signal.aborted)
          setLoadState({ status: "error" });
      });
  }, [voiceStudio, update, syncPausedSessionLock, t, buildVoiceContextKey]);

  function change(
    value: Parameters<typeof update>[0],
    selectedOption?: VoiceOption,
  ) {
    previewGenerationRef.current += 1;
    setIsSynthesizingPreview(false);
    onStopPreview();
    setPreviewError(false);
    setRemovedVoiceNotice(null);
    const resolvedRegion = selectedOption
      ? (resolveVoiceRegion(selectedOption) ?? undefined)
      : undefined;
    const isDefaultOrReset = value.voiceId === null;
    const explicitVoiceId =
      value.voiceId !== undefined
        ? value.voiceId === null
          ? loadState.status === "ready"
            ? loadState.data.default_voice_id
            : "local_north_truc_ly"
          : value.voiceId
        : undefined;
    const storedVoiceId =
      value.voiceId !== undefined
        ? value.voiceId
        : getSpeechPreferences().voiceId;

    applyGlobalTeacherVoiceSelection({
      ...(explicitVoiceId !== undefined ? { voiceId: explicitVoiceId } : {}),
      storedVoiceId: isDefaultOrReset ? null : storedVoiceId,
      ...(selectedOption
        ? {
            gender: resolveVoiceGender(
              selectedOption.voice_id,
              selectedOption.gender,
            ),
          }
        : value.voiceId === null
          ? { gender: "female" }
          : {}),
      ...(resolvedRegion ? { region: resolvedRegion } : {}),
      ...(value.speed !== undefined ? { speed: value.speed } : {}),
      ...(selectedOption?.model_version
        ? { modelVersion: selectedOption.model_version }
        : {}),
      childId: selectedChildId,
      persistToBackend:
        selectedChildId &&
        typeof childService.updateVoicePreferences === "function"
          ? (childId, payload) =>
              childService.updateVoicePreferences!(childId, payload)
          : undefined,
      syncActiveServerSessionLock:
        typeof voiceStudio.updateSessionVoiceLock === "function"
          ? (lockInput) => voiceStudio.updateSessionVoiceLock!(lockInput)
          : undefined,
    });
    const targetGender = selectedOption
      ? resolveVoiceGender(selectedOption.voice_id, selectedOption.gender)
      : value.voiceId === null
        ? "female"
        : resolveVoiceGender(explicitVoiceId ?? storedVoiceId);
    void warmWasmTtsIfNeeded(targetGender, voiceHealth ?? undefined);
  }

  function selectTeacherGender(nextGender: VoiceGender) {
    previewGenerationRef.current += 1;
    setIsSynthesizingPreview(false);
    onStopPreview();
    setPreviewError(false);
    setRemovedVoiceNotice(null);
    const targetRegion: VoiceRegion =
      regionTab !== "all" ? regionTab : activeRegionKey;
    let pickedVoice: VoiceOption | undefined;
    if (loadState.status === "ready") {
      const sameRegionSameGender = loadState.data.voices.filter(
        (v) =>
          resolveVoiceRegion(v) === targetRegion &&
          resolveVoiceGender(v.voice_id, v.gender) === nextGender,
      );
      const defaultForPair = getDefaultVoiceIdForRegionAndGender(
        targetRegion,
        nextGender,
      );
      pickedVoice =
        sameRegionSameGender.find((v) => v.voice_id === defaultForPair) ??
        sameRegionSameGender[0] ??
        loadState.data.voices.find(
          (v) => resolveVoiceGender(v.voice_id, v.gender) === nextGender,
        );
    }
    const nextVoiceId =
      pickedVoice?.voice_id ??
      getDefaultVoiceIdForRegionAndGender(targetRegion, nextGender);
    applyGlobalTeacherVoiceSelection({
      voiceId: nextVoiceId,
      gender: nextGender,
      region: targetRegion,
      modelVersion: pickedVoice?.model_version ?? undefined,
      childId: selectedChildId,
      persistToBackend:
        selectedChildId &&
        typeof childService.updateVoicePreferences === "function"
          ? (childId, payload) =>
              childService.updateVoicePreferences!(childId, payload)
          : undefined,
      syncActiveServerSessionLock:
        typeof voiceStudio.updateSessionVoiceLock === "function"
          ? (lockInput) => voiceStudio.updateSessionVoiceLock!(lockInput)
          : undefined,
    });
    void warmWasmTtsIfNeeded(nextGender, voiceHealth ?? undefined);
  }

  function changeProviderPolicy(
    nextPolicy: Partial<{
      providerMode: VoiceProviderMode;
      allowGoogleSttFallback: boolean;
      allowGoogleTtsFallback: boolean;
    }>,
  ) {
    previewGenerationRef.current += 1;
    setIsSynthesizingPreview(false);
    onStopPreview();
    setPreviewError(false);
    const updated = setVoicePolicyPreferences(nextPolicy);
    // If Google TTS was disabled while a Google voice was chosen, downgrade
    // cleanly to the matching region+gender local voice (treating default as null).
    const currentVoiceId = getSpeechPreferences().voiceId;
    if (
      currentVoiceId?.startsWith("google_") &&
      (updated.providerMode !== "local_with_google_fallback" ||
        !updated.allowGoogleTtsFallback)
    ) {
      const preservedGender = resolveVoiceGender(currentVoiceId);
      const preservedRegion = inferRegionFromVoiceId(
        currentVoiceId,
        updated.region,
      );
      const localFallbackId = getDefaultLocalVoiceIdForRegionAndGender(
        preservedRegion,
        preservedGender,
      );
      const defaultVoice =
        loadState.status === "ready"
          ? loadState.data.default_voice_id
          : "local_north_truc_ly";
      applyGlobalTeacherVoiceSelection({
        voiceId: localFallbackId,
        storedVoiceId:
          localFallbackId === defaultVoice ? null : localFallbackId,
        gender: preservedGender,
        region: preservedRegion,
        childId: selectedChildId,
        persistToBackend:
          selectedChildId &&
          typeof childService.updateVoicePreferences === "function"
            ? (childId, payload) =>
                childService.updateVoicePreferences!(childId, payload)
            : undefined,
        syncActiveServerSessionLock:
          typeof voiceStudio.updateSessionVoiceLock === "function"
            ? (lockInput) => voiceStudio.updateSessionVoiceLock!(lockInput)
            : undefined,
      });
    }
    if (isOpen) {
      loadVoices();
    }
  }

  function selectRegionTab(nextTab: "all" | VoiceRegion) {
    setRegionTab(nextTab);
    if (nextTab === "all") return;
    // During an active locked reading session, switching region tabs ONLY filters
    // the visible list so browsing regions never silently alters the locked voice.
    if (getActiveSessionVoiceLock() !== null) {
      return;
    }
    setVoicePolicyPreferences({ region: nextTab });
    if (loadState.status === "ready") {
      const regionVoices = loadState.data.voices.filter(
        (v) => resolveVoiceRegion(v) === nextTab,
      );
      if (regionVoices.length > 0) {
        const currentId =
          preferences.voiceId ?? loadState.data.default_voice_id;
        const currentGender = resolveVoiceGender(
          currentId,
          teacherPersona.gender,
        );
        if (!regionVoices.some((v) => v.voice_id === currentId)) {
          // ALWAYS preserve the active gender when changing region tabs!
          const sameGenderVoices = regionVoices.filter(
            (v) => resolveVoiceGender(v.voice_id, v.gender) === currentGender,
          );
          const defaultForPair = getDefaultVoiceIdForRegionAndGender(
            nextTab,
            currentGender,
          );
          const pick =
            sameGenderVoices.find((v) => v.voice_id === defaultForPair) ??
            sameGenderVoices[0] ??
            regionVoices[0];
          change({ voiceId: pick.voice_id }, pick);
        }
      }
    }
  }

  function open() {
    setIsOpen(true);
    loadVoiceHealth();
    const currentKey = buildVoiceContextKey();
    if (
      loadState.status === "idle" ||
      loadState.status === "error" ||
      lastLoadedContextKeyRef.current !== currentKey
    ) {
      loadVoices();
    }
  }

  function close() {
    previewGenerationRef.current += 1;
    setIsSynthesizingPreview(false);
    setPreviewError(false);
    onStopPreview();
    loadControllerRef.current?.abort();
    healthControllerRef.current?.abort();
    if (loadState.status === "loading") setLoadState({ status: "idle" });
    setIsOpen(false);
  }

  const defaultVoiceId =
    loadState.status === "ready" ? loadState.data.default_voice_id : null;
  const pairDefaultVoiceId = getDefaultLocalVoiceIdForRegionAndGender(
    policy.region,
    teacherPersona.gender,
  );
  const selectedVoiceId =
    preferences.voiceId ??
    (loadState.status === "ready" &&
    loadState.data.voices.some((v) => v.voice_id === pairDefaultVoiceId)
      ? pairDefaultVoiceId
      : defaultVoiceId);
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

  const activeRegionKey = selectedVoice
    ? (resolveVoiceRegion(selectedVoice) ??
      inferRegionFromVoiceId(selectedVoice.voice_id, policy.region))
    : policy.region;
  const activeRegionLabel = t(`settings.regions.${activeRegionKey}`);

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
          {t("settings.buttonLabel")}
        </span>
      </Button>

      <Modal
        footer={
          <div className="space-y-2">
            <footer className="flex flex-wrap items-center justify-end gap-2">
              <Button
                className="w-auto!"
                size="compact"
                onClick={() => {
                  setVoicePolicyPreferences({ region: "north" });
                  change({ voiceId: null });
                }}
                variant="quiet"
              >
                {t("settings.useDefaultVoice")}
              </Button>
              <Button
                className="w-auto!"
                size="compact"
                onClick={() => {
                  const generation = ++previewGenerationRef.current;
                  if (isPreviewing || isSynthesizingPreview) {
                    setIsSynthesizingPreview(false);
                    onStopPreview();
                    return;
                  }
                  setPreviewError(false);
                  setIsSynthesizingPreview(true);
                  const previewText = adaptTextToTeacherPersona(
                    PREVIEW_TEXT,
                    resolveVoiceGender(selectedVoiceId, selectedVoice?.gender),
                  );
                  void Promise.resolve()
                    .then(() => onPreview(previewText))
                    .catch((error: unknown) => {
                      const isAbortError =
                        typeof error === "object" &&
                        error !== null &&
                        "name" in error &&
                        (error as { name?: unknown }).name === "AbortError";
                      if (
                        mountedRef.current &&
                        generation === previewGenerationRef.current &&
                        !isAbortError
                      )
                        setPreviewError(true);
                    })
                    .finally(() => {
                      if (
                        mountedRef.current &&
                        generation === previewGenerationRef.current
                      ) {
                        setIsSynthesizingPreview(false);
                      }
                    });
                }}
                variant="primary"
              >
                <Volume2 aria-hidden="true" className="size-5" />
                {isPreviewing
                  ? t("settings.stopPreview")
                  : t("settings.preview")}
              </Button>
            </footer>
            {isSynthesizingPreview && !isPreviewing ? (
              <AiProgressBar
                active
                label={
                  previewVoiceProgress.stageLabel ??
                  tCommon("aiProgress.synthesizingVoice")
                }
                percent={previewVoiceProgress.percent}
                size="compact"
                testId="voice-preview-progress"
              />
            ) : null}
            {previewError ? (
              <p role="alert" className="text-body text-muted">
                {t("settings.previewFailed")}
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
        title={`${t("settings.modalTitle")} · ${teacherPersona.title}`}
      >
        <div className="space-y-4 pb-4">
          <div
            aria-label={t("settings.teacherPersonaAria")}
            className="grid grid-cols-2 gap-2"
            role="group"
          >
            {(
              [
                {
                  gender: "female" as const,
                  label: t("settings.femaleTeacherQuickBtn"),
                },
                {
                  gender: "male" as const,
                  label: t("settings.maleTeacherQuickBtn"),
                },
              ] as const
            ).map((option) => {
              const active = teacherPersona.gender === option.gender;
              return (
                <button
                  aria-pressed={active}
                  className={cn(
                    "inline-flex min-h-12 items-center justify-center gap-1.5 rounded-control border-2 px-3 py-2 text-sm font-extrabold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                    active
                      ? "border-primary bg-primary text-white shadow-xs"
                      : "border-border bg-white text-ink hover:border-primary/60 hover:bg-cream",
                  )}
                  data-testid={`voice-modal-teacher-${option.gender}`}
                  key={option.gender}
                  onClick={() => selectTeacherGender(option.gender)}
                  type="button"
                >
                  {active ? (
                    <Check aria-hidden="true" className="size-4 shrink-0" />
                  ) : null}
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>

          <div
            className="rounded-control bg-sky px-3 py-2 text-sm font-semibold text-primary"
            aria-live="polite"
          >
            <div>
              {teacherPersona.title} ·{" "}
              {selectedVoice
                ? voiceTitle(selectedVoice)
                : preferences.voiceId
                  ? t("settings.savedVoice")
                  : t("settings.defaultVoice")}{" "}
              · {activeRegionLabel} · {formatSpeed(preferences.speed)} ·{" "}
              {policy.providerMode === "local_only"
                ? t("settings.localOnlyMode")
                : t("settings.localWithGoogleMode")}
            </div>
            {activeSessionLock ||
            !isBrowserOnline ||
            isAndroidNativeSpeechAvailable() ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] font-semibold">
                {activeSessionLock ? (
                  <span
                    data-testid="session-voice-lock-badge"
                    className="inline-flex items-center rounded-full border border-primary/20 bg-white/80 px-2 py-0.5 text-primary"
                  >
                    {t("settings.sessionLockedBadge")}
                  </span>
                ) : null}
                {isAndroidNativeSpeechAvailable() ? (
                  <span
                    data-testid="android-native-speech-badge"
                    className="inline-flex items-center rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-900"
                  >
                    Android TTS/STT (vi-VN)
                  </span>
                ) : null}
                {!isBrowserOnline ? (
                  <span
                    data-testid="browser-offline-badge"
                    className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-amber-900"
                  >
                    {t("settings.offlineBrowserBadge")}
                  </span>
                ) : null}
              </div>
            ) : null}
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
                {t("settings.speedLabel")}
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
                    key={preset.value}
                    onClick={() => change({ speed: preset.value })}
                    type="button"
                  >
                    {t(preset.labelKey)}
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
              {t("settings.regionAndVoiceTitle")}
            </h3>

            {hasRegionalMetadata ? (
              <div
                aria-label={t("settings.regionAria")}
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
                      {t(tab.labelKey)}
                    </button>
                  );
                })}
              </div>
            ) : null}

            {loadState.status === "ready" &&
            loadState.data.voices.length > 0 ? (
              <select
                aria-label={t("settings.filterAria")}
                className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-body"
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">{t("settings.allVoices")}</option>
                {loadState.data.voices.some(
                  (voice) => voice.gender?.toLowerCase() === "male",
                ) ? (
                  <option value="male">{t("settings.maleVoice")}</option>
                ) : null}
                {loadState.data.voices.some(
                  (voice) => voice.gender?.toLowerCase() === "female",
                ) ? (
                  <option value="female">{t("settings.femaleVoice")}</option>
                ) : null}
                {loadState.data.voices.some(isYouthful) ? (
                  <option value="young">{t("settings.youngVoice")}</option>
                ) : null}
                {loadState.data.voices.some(isChildVoice) ? (
                  <option value="child">{t("settings.childVoice")}</option>
                ) : null}
              </select>
            ) : null}

            {loadState.status === "loading" || loadState.status === "idle" ? (
              <div className="space-y-2">
                <p className="text-body text-muted">
                  {t("settings.loadingVoices")}
                </p>
                {loadState.status === "loading" ? (
                  <AiProgressBar
                    active
                    label={
                      voiceListProgress.stageLabel ??
                      tCommon("aiProgress.connecting")
                    }
                    percent={voiceListProgress.percent}
                    size="compact"
                    testId="voice-list-loading-progress"
                  />
                ) : null}
              </div>
            ) : loadState.status === "error" ? (
              <div className="space-y-2">
                <p className="text-body text-muted">
                  {t("settings.loadErrorFallback")}
                </p>
                <Button onClick={loadVoices} variant="secondary">
                  <RefreshCw aria-hidden="true" className="size-4" />
                  {t("settings.retry")}
                </Button>
              </div>
            ) : loadState.data.voices.length === 0 ? (
              <p className="text-body text-muted">
                {t("settings.emptyVoices")}
              </p>
            ) : (
              <div
                aria-labelledby="voice-choice-heading"
                className="max-h-[min(24dvh,220px)] divide-y divide-border overflow-y-auto overscroll-contain rounded-control border border-border bg-white p-1"
                role="radiogroup"
              >
                {filteredVoices.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted">
                    {t("settings.emptyFiltered")}
                  </p>
                ) : null}
                {filteredVoices.map((voice) => {
                  const selected = voice.voice_id === selectedVoiceId;
                  const cachedVoiceIds =
                    loadState.status === "ready"
                      ? loadState.data.cached_voice_ids !== undefined
                        ? loadState.data.cached_voice_ids
                        : defaultVoiceId
                          ? [defaultVoiceId]
                          : []
                      : [];
                  const isLocalWorkerOffline = voiceHealth
                    ? !voiceHealth.local.available
                    : loadState.status === "ready" &&
                      loadState.data.local_worker_ready === false;
                  const isCachedOffline =
                    isLocalWorkerOffline &&
                    cachedVoiceIds.includes(voice.voice_id);
                  return (
                    <label
                      key={voice.voice_id}
                      className={cn(
                        "flex min-h-12 cursor-pointer items-center gap-3 px-3 py-2",
                        selected ? "bg-sky" : "bg-white hover:bg-cream",
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5 break-words text-sm font-bold text-ink">
                          <span>{voiceTitle(voice)}</span>
                          {isCachedOffline ? (
                            <span
                              className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-800"
                              data-testid={`voice-wifi-ready-badge-${voice.voice_id}`}
                            >
                              {t("settings.wifiReadyBadge")}
                            </span>
                          ) : null}
                        </span>
                        {voiceDetails(voice, t) ? (
                          <span className="block break-words text-sm text-muted">
                            {voiceDetails(voice, t)}
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
            !detectBrowserWasmTtsSupport().supported &&
            !(
              policy.providerMode === "local_with_google_fallback" &&
              ((policy.allowGoogleTtsFallback &&
                voiceHealth?.elevenlabs?.tts_configured) ||
                (policy.allowGoogleSttFallback &&
                  voiceHealth?.elevenlabs?.stt_configured))
            ) &&
            (isPermanentlyHostedLocalUnconfigured(voiceHealth) ||
              (voiceHealth
                ? !voiceHealth.local.available
                : loadState.data.local_worker_ready === false))
              ? (() => {
                  const cachedIds =
                    loadState.data.cached_voice_ids !== undefined
                      ? loadState.data.cached_voice_ids
                      : defaultVoiceId
                        ? [defaultVoiceId]
                        : [];
                  const cachedNames = loadState.data.voices
                    .filter((v) => cachedIds.includes(v.voice_id))
                    .map((v) => voiceTitle(v));
                  return (
                    <p
                      className="rounded-control border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs leading-relaxed text-amber-950"
                      data-testid="voice-offline-cache-notice"
                    >
                      {cachedNames.length > 1
                        ? t("settings.offlineCacheMultiple", {
                            voices: cachedNames.join(", "),
                          })
                        : cachedNames.length === 1
                          ? t("settings.offlineCacheSingle", {
                              voice: cachedNames[0],
                            })
                          : t("settings.offlineCacheEmpty")}
                    </p>
                  );
                })()
              : null}
          </section>

          <section
            aria-labelledby="voice-provider-policy-heading"
            className="space-y-2.5 rounded-control border border-border bg-white p-3"
          >
            <h3
              className="text-label font-semibold text-ink"
              id="voice-provider-policy-heading"
            >
              {t("settings.parentModeTitle")}
            </h3>
            <VoiceEngineBadge testIdPrefix="voice-modal-engine" />
            {voiceHealth ? (
              <div
                data-testid="voice-health-status-pills"
                className="flex flex-wrap items-center gap-1.5 text-[11px] font-semibold"
              >
                {voiceHealth.elevenlabs?.tts_configured ||
                voiceHealth.elevenlabs?.stt_configured ? (
                  <span
                    className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-emerald-900"
                    data-testid="voice-health-elevenlabs-pill"
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full bg-emerald-500"
                      aria-hidden="true"
                    />
                    ElevenLabs Cloud: {t("settings.localAvailable")}
                  </span>
                ) : null}
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5",
                    voiceHealth.local.available
                      ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                      : voiceHealth.elevenlabs?.tts_configured ||
                          voiceHealth.elevenlabs?.stt_configured
                        ? "border-slate-200 bg-slate-50 text-slate-700"
                        : "border-rose-200 bg-rose-50 text-rose-900",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 rounded-full",
                      voiceHealth.local.available
                        ? "bg-emerald-500"
                        : voiceHealth.elevenlabs?.tts_configured ||
                            voiceHealth.elevenlabs?.stt_configured
                          ? "bg-slate-400"
                          : "bg-rose-500",
                    )}
                    aria-hidden="true"
                  />
                  {t("settings.localWorkerLabel")}{" "}
                  {voiceHealth.local.available
                    ? t("settings.localAvailable")
                    : t("settings.localUnavailable")}
                </span>
                {!(
                  voiceHealth.elevenlabs?.tts_configured ||
                  voiceHealth.elevenlabs?.stt_configured
                ) ||
                voiceHealth.google.stt_configured ||
                voiceHealth.google.tts_configured ? (
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
                      ? t("settings.googleConfigured")
                      : t("settings.googleUnconfigured")}
                  </span>
                ) : null}
              </div>
            ) : null}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <button
                aria-pressed={policy.providerMode === "local_only"}
                className={cn(
                  "rounded-control border-2 px-3 py-2 text-start text-xs font-bold transition",
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
                {t("settings.localOnlyTitle")}
                <span
                  className={cn(
                    "mt-0.5 block font-normal",
                    policy.providerMode === "local_only"
                      ? "text-white/90"
                      : "text-muted",
                  )}
                >
                  {t("settings.localOnlyDesc")}
                </span>
              </button>
              <button
                aria-pressed={
                  policy.providerMode === "local_with_google_fallback"
                }
                className={cn(
                  "rounded-control border-2 px-3 py-2 text-start text-xs font-bold transition",
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
                {t("settings.localWithGoogleTitle")}
                <span
                  className={cn(
                    "mt-0.5 block font-normal",
                    policy.providerMode === "local_with_google_fallback"
                      ? "text-white/90"
                      : "text-muted",
                  )}
                >
                  {t("settings.localWithGoogleDesc")}
                </span>
              </button>
            </div>

            {policy.providerMode === "local_with_google_fallback" ? (
              <div className="space-y-2 rounded-lg bg-cream/70 p-2.5 text-xs">
                <label className="flex cursor-pointer items-center justify-between gap-2 font-medium text-ink">
                  <span>{t("settings.googleSttFallback")}</span>
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
                  <span>{t("settings.googleTtsFallback")}</span>
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
                    {t("settings.missingGoogleKeyHint")}
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
