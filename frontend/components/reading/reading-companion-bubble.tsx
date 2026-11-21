import { BookOpenCheck, Heart, Sparkles, Volume2 } from "lucide-react";

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
}

const MOOD_STYLES: Readonly<
  Record<
    CompanionMood,
    {
      readonly card: string;
      readonly badge: string;
      readonly titleColor: string;
      readonly label: string;
    }
  >
> = {
  listening: {
    card: "border-primary/30 bg-sky/70",
    badge: "bg-primary text-white",
    titleColor: "text-primary",
    label: "Cô giáo đồng hành · Đang lắng nghe",
  },
  comforting: {
    card: "border-amber-300 bg-cream",
    badge: "bg-amber-500 text-white",
    titleColor: "text-amber-900",
    label: "Cô giáo dịu dàng · Đang khích lệ bé",
  },
  teaching: {
    card: "border-purple/60 bg-purple/40",
    badge: "bg-purple-ink text-white",
    titleColor: "text-purple-ink",
    label: "Cô giáo hướng dẫn · Cùng đánh vần nhé",
  },
  celebrating: {
    card: "border-emerald-300 bg-success-surface",
    badge: "bg-emerald-600 text-white",
    titleColor: "text-emerald-900",
    label: "Cô giáo khen bé · Giỏi quá!",
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

/**
 * Non-intrusive elementary-school teacher companion bubble (G27, G28).
 * Renders inside the reading flow's static feedback slot so it never covers
 * book words and never triggers layout shifts.
 */
export function ReadingCompanionBubble({
  state,
  isSpeaking = false,
}: ReadingCompanionBubbleProps) {
  const theme = MOOD_STYLES[state.mood];

  return (
    <div
      aria-live="polite"
      className={cn(
        "mx-auto flex min-h-16 w-full max-w-[1008px] items-center gap-3.5 rounded-card border px-4 py-3 transition-colors",
        theme.card,
      )}
      data-companion-mood={state.mood}
      data-testid="reading-companion-bubble"
      role="status"
    >
      <div
        aria-hidden="true"
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-full shadow-xs",
          theme.badge,
          isSpeaking && "ring-2 ring-offset-2 ring-primary/40",
        )}
      >
        <MoodIcon mood={state.mood} />
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("text-xs font-extrabold", theme.titleColor)}>
          {state.title || theme.label}
        </p>
        <p className="mt-0.5 text-sm leading-snug font-semibold text-ink sm:text-base">
          {state.message}
        </p>
      </div>
    </div>
  );
}
