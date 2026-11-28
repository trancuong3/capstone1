"use client";

import { BookOpenCheck, Heart, Sparkles, Volume2, X } from "lucide-react";

import { useTranslations } from "@/hooks/use-i18n";
import { useTeacherPersona } from "@/hooks/use-teacher-persona";
import {
  adaptTextToTeacherPersona,
  getTeacherPersona,
  type VoiceGender,
} from "@/lib/reading/voice-persona";
import { cn } from "@/lib/utils/cn";

export type CompanionMood =
  "listening" | "comforting" | "teaching" | "celebrating";

export interface CompanionBubbleState {
  readonly mood: CompanionMood;
  readonly title: string;
  readonly message: string;
}

interface ReadingCompanionBubbleProps {
  readonly state: CompanionBubbleState;
  readonly isSpeaking?: boolean;
  readonly gender?: VoiceGender;
  readonly onDismiss?: () => void;
}

const MOOD_STYLES: Readonly<
  Record<
    CompanionMood,
    {
      readonly card: string;
      readonly badge: string;
      readonly titleColor: string;
      readonly labelKeys: { readonly female: string; readonly male: string };
    }
  >
> = {
  listening: {
    card: "border-primary/30 bg-sky/70",
    badge: "bg-primary text-white",
    titleColor: "text-primary",
    labelKeys: {
      female: "companion.listeningFemale",
      male: "companion.listeningMale",
    },
  },
  comforting: {
    card: "border-amber-300 bg-cream",
    badge: "bg-amber-500 text-white",
    titleColor: "text-amber-900",
    labelKeys: {
      female: "companion.comfortingFemale",
      male: "companion.comfortingMale",
    },
  },
  teaching: {
    card: "border-purple/60 bg-purple/40",
    badge: "bg-purple-ink text-white",
    titleColor: "text-purple-ink",
    labelKeys: {
      female: "companion.teachingFemale",
      male: "companion.teachingMale",
    },
  },
  celebrating: {
    card: "border-emerald-300 bg-success-surface",
    badge: "bg-emerald-600 text-white",
    titleColor: "text-emerald-900",
    labelKeys: {
      female: "companion.celebratingFemale",
      male: "companion.celebratingMale",
    },
  },
};

function MoodIcon({ mood }: { readonly mood: CompanionMood }) {
  if (mood === "comforting") {
    return <Heart aria-hidden="true" className="size-5 fill-current" />;
  }
  if (mood === "teaching") {
    return <BookOpenCheck aria-hidden="true" className="size-5" />;
  }
  if (mood === "celebrating") {
    return <Sparkles aria-hidden="true" className="size-5" />;
  }
  return <Volume2 aria-hidden="true" className="size-5" />;
}

const QUOTED_BOOK_SEGMENT_RE = /(“[^”]*”|"[^"]*")/gu;

function adaptFramingPreservingQuotedText(
  text: string,
  gender: VoiceGender,
): string {
  if (gender !== "male" || !text) return text;
  if (!text.includes("“") && !text.includes('"')) {
    return adaptTextToTeacherPersona(text, gender);
  }
  return text
    .split(QUOTED_BOOK_SEGMENT_RE)
    .map((segment) => {
      if (
        (segment.startsWith("“") && segment.endsWith("”")) ||
        (segment.startsWith('"') && segment.endsWith('"'))
      ) {
        return segment;
      }
      return adaptTextToTeacherPersona(segment, gender);
    })
    .join("");
}

/**
 * Non-intrusive elementary-school teacher companion bubble (G27, G28).
 * Renders inside the reading flow's static feedback slot so it never covers
 * book words and never triggers layout shifts.
 */
export function ReadingCompanionBubble({
  state,
  isSpeaking = false,
  gender,
  onDismiss,
}: ReadingCompanionBubbleProps) {
  const t = useTranslations("reading");
  const activePersona = useTeacherPersona();
  const theme = MOOD_STYLES[state.mood];
  const persona = gender ? getTeacherPersona(gender) : activePersona;
  const localizedPersonaTitle = t(
    persona.gender === "male"
      ? "companion.teacherMaleTitle"
      : "companion.teacherFemaleTitle",
  );
  const fallbackLabel = t(
    persona.gender === "male" ? theme.labelKeys.male : theme.labelKeys.female,
  );
  const normalizedTitle = adaptFramingPreservingQuotedText(
    state.title || fallbackLabel,
    persona.gender,
  ).replace(/^(Cô giáo|Thầy giáo)(?!\s+AI)/u, localizedPersonaTitle);
  const displayTitle =
    normalizedTitle.includes(localizedPersonaTitle) ||
    normalizedTitle.includes(persona.title)
      ? normalizedTitle
      : `${localizedPersonaTitle} · ${normalizedTitle}`;
  const displayMessage = adaptFramingPreservingQuotedText(
    state.message,
    persona.gender,
  );

  return (
    <div
      aria-live="polite"
      className={cn(
        "mx-auto flex min-h-0 w-full max-w-[1008px] items-center gap-2 rounded-card border px-2.5 py-1.5 transition-colors sm:min-h-16 sm:gap-3.5 sm:px-4 sm:py-3",
        theme.card,
      )}
      data-companion-mood={state.mood}
      data-teacher-persona={persona.gender}
      data-testid="reading-companion-bubble"
      role="status"
    >
      <div
        aria-hidden="true"
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full shadow-xs sm:size-11",
          theme.badge,
          isSpeaking && "ring-2 ring-offset-2 ring-primary/40",
        )}
      >
        <MoodIcon mood={state.mood} />
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "truncate text-[11px] font-extrabold sm:text-xs",
            theme.titleColor,
          )}
        >
          {displayTitle}
        </p>
        <p className="mt-0.5 line-clamp-2 text-xs leading-snug font-semibold text-ink sm:line-clamp-none sm:text-base">
          {displayMessage}
        </p>
      </div>
      {onDismiss ? (
        <button
          aria-label={t("phonics.closeAria")}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-white/85 text-muted hover:bg-white hover:text-ink focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
          data-testid="dismiss-companion-bubble"
          onClick={onDismiss}
          type="button"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
