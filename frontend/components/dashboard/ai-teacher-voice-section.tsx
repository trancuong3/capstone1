"use client";

import { Check, Sparkles, Square, UserRound, Volume2 } from "lucide-react";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "@/components/common/button";
import { AppServicesContext } from "@/components/providers/app-services-provider";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import { useSpeechPreferences } from "@/hooks/use-speech-preferences";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import { createChildService } from "@/lib/api/child-service";
import {
  createVoiceStudioService,
  type VoiceOption,
} from "@/lib/api/voice-studio-service";
import {
  applyGlobalTeacherVoiceSelection,
  getDefaultVoiceIdForRegionAndGender,
  getDefaultVoicePolicyPreferences,
  getEffectiveVoiceId,
  getVoicePolicyPreferences,
  GOOGLE_TTS_MODEL_VERSION,
  inferRegionFromVoiceId,
  setVoicePolicyPreferences,
  STATIC_LOCAL_VOICES,
  subscribeVoiceLock,
  subscribeVoicePolicy,
  type VoiceProviderMode,
  type VoiceRegion,
} from "@/lib/reading/session-voice-lock";
import {
  clampSpeed,
  getSpeechPreferences,
  SPEED_MAX,
  SPEED_MIN,
  SPEED_STEP,
} from "@/lib/reading/speech-preferences";
import {
  getCachedVoiceEngineHealth,
  subscribeVoiceEngineHealth,
} from "@/lib/reading/voice-engine-status";
import {
  adaptTextToTeacherPersona,
  resolveVoiceGender,
  type VoiceGender,
} from "@/lib/reading/voice-persona";
import { warmWasmTtsIfNeeded } from "@/lib/reading/voice-preloader";
import { cn } from "@/lib/utils/cn";
import type { ChildProfileDTO } from "@/types/child";

export interface AiTeacherVoiceSectionProps {
  readonly selectedChild?: ChildProfileDTO | null;
  readonly onChildSettingsUpdated?: (updated: ChildProfileDTO) => void;
}

const REGIONS: readonly {
  readonly id: VoiceRegion;
  readonly labelKey: string;
}[] = [
  { id: "north", labelKey: "settings.regions.north" },
  { id: "central", labelKey: "settings.regions.central" },
  { id: "south", labelKey: "settings.regions.south" },
];

const TEACHER_VOICE_PREVIEW_BASE_TEXT =
  "Chào con, hôm nay cô trò mình cùng đọc sách bài Hai mươi mốt bông hoa nhé.";

const SPEED_PRESETS = [
  { labelKey: "preferences.slow", value: 0.85 },
  { labelKey: "preferences.normal", value: 1.0 },
  { labelKey: "preferences.fast", value: 1.15 },
] as const;

const STATIC_GOOGLE_BACKUP_VOICES: readonly VoiceOption[] = [
  {
    voice_id: "google_vi_vn_neural2_a",
    name: "Google Nữ Miền Bắc",
    provider: "google",
    region: "north",
    region_label: "Miền Bắc",
    model_version: GOOGLE_TTS_MODEL_VERSION,
    category: "google_backup",
    gender: "female",
    accent: "Miền Bắc",
    use_case: "reading_coach",
    description: "Google dự phòng · Nữ",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "google_vi_vn_neural2_d",
    name: "Google Nam Miền Bắc",
    provider: "google",
    region: "north",
    region_label: "Miền Bắc",
    model_version: GOOGLE_TTS_MODEL_VERSION,
    category: "google_backup",
    gender: "male",
    accent: "Miền Bắc",
    use_case: "reading_coach",
    description: "Google dự phòng · Nam",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "google_vi_vn_wavenet_c",
    name: "Google Nữ Miền Nam",
    provider: "google",
    region: "south",
    region_label: "Miền Nam",
    model_version: GOOGLE_TTS_MODEL_VERSION,
    category: "google_backup",
    gender: "female",
    accent: "Miền Nam",
    use_case: "reading_coach",
    description: "Google dự phòng · Nữ",
    preview_url: null,
    is_default: false,
  },
  {
    voice_id: "google_vi_vn_wavenet_b",
    name: "Google Nam Miền Nam",
    provider: "google",
    region: "south",
    region_label: "Miền Nam",
    model_version: GOOGLE_TTS_MODEL_VERSION,
    category: "google_backup",
    gender: "male",
    accent: "Miền Nam",
    use_case: "reading_coach",
    description: "Google dự phòng · Nam",
    preview_url: null,
    is_default: false,
  },
];

