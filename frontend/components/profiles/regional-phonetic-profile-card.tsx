"use client";

import { CheckCircle2, Ear, Lock, ShieldCheck, Volume2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import {
  defaultRegionalPhoneticService,
  DIALECT_PREVIEW_SAMPLES,
  type AlignmentEvaluateDTO,
  type PhoneticProfile,
  type RegionalPhoneticService,
} from "@/lib/api/regional-phonetics-service";
import { cn } from "@/lib/utils/cn";
import {
  useRegionalDialectTranslations,
  type RegionalDialectMessageKey,
} from "@/messages/features/regional_dialect";

const PROFILE_OPTIONS: readonly {
  readonly value: PhoneticProfile;
  readonly labelKey: RegionalDialectMessageKey;
  readonly descKey: RegionalDialectMessageKey;
}[] = [
  {
    value: "STRICT_SGK",
    labelKey: "profileStrictSgk",
    descKey: "profileStrictSgkDesc",
  },
  {
    value: "NORTH_TOLERANT",
    labelKey: "profileNorthTolerant",
    descKey: "profileNorthTolerantDesc",
  },
  {
    value: "CENTRAL_TOLERANT",
    labelKey: "profileCentralTolerant",
    descKey: "profileCentralTolerantDesc",
  },
  {
    value: "SOUTH_TOLERANT",
    labelKey: "profileSouthTolerant",
    descKey: "profileSouthTolerantDesc",
  },
];

function formatAccuracyPct(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export interface RegionalPhoneticProfileCardProps {
  readonly childId: string;
  readonly childAlias?: string | null;
  readonly initialProfile?: PhoneticProfile;
  readonly service?: RegionalPhoneticService;
  readonly compact?: boolean;
  readonly className?: string;
  readonly onOpenEarTrainer?: () => void;
  readonly onProfileSaved?: (profile: PhoneticProfile) => void;
}

export function RegionalPhoneticProfileCard({
  childId,
  childAlias,
  initialProfile,
  service = defaultRegionalPhoneticService,
  compact = false,
  className,
  onOpenEarTrainer,
  onProfileSaved,
}: RegionalPhoneticProfileCardProps) {
  const t = useRegionalDialectTranslations();

  const [selectedProfile, setSelectedProfile] = useState<PhoneticProfile>(
    initialProfile ?? "STRICT_SGK",
  );
  const [savedProfile, setSavedProfile] = useState<PhoneticProfile>(
    initialProfile ?? "STRICT_SGK",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "error" | null>(null);
  const [livePreview, setLivePreview] = useState<AlignmentEvaluateDTO | null>(
    null,
  );

  const previewReqRef = useRef(0);

  useEffect(() => {
    if (initialProfile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedProfile(initialProfile);
      setSavedProfile(initialProfile);
      return;
    }
    if (!childId) return;

    let cancelled = false;
    void service
      .getProfile(childId)
      .then((dto) => {
        if (cancelled) return;
        setSelectedProfile(dto.phonetic_profile);
        setSavedProfile(dto.phonetic_profile);
      })
      .catch(() => {
        // Keep calm default STRICT_SGK if offline or unauthenticated in preview
      });

    return () => {
      cancelled = true;
    };
  }, [childId, initialProfile, service]);

  const activeSample = useMemo(
    () => DIALECT_PREVIEW_SAMPLES[selectedProfile],
    [selectedProfile],
  );

  useEffect(() => {
    if (!childId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLivePreview(null);
      return;
    }

    const seq = ++previewReqRef.current;
    setLivePreview(null);

    void service
      .evaluateAlignment(childId, {
        reference_text: activeSample.referenceText,
        spoken_text: activeSample.spokenText,
        phonetic_profile_override: selectedProfile,
      })
      .then((evaluated) => {
        if (previewReqRef.current === seq) {
          setLivePreview(evaluated);
        }
      })
      .catch(() => {
        if (previewReqRef.current === seq) {
          setLivePreview(null);
        }
      });
  }, [activeSample, childId, selectedProfile, service]);

  const displayedEvaluation = livePreview ?? activeSample.fallbackEvaluation;

  async function handleSaveProfile() {
    if (!childId || isSaving) return;
    setIsSaving(true);
    setSaveStatus(null);
    try {
      const updated = await service.updateProfile(childId, {
        phonetic_profile: selectedProfile,
      });
      setSelectedProfile(updated.phonetic_profile);
      setSavedProfile(updated.phonetic_profile);
      setSaveStatus("saved");
      onProfileSaved?.(updated.phonetic_profile);
    } catch {
      setSaveStatus("error");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section
      aria-label={t("profileCardTitle")}
      className={cn(
        "flex flex-col gap-4 rounded-card border border-amber-200/90 bg-gradient-to-br from-amber-50/60 via-white to-emerald-50/50 shadow-xs",
        compact ? "p-4 sm:p-5" : "p-5 sm:p-7",
        className,
      )}
      data-testid="regional-phonetic-profile-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-extrabold text-emerald-900">
              <Lock aria-hidden="true" className="size-3.5" />
              {t("privateBadge")}
            </span>
            {childAlias ? (
              <span className="rounded-full bg-white px-3 py-0.5 text-xs font-bold text-muted">
                {childAlias}
              </span>
            ) : null}
          </div>
          <h3
            className={cn(
              "font-extrabold text-ink",
              compact ? "text-lg" : "text-xl sm:text-2xl",
            )}
          >
            {t("profileCardTitle")}
          </h3>
          <p className="text-sm leading-relaxed text-muted">
            {t("profileCardSubtitle")}
          </p>
        </div>

        {onOpenEarTrainer ? (
          <Button
            className="min-h-11"
            data-testid="profile-card-open-ear-trainer-btn"
            fullWidth={false}
            onClick={onOpenEarTrainer}
            size="compact"
            type="button"
            variant="secondary"
          >
            <Ear aria-hidden="true" className="size-4 text-primary" />
            {t("openEarTrainerFromCard")}
          </Button>
        ) : null}
      </div>

      {/* 4 Regional Phonetic Profile Options */}
      <div
        aria-label={t("profileCardTitle")}
        className="grid gap-2.5 sm:grid-cols-2"
        role="radiogroup"
      >
        {PROFILE_OPTIONS.map((opt) => {
          const isSelected = selectedProfile === opt.value;
          return (
            <button
              aria-checked={isSelected}
              className={cn(
                "flex cursor-pointer flex-col items-start gap-1 rounded-2xl border p-3.5 text-left transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                isSelected
                  ? "border-primary bg-primary/8 shadow-xs"
                  : "border-border bg-white hover:border-primary/40 hover:bg-cream/50",
              )}
              data-testid={`phonetic-profile-option-${opt.value}`}
              key={opt.value}
              onClick={() => {
                setSelectedProfile(opt.value);
                setSaveStatus(null);
              }}
              role="radio"
              type="button"
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-extrabold text-ink">
                  {t(opt.labelKey)}
                </span>
                {savedProfile === opt.value ? (
                  <CheckCircle2
                    aria-hidden="true"
                    className="size-4 shrink-0 text-emerald-700"
                  />
                ) : null}
              </span>
              <span className="text-xs leading-relaxed text-muted">
                {t(opt.descKey)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Mandatory Dual-Score Fairness Preview (Strict SGK + Regional Tolerant Side-by-Side) */}
      <div
        className="space-y-3 rounded-2xl border border-emerald-200/80 bg-white/95 p-4"
        data-testid="dual-score-fairness-preview"
      >
        <div className="flex items-start gap-2">
          <ShieldCheck
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-emerald-700"
          />
          <div className="space-y-0.5">
            <p className="text-xs font-extrabold tracking-wide text-emerald-900 uppercase">
              {t("dualScoreHeading")}
            </p>
            <p className="text-xs leading-relaxed text-muted">
              {t("dualScoreInfo")}
            </p>
          </div>
        </div>

        <div className="grid gap-2.5 sm:grid-cols-2">
          <div
            className="rounded-xl border border-slate-200 bg-slate-50/90 p-3"
            data-testid="dual-score-strict-sgk"
          >
            <p className="text-xs font-bold text-muted">
              {t("dualScoreStrictLabel")}
            </p>
            <p className="mt-1 text-2xl font-extrabold text-ink">
              {formatAccuracyPct(displayedEvaluation.strict_sgk_accuracy)}
            </p>
          </div>

          <div
            className="rounded-xl border border-emerald-300 bg-emerald-50/80 p-3"
            data-testid="dual-score-regional-tolerant"
          >
            <p className="text-xs font-bold text-emerald-900">
              {t("dualScoreTolerLabel")}
            </p>
            <p className="mt-1 text-2xl font-extrabold text-emerald-800">
              {formatAccuracyPct(
                displayedEvaluation.regional_tolerant_accuracy,
              )}
            </p>
          </div>
        </div>

        <div className="space-y-1.5 text-xs text-ink">
          <p>
            <span className="font-bold text-muted">
              {t("previewReferenceLabel")}
            </span>{" "}
            <span
              className="viread-learning-content font-semibold"
              dir="ltr"
              lang="vi"
            >
              “{activeSample.referenceText}”
            </span>
          </p>
          <p>
            <span className="font-bold text-muted">
              {t("previewSpokenLabel")}
            </span>{" "}
            <span
              className="viread-learning-content font-semibold"
              dir="ltr"
              lang="vi"
            >
              “{activeSample.spokenText}”
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-bold text-emerald-900">
            {t("previewVariantsLabel")}
          </span>
          {displayedEvaluation.regional_variant_matches.length > 0 ? (
            displayedEvaluation.regional_variant_matches.map((match, idx) => (
              <span
                className="viread-learning-content inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 font-bold text-emerald-900"
                data-testid={`regional-variant-chip-${idx}`}
                dir="ltr"
                key={`${match.reference_word}-${match.spoken_word}-${idx}`}
                lang="vi"
              >
                <Volume2 aria-hidden="true" className="size-3" />
                {match.reference_word} ↔ {match.spoken_word}
              </span>
            ))
          ) : (
            <span className="text-muted">{t("previewNoVariants")}</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-bold text-amber-900">
            {t("previewTrueErrorsLabel")}
          </span>
          {displayedEvaluation.true_error_words.length > 0 ? (
            displayedEvaluation.true_error_words.map((errWord, idx) => (
              <span
                className="viread-learning-content rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 font-bold text-amber-950"
                data-testid={`true-error-chip-${errWord}-${idx}`}
                dir="ltr"
                key={`${errWord}-${idx}`}
                lang="vi"
              >
                {errWord}
              </span>
            ))
          ) : (
            <span className="text-muted">{t("previewNoTrueErrors")}</span>
          )}
        </div>
      </div>

      {saveStatus === "saved" ? (
        <StatusMessage tone="success">{t("savedProfile")}</StatusMessage>
      ) : null}
      {saveStatus === "error" ? (
        <StatusMessage tone="error">{t("profileSaveError")}</StatusMessage>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          className="min-h-12"
          data-testid="save-phonetic-profile-btn"
          disabled={!childId || isSaving}
          fullWidth={false}
          isLoading={isSaving}
          onClick={() => void handleSaveProfile()}
          size="compact"
          type="button"
        >
          {isSaving ? t("savingProfile") : t("saveProfile")}
        </Button>
      </div>
    </section>
  );
}