function resolveOptionRegion(voice: VoiceOption): VoiceRegion {
  if (
    voice.region === "north" ||
    voice.region === "central" ||
    voice.region === "south"
  ) {
    return voice.region;
  }
  return inferRegionFromVoiceId(voice.voice_id, "north");
}

function cleanVoiceName(voice: VoiceOption | undefined): string {
  if (!voice) return "";
  return voice.name.split(" - ")[0]?.trim() || voice.name;
}

function TeacherAvatar({ gender }: { readonly gender: VoiceGender }) {
  if (gender === "male") {
    return (
      <div
        aria-hidden="true"
        className="grid size-14 shrink-0 place-items-center rounded-2xl border border-teal-200 bg-gradient-to-br from-sky via-emerald-50 to-teal-100 shadow-2xs"
      >
        <svg className="size-11" viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="18" r="9.5" fill="#FDE1C3" />
          <path
            d="M14.5 16.5C15 10.5 19.2 7.5 24.4 7.5C29.8 7.5 33.4 10.7 33.6 16.5C31.8 13.6 28.4 12.2 24 12.2C19.8 12.2 16.6 13.7 14.5 16.5Z"
            fill="#1F3A3D"
          />
          <circle cx="20.7" cy="18.2" r="1.3" fill="#1F2937" />
          <circle cx="27.3" cy="18.2" r="1.3" fill="#1F2937" />
          <path
            d="M20.8 22.3C22.1 23.6 25.9 23.6 27.2 22.3"
            stroke="#9A5B36"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
          <path
            d="M10.5 40.5C11.4 32.8 16.5 29.2 24 29.2C31.5 29.2 36.6 32.8 37.5 40.5H10.5Z"
            fill="#087467"
          />
          <path d="M21 29.4L24 35.5L27 29.4" fill="#E6F7F1" />
          <path d="M23 32.2L24 38.5L25 32.2Z" fill="#0F4C45" />
        </svg>
      </div>
    );
  }

  return (
    <div
      aria-hidden="true"
      className="grid size-14 shrink-0 place-items-center rounded-2xl border border-amber-200 bg-gradient-to-br from-amber-50 via-rose-50 to-cream shadow-2xs"
    >
      <svg className="size-11" viewBox="0 0 48 48" fill="none">
        <path
          d="M12.5 24C12.5 12.8 17.2 7.5 24 7.5C30.8 7.5 35.5 12.8 35.5 24V28.5C35.5 30.2 33.8 31.2 32.2 30.8L15.8 30.8C14.2 31.2 12.5 30.2 12.5 28.5V24Z"
          fill="#4A2C2A"
        />
        <circle cx="24" cy="19" r="9.2" fill="#FDE1C3" />
        <path
          d="M15 16.5C16.8 12.6 20.4 11 24.5 11.4C28.4 11.8 31.5 13.7 33 16.8C30.2 15.2 26.8 14.3 23.6 14.3C20.2 14.3 17.2 15.1 15 16.5Z"
          fill="#4A2C2A"
        />
        <circle cx="20.7" cy="19.1" r="1.3" fill="#1F2937" />
        <circle cx="27.3" cy="19.1" r="1.3" fill="#1F2937" />
        <path
          d="M21 23C22.3 24.2 25.7 24.2 27 23"
          stroke="#B45309"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M10.5 40.5C11.4 33 16.6 29.4 24 29.4C31.4 29.4 36.6 33 37.5 40.5H10.5Z"
          fill="#0F8B7B"
        />
        <path
          d="M19.5 29.6C21.2 32.2 26.8 32.2 28.5 29.6"
          stroke="#FEF3C7"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>
    </div>
  );
}

export function AiTeacherVoiceSection({
  selectedChild = null,
  onChildSettingsUpdated,
}: AiTeacherVoiceSectionProps) {
  const { formatNumber } = useI18n();
  const tParent = useTranslations("parent");
  const tSpeech = useTranslations("speech");
  const appServices = useContext(AppServicesContext);
  const childService = useMemo(
    () => appServices?.childService ?? createChildService(),
    [appServices?.childService],
  );
  const voiceStudio = useMemo(() => createVoiceStudioService(), []);
  const speechPlayer = useSpeechPlayer();
  const { preferences } = useSpeechPreferences();
  const teacherPersona = useTeacherPersona();
  const policy = useSyncExternalStore(
    subscribeVoicePolicy,
    getVoicePolicyPreferences,
    getDefaultVoicePolicyPreferences,
  );
  const effectiveVoiceId = useSyncExternalStore(
    subscribeVoiceLock,
    getEffectiveVoiceId,
    () => STATIC_LOCAL_VOICES[0].voice_id,
  );

  const voiceHealth = useSyncExternalStore(
    subscribeVoiceEngineHealth,
    getCachedVoiceEngineHealth,
    () => null,
  );

  const [remoteVoices, setRemoteVoices] = useState<
    readonly VoiceOption[] | null
  >(null);
  const [localWorkerReady, setLocalWorkerReady] = useState<boolean | null>(
    null,
  );
  const googleBackupEnabled =
    policy.providerMode === "local_with_google_fallback" &&
    policy.allowGoogleTtsFallback;
  const mountedRef = useRef(true);
  const previewGenRef = useRef(0);
  const persistSeqRef = useRef(0);
  const speechPlayerRef = useRef(speechPlayer);

  useEffect(() => {
    speechPlayerRef.current = speechPlayer;
  }, [speechPlayer]);

  useEffect(() => {
    mountedRef.current = true;
    if (
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      typeof window.speechSynthesis?.getVoices === "function"
    ) {
      try {
        window.speechSynthesis.getVoices();
      } catch {
        // Best-effort browser voice list warmup
      }
    }
    return () => {
      mountedRef.current = false;
      speechPlayerRef.current.stop();
    };
  }, []);

  useEffect(() => {
    if (
      typeof voiceStudio.listVoices !== "function" ||
      (process.env.NODE_ENV === "test" && !("mock" in voiceStudio.listVoices))
    ) {
      return;
    }
    const controller = new AbortController();
    void voiceStudio
      .listVoices(controller.signal)
      .then((res) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        if (res.voices.length > 0) {
          setRemoteVoices(res.voices);
        }
        if (typeof res.local_worker_ready === "boolean") {
          setLocalWorkerReady(res.local_worker_ready);
        }
      })
      .catch(() => {
        // Fallback smoothly to static 8-voice catalog (plus Google backups when enabled).
      });
    return () => {
      controller.abort();
    };
  }, [voiceStudio, googleBackupEnabled]);

  const voices: readonly VoiceOption[] = useMemo(() => {
    if (remoteVoices && remoteVoices.length > 0) {
      return googleBackupEnabled
        ? remoteVoices
        : remoteVoices.filter((v) => v.provider !== "google");
    }
    return googleBackupEnabled
      ? [...STATIC_LOCAL_VOICES, ...STATIC_GOOGLE_BACKUP_VOICES]
      : STATIC_LOCAL_VOICES;
  }, [remoteVoices, googleBackupEnabled]);
  const [previewError, setPreviewError] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const activeGender: VoiceGender = teacherPersona.gender;
  const activeVoiceId = preferences.voiceId ?? effectiveVoiceId;
  const activeRegion: VoiceRegion = inferRegionFromVoiceId(
    activeVoiceId,
    policy.region,
  );

  useEffect(() => {
    if (speechPlayer.state !== "completed" && speechPlayer.state !== "error") {
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setIsPreviewing(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [speechPlayer.state]);

  const persistChildVoice = useCallback(
    async (
      childId: string,
      payload: {
        readonly voice_id: string;
        readonly gender: VoiceGender;
        readonly region: VoiceRegion;
        readonly speed: number;
        readonly updated_at: number;
      },
    ) => {
      if (typeof childService.updateVoicePreferences !== "function") return;
      const seq = ++persistSeqRef.current;
      try {
        const updated = await childService.updateVoicePreferences(
          childId,
          payload,
        );
        if (mountedRef.current && seq === persistSeqRef.current) {
          onChildSettingsUpdated?.(updated);
        }
      } catch {
        // Offline/transient failure: local preference remains active without blocking UX.
      }
    },
    [childService, onChildSettingsUpdated],
  );

  const stopPreview = useCallback(() => {
    previewGenRef.current += 1;
    speechPlayer.stop();
    setIsPreviewing(false);
    setPreviewError(false);
  }, [speechPlayer]);

  const applySelection = useCallback(
    (input: {
      readonly voiceId?: string | null;
      readonly gender?: VoiceGender;
      readonly region?: VoiceRegion;
      readonly speed?: number;
      readonly modelVersion?: string;
    }) => {
      stopPreview();
      const applied = applyGlobalTeacherVoiceSelection({
        ...input,
        childId: selectedChild?.id ?? null,
        persistToBackend: selectedChild?.id ? persistChildVoice : undefined,
        syncActiveServerSessionLock:
          typeof voiceStudio.updateSessionVoiceLock === "function"
            ? (lockInput) => voiceStudio.updateSessionVoiceLock!(lockInput)
            : undefined,
      });
      const nextGender =
        input.gender ??
        resolveVoiceGender(
          applied?.voiceId ?? input.voiceId ?? effectiveVoiceId,
        );
      void warmWasmTtsIfNeeded(nextGender);
    },
    [
      effectiveVoiceId,
      persistChildVoice,
      selectedChild?.id,
      stopPreview,
      voiceStudio,
    ],
  );

  const findPreferredVoice = useCallback(
    (gender: VoiceGender, region: VoiceRegion): VoiceOption | undefined => {
      const sameRegionSameGender = voices.filter(
        (v) =>
          resolveOptionRegion(v) === region &&
          resolveVoiceGender(v.voice_id, v.gender) === gender,
      );
      if (sameRegionSameGender.length > 0) {
        const defaultForPair = getDefaultVoiceIdForRegionAndGender(
          region,
          gender,
        );
        return (
          sameRegionSameGender.find((v) => v.voice_id === defaultForPair) ??
          sameRegionSameGender[0]
        );
      }
      return voices.find(
        (v) => resolveVoiceGender(v.voice_id, v.gender) === gender,
      );
    },
    [voices],
  );

  const startPreviewPlayback = useCallback(
    (genderOverride?: VoiceGender) => {
      const gen = ++previewGenRef.current;
      setPreviewError(false);
      setIsPreviewing(true);
      const targetGender = genderOverride ?? activeGender;
      const greeting = adaptTextToTeacherPersona(
        TEACHER_VOICE_PREVIEW_BASE_TEXT,
        targetGender,
      );

      void speechPlayer
        .play(greeting, {
          coaching: true,
          cacheScope: "COACHING",
          bypassSessionLock: true,
          utteranceKind: "voice_preview",
          onEnded: () => {
            if (mountedRef.current && gen === previewGenRef.current) {
              setIsPreviewing(false);
            }
          },
        })
        .catch((error: unknown) => {
          const isAbortError =
            typeof error === "object" &&
            error !== null &&
            "name" in error &&
            (error as { name?: unknown }).name === "AbortError";
          if (
            mountedRef.current &&
            gen === previewGenRef.current &&
            !isAbortError
          ) {
            setPreviewError(true);
          }
        })
        .finally(() => {
          if (mountedRef.current && gen === previewGenRef.current) {
            setIsPreviewing(false);
          }
        });
    },
    [activeGender, speechPlayer],
  );

  const handleSelectTeacherGender = (nextGender: VoiceGender) => {
    if (nextGender !== activeGender) {
      const picked = findPreferredVoice(nextGender, activeRegion);
      applySelection({
        gender: nextGender,
        region: activeRegion,
        voiceId:
          picked?.voice_id ??
          getDefaultVoiceIdForRegionAndGender(activeRegion, nextGender),
        modelVersion: picked?.model_version ?? undefined,
      });
    } else {
      stopPreview();
    }
    startPreviewPlayback(nextGender);
  };

  const handleSelectRegion = (nextRegion: VoiceRegion) => {
    if (nextRegion !== activeRegion) {
      const picked = findPreferredVoice(activeGender, nextRegion);
      applySelection({
        gender: activeGender,
        region: nextRegion,
        voiceId:
          picked?.voice_id ??
          getDefaultVoiceIdForRegionAndGender(nextRegion, activeGender),
        modelVersion: picked?.model_version ?? undefined,
      });
    } else {
      stopPreview();
    }
    startPreviewPlayback(activeGender);
  };

  const handleSelectVoice = (voice: VoiceOption) => {
    const voiceGender = resolveVoiceGender(voice.voice_id, voice.gender);
    applySelection({
      voiceId: voice.voice_id,
      gender: voiceGender,
      region: resolveOptionRegion(voice),
      modelVersion: voice.model_version ?? undefined,
    });
    startPreviewPlayback(voiceGender);
  };

  const handleSelectSpeed = (speed: number) => {
    applySelection({ speed: clampSpeed(speed) });
  };

  const handleSelectProviderMode = (nextMode: VoiceProviderMode) => {
    stopPreview();
    const updated =
      nextMode === "local_only"
        ? setVoicePolicyPreferences({
            providerMode: "local_only",
            allowGoogleSttFallback: false,
            allowGoogleTtsFallback: false,
          })
        : setVoicePolicyPreferences({
            providerMode: "local_with_google_fallback",
            allowGoogleSttFallback: true,
            allowGoogleTtsFallback: true,
          });

    const currentVoiceId = getSpeechPreferences().voiceId;
    if (
      currentVoiceId?.startsWith("google_") &&
      (updated.providerMode !== "local_with_google_fallback" ||
        !updated.allowGoogleTtsFallback)
    ) {
      const preservedGender = resolveVoiceGender(currentVoiceId);
      const fallbackLocal = getDefaultVoiceIdForRegionAndGender(
        updated.region,
        preservedGender,
      );
      applyGlobalTeacherVoiceSelection({
        voiceId: fallbackLocal,
        storedVoiceId:
          fallbackLocal === "local_north_truc_ly" ? null : fallbackLocal,
        gender: preservedGender,
        region: updated.region,
        childId: selectedChild?.id ?? null,
        persistToBackend: selectedChild?.id ? persistChildVoice : undefined,
        syncActiveServerSessionLock:
          typeof voiceStudio.updateSessionVoiceLock === "function"
            ? (lockInput) => voiceStudio.updateSessionVoiceLock!(lockInput)
            : undefined,
      });
    }
  };

  const isLocalWorkerOffline =
    localWorkerReady !== null
      ? !localWorkerReady
      : voiceHealth !== null &&
        (!voiceHealth.local.available || !voiceHealth.local.tts_ready);

  const exactVoicesForGenderAndRegion = voices.filter(
    (v) =>
      resolveVoiceGender(v.voice_id, v.gender) === activeGender &&
      resolveOptionRegion(v) === activeRegion,
  );
  const voicesForCurrentGenderAndRegion =
    exactVoicesForGenderAndRegion.length > 0
      ? exactVoicesForGenderAndRegion
      : voices.filter(
          (v) => resolveVoiceGender(v.voice_id, v.gender) === activeGender,
        );

  const currentVoice =
    voices.find((v) => v.voice_id === activeVoiceId) ??
    findPreferredVoice(activeGender, activeRegion);

  const femalePreviewVoice =
    activeGender === "female"
      ? currentVoice
      : findPreferredVoice("female", activeRegion);
  const malePreviewVoice =
    activeGender === "male"
      ? currentVoice
      : findPreferredVoice("male", activeRegion);

  const isPreviewActive =
    isPreviewing ||
    speechPlayer.state === "loading" ||
    speechPlayer.state === "playing" ||
    speechPlayer.state === "fallback";

  const handlePreviewToggle = () => {
    if (isPreviewActive) {
      stopPreview();
      return;
    }
    startPreviewPlayback(activeGender);
  };

  const formatSpeed = (speed: number): string =>
    `${formatNumber(speed, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;

  const regionLabel = tSpeech(`settings.regions.${activeRegion}`);

  return (
    <section
      aria-labelledby="ai-teacher-voice-heading"
      className="mt-6 rounded-card border border-border bg-white/95 p-5 shadow-xs sm:p-6"
      data-testid="ai-teacher-voice-section"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary-hover">
              <Sparkles aria-hidden="true" className="size-3.5" />
              {tParent("teacherVoice.eyebrow")}
            </span>
            {selectedChild ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-900"
                data-testid="teacher-voice-child-badge"
              >
                <UserRound aria-hidden="true" className="size-3" />
                {tParent("teacherVoice.savedForChild", {
                  alias: selectedChild.alias,
                })}
              </span>
            ) : null}
          </div>
          <h2
            className="mt-1.5 text-xl font-extrabold text-ink sm:text-2xl"
            id="ai-teacher-voice-heading"
          >
            {tParent("teacherVoice.title")}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {tParent("teacherVoice.subtitle")}
          </p>
        </div>

        <Button
          className="min-h-12 w-full shrink-0 sm:w-auto"
          data-testid="teacher-voice-preview-btn"
          fullWidth={false}
          onClick={handlePreviewToggle}
          size="compact"
          type="button"
          variant={isPreviewActive ? "secondary" : "primary"}
        >
          {isPreviewActive ? (
            <>
              <Square aria-hidden="true" className="size-4" />
              {tParent("teacherVoice.stopPreviewButton")}
            </>
          ) : (
            <>
              <Volume2 aria-hidden="true" className="size-4" />
              {tParent("teacherVoice.previewButton")}
            </>
          )}
        </Button>
      </div>

      {/* 2 Prominent Side-by-Side Persona Cards */}
      <div
        aria-label={tParent("teacherVoice.personaGroupAria")}
        className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2"
        role="radiogroup"
      >
        {(
          [
            {
              gender: "female" as const,
              title: tParent("teacherVoice.femaleTitle"),
              desc: tParent("teacherVoice.femaleDesc"),
              mappedVoice: cleanVoiceName(femalePreviewVoice) || "Cô Trúc Ly",
            },
            {
              gender: "male" as const,
              title: tParent("teacherVoice.maleTitle"),
              desc: tParent("teacherVoice.maleDesc"),
              mappedVoice:
                cleanVoiceName(malePreviewVoice) || "Thầy Thiện Minh",
            },
          ] as const
        ).map((card) => {
          const isSelected = activeGender === card.gender;
          return (
            <button
              aria-checked={isSelected}
              className={cn(
                "flex min-h-20 w-full items-center gap-3.5 rounded-card border-2 p-4 text-start transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                isSelected
                  ? "border-primary bg-sky/70 shadow-xs"
                  : "border-border bg-cream/60 hover:border-primary/50 hover:bg-cream",
              )}
              data-testid={`teacher-card-${card.gender}`}
              key={card.gender}
              onClick={() => handleSelectTeacherGender(card.gender)}
              role="radio"
              type="button"
            >
              <TeacherAvatar gender={card.gender} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-extrabold text-ink sm:text-lg">
                    {card.title}
                  </span>
                  {isSelected ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-extrabold text-white">
                      <Check aria-hidden="true" className="size-3" />
                      {tParent("teacherVoice.selectedBadge")}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-xs text-muted sm:text-sm">
                  {card.desc}
                </p>
                <p className="mt-1 truncate text-xs font-bold text-primary-hover">
                  {card.mappedVoice} · {regionLabel}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Region, Specific Voice & Speed Strip */}
      <div className="mt-4 grid gap-4 rounded-control border border-border/80 bg-cream/55 p-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="space-y-3">
          <div>
            <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
              {tParent("teacherVoice.regionLabel")}
            </p>
            <div
              aria-label={tSpeech("settings.regionAria")}
              className="mt-1.5 flex flex-wrap gap-2"
              role="radiogroup"
            >
              {REGIONS.map((region) => {
                const active = activeRegion === region.id;
                return (
                  <button
                    aria-checked={active}
                    className={cn(
                      "min-h-11 rounded-control border px-3.5 py-1.5 text-sm font-bold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      active
                        ? "border-primary bg-primary text-white shadow-2xs"
                        : "border-border bg-white text-ink hover:border-primary/60",
                    )}
                    data-testid={`teacher-region-${region.id}`}
                    key={region.id}
                    onClick={() => handleSelectRegion(region.id)}
                    role="radio"
                    type="button"
                  >
                    {tSpeech(region.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
              {tParent("teacherVoice.voiceListLabel")}
            </p>
            <div
              aria-label={tParent("teacherVoice.voiceListAria")}
              className="mt-1.5 flex flex-wrap gap-2"
              role="radiogroup"
            >
              {voicesForCurrentGenderAndRegion.map((voice) => {
                const selected = voice.voice_id === activeVoiceId;
                return (
                  <button
                    aria-checked={selected}
                    className={cn(
                      "inline-flex min-h-11 items-center gap-1.5 rounded-control border px-3.5 py-1.5 text-sm font-bold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      selected
                        ? "border-primary bg-sky text-primary-hover"
                        : "border-border bg-white text-ink hover:border-primary/50",
                    )}
                    data-testid={`teacher-voice-option-${voice.voice_id}`}
                    key={voice.voice_id}
                    onClick={() => handleSelectVoice(voice)}
                    role="radio"
                    type="button"
                  >
                    {selected ? (
                      <Check
                        aria-hidden="true"
                        className="size-3.5 text-primary"
                      />
                    ) : null}
                    <span>{cleanVoiceName(voice)}</span>
                    {voice.provider === "google" ? (
                      <span className="rounded-full bg-amber-100 px-1.5 py-0.25 text-[10px] font-bold text-amber-900">
                        {tSpeech("settings.googleProviderLabel")}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-col justify-between gap-3 border-t border-border/70 pt-3 lg:border-t-0 lg:border-s lg:pt-0 lg:ps-4">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
                {tSpeech("settings.speedLabel")}
              </p>
              <span className="text-sm font-extrabold text-primary">
                {formatSpeed(preferences.speed)}
              </span>
            </div>
            <div
              aria-label={tSpeech("settings.speedLabel")}
              className="flex flex-wrap gap-2"
              role="radiogroup"
            >
              {SPEED_PRESETS.map((preset) => {
                const active =
                  Math.abs(preferences.speed - preset.value) < 0.001;
                return (
                  <button
                    aria-checked={active}
                    className={cn(
                      "min-h-10 rounded-control border px-3 py-1 text-xs font-bold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                      active
                        ? "border-primary bg-primary text-white"
                        : "border-border bg-white text-ink hover:border-primary/60",
                    )}
                    key={preset.value}
                    onClick={() => handleSelectSpeed(preset.value)}
                    role="radio"
                    type="button"
                  >
                    {tSpeech(preset.labelKey)} · {preset.value}×
                  </button>
                );
              })}
            </div>
            <input
              aria-label={tSpeech("settings.speedLabel")}
              aria-valuetext={formatSpeed(preferences.speed)}
              className="w-full accent-primary"
              max={SPEED_MAX}
              min={SPEED_MIN}
              onChange={(event) =>
                handleSelectSpeed(Number(event.target.value))
              }
              step={SPEED_STEP}
              type="range"
              value={preferences.speed}
            />
          </div>

          <div className="space-y-1.5 border-t border-border/60 pt-2.5">
            <p className="text-xs font-extrabold uppercase tracking-wide text-muted">
              {tParent("teacherVoice.policyLabel")}
            </p>
            <div
              aria-label={tParent("teacherVoice.policyAria")}
              className="flex flex-wrap gap-2"
              role="radiogroup"
            >
              <button
                aria-checked={!googleBackupEnabled}
                className={cn(
                  "min-h-10 rounded-control border px-3 py-1.5 text-xs font-bold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  !googleBackupEnabled
                    ? "border-primary bg-primary text-white shadow-2xs"
                    : "border-border bg-white text-ink hover:border-primary/60",
                )}
                data-testid="teacher-policy-local-only"
                onClick={() => handleSelectProviderMode("local_only")}
                role="radio"
                type="button"
              >
                {tParent("teacherVoice.policyLocalOnly")}
              </button>
              <button
                aria-checked={googleBackupEnabled}
                className={cn(
                  "min-h-10 rounded-control border px-3 py-1.5 text-xs font-bold transition focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  googleBackupEnabled
                    ? "border-primary bg-primary text-white shadow-2xs"
                    : "border-border bg-white text-ink hover:border-primary/60",
                )}
                data-testid="teacher-policy-online-backup"
                onClick={() =>
                  handleSelectProviderMode("local_with_google_fallback")
                }
                role="radio"
                type="button"
              >
                {tParent("teacherVoice.policyOnlineBackup")}
              </button>
            </div>
            {isLocalWorkerOffline && !googleBackupEnabled ? (
              <p
                className="rounded-control border border-amber-200 bg-amber-50/90 px-3 py-2 text-xs leading-relaxed text-amber-950"
                data-testid="teacher-voice-worker-offline-hint"
                role="status"
              >
                {tParent("teacherVoice.workerOfflineHint")}
              </p>
            ) : null}
          </div>

          {previewError ? (
            <p
              className="rounded-control bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-950"
              role="alert"
            >
              {tSpeech("settings.previewFailed")}
            </p>
          ) : speechPlayer.fallbackNotice ? (
            <p
              className="rounded-control bg-warning-surface px-3 py-2 text-xs font-medium text-ink"
              role="status"
            >
              {speechPlayer.fallbackNotice}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
