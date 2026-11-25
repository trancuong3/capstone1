"use client";

import Image from "next/image";
import {
  ArrowRight,
  BookOpen,
  Brain,
  Coffee,
  HelpCircle,
  Music2,
  Sparkles,
  Volume2,
  VolumeX,
  Wind,
} from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

import { Button, ButtonLink } from "@/components/common/button";
import { ToyCannon } from "@/components/entertainment/sentence-shooter/toy-cannon";
import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import { createChildService } from "@/lib/api/child-service";
import { cn } from "@/lib/utils/cn";
import type {
  CrossGameRecommendationDTO,
  EntertainmentRecommendationsDTO,
  GameKey,
} from "@/types/adaptive-learning";

const ONBOARDING_STORAGE_KEY = "viread:entertainment-v4-onboarding-done";
const REDUCED_MOTION_STORAGE_KEY = "viread:entertainment-v4-reduced-motion";
const SOUND_MUTED_STORAGE_KEY = "viread:entertainment-v4-sound-muted";

interface Props {
  readonly initialRecommendations?: EntertainmentRecommendationsDTO | null;
}

function ViReadMascot({ reducedMotion }: { readonly reducedMotion: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative grid size-20 shrink-0 place-items-center rounded-3xl border-2 border-amber-200 bg-gradient-to-br from-amber-50 via-yellow-50 to-sky-100 shadow-sm",
        !reducedMotion && "transition-transform duration-300 hover:scale-105",
      )}
    >
      <svg className="size-16" viewBox="0 0 80 80" fill="none">
        <circle cx="40" cy="44" r="24" fill="#F59E0B" />
        <ellipse cx="40" cy="52" rx="15" ry="14" fill="#FEF3C7" />
        <polygon points="22,26 30,14 34,27" fill="#D97706" />
        <polygon points="58,26 50,14 46,27" fill="#D97706" />
        <circle cx="31" cy="39" r="7.5" fill="#FFFFFF" />
        <circle cx="49" cy="39" r="7.5" fill="#FFFFFF" />
        <circle cx="32" cy="39" r="3.8" fill="#1E293B" />
        <circle cx="48" cy="39" r="3.8" fill="#1E293B" />
        <circle cx="33.5" cy="37.5" r="1.3" fill="#FFFFFF" />
        <circle cx="49.5" cy="37.5" r="1.3" fill="#FFFFFF" />
        <polygon points="40,43 36,48 44,48" fill="#EA580C" />
        <path
          d="M28 57 Q40 65 52 57"
          stroke="#B45309"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="62" cy="18" r="5" fill="#FDE047" />
      </svg>
    </div>
  );
}

function MemoryPreviewIllustration() {
  return (
    <div
      aria-hidden="true"
      className="flex min-h-52 flex-col items-center justify-center gap-4 rounded-card bg-gradient-to-br from-emerald-50 via-teal-50 to-amber-50 p-6"
    >
      <svg
        className="h-32 w-full max-w-[260px]"
        viewBox="0 0 260 128"
        fill="none"
      >
        <rect
          x="8"
          y="8"
          width="244"
          height="112"
          rx="18"
          fill="#FFFFFF"
          stroke="#A7F3D0"
          strokeWidth="2"
        />
        <circle cx="52" cy="40" r="16" fill="#FCD34D" />
        <rect x="18" y="84" width="224" height="26" rx="10" fill="#D1FAE5" />
        <circle cx="105" cy="72" r="16" fill="#FB923C" />
        <polygon points="94,59 98,48 104,58" fill="#FB923C" />
        <polygon points="116,59 112,48 106,58" fill="#FB923C" />
        <circle cx="100" cy="70" r="2.2" fill="#1E293B" />
        <circle cx="110" cy="70" r="2.2" fill="#1E293B" />
        <path
          d="M168 44 L176 62 L195 62 L180 73 L185 91 L168 80 L151 91 L156 73 L141 62 L160 62 Z"
          fill="#F43F5E"
        />
        <rect x="202" y="56" width="24" height="30" rx="5" fill="#3B82F6" />
        <line
          x1="208"
          y1="65"
          x2="220"
          y2="65"
          stroke="#FFFFFF"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <line
          x1="208"
          y1="73"
          x2="220"
          y2="73"
          stroke="#FFFFFF"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
      <div className="flex flex-wrap justify-center gap-2 text-xs font-bold text-emerald-900">
        <span className="rounded-full bg-white/90 px-3 py-1 shadow-xs">
          Quan sát tranh
        </span>
        <span className="rounded-full bg-white/90 px-3 py-1 shadow-xs">
          Nhớ chi tiết
        </span>
        <span className="rounded-full bg-white/90 px-3 py-1 shadow-xs">
          Kể tiếp câu chuyện
        </span>
      </div>
    </div>
  );
}

const ONBOARDING_STEPS = [
  {
    title: "1. Chọn góc chơi bé thích",
    body: "Bốn góc chơi nhẹ nhàng: Kể chuyện tranh, Xạ thủ ghép câu, Hát vui cùng bé và Bé nhớ được gì?",
  },
  {
    title: "2. Chơi bằng giọng nói hoặc chạm",
    body: "Các nút bấm to rõ, dễ chạm trên điện thoại và máy tính bảng. Bé có thể nói hoặc chọn chữ đều được.",
  },
  {
    title: "3. Vui học không áp lực",
    body: "Mỗi phiên 10–15 phút là tuyệt nhất. Không tính giờ căng thẳng, luôn có Cô giáo AI và Cú Mèo cổ vũ bé!",
  },
] as const;

const emptySubscribe = () => () => {};

function readBrowserPref(reader: () => boolean): boolean {
  try {
    return reader();
  } catch {
    return false;
  }
}

export function EntertainmentScreen({
  initialRecommendations = null,
}: Props = {}) {
  const [recommendations, setRecommendations] =
    useState<EntertainmentRecommendationsDTO | null>(initialRecommendations);
  const storedShowOnboarding = useSyncExternalStore(
    emptySubscribe,
    () =>
      readBrowserPref(
        () => !window.localStorage.getItem(ONBOARDING_STORAGE_KEY),
      ),
    () => false,
  );
  const storedReducedMotion = useSyncExternalStore(
    emptySubscribe,
    () =>
      readBrowserPref(() => {
        const saved = window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY);
        if (saved === "true") return true;
        if (saved === "false") return false;
        return (
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
        );
      }),
    () => false,
  );
  const storedSoundMuted = useSyncExternalStore(
    emptySubscribe,
    () =>
      readBrowserPref(
        () => window.localStorage.getItem(SOUND_MUTED_STORAGE_KEY) === "true",
      ),
    () => false,
  );

  const [onboardingOverride, setOnboardingOverride] = useState<boolean | null>(
    null,
  );
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [motionOverride, setMotionOverride] = useState<boolean | null>(null);
  const [soundOverride, setSoundOverride] = useState<boolean | null>(null);

  const showOnboarding = onboardingOverride ?? storedShowOnboarding;
  const reducedMotion = motionOverride ?? storedReducedMotion;
  const soundMuted = soundOverride ?? storedSoundMuted;

  useEffect(() => {
    if (initialRecommendations) return;
    let active = true;
    async function loadAdaptiveRecommendations() {
      try {
        const children = await createChildService().list();
        if (!active || !children.length) return;
        const recs = await createAdaptiveLearningService().getRecommendations(
          children[0].id,
        );
        if (active) {
          setRecommendations(recs);
        }
      } catch {
        // Gracefully remain in calm static child-first hub when unauthenticated or offline.
      }
    }
    void loadAdaptiveRecommendations();
    return () => {
      active = false;
    };
  }, [initialRecommendations]);

  function finishOnboarding() {
    setOnboardingOverride(false);
    setOnboardingStep(0);
    try {
      window.localStorage.setItem(ONBOARDING_STORAGE_KEY, "1");
    } catch {
      // Ignore restricted storage.
    }
  }

  function toggleReducedMotion() {
    const next = !reducedMotion;
    setMotionOverride(next);
    try {
      window.localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, String(next));
    } catch {
      // Ignore restricted storage.
    }
  }

  function toggleSoundMuted() {
    const next = !soundMuted;
    setSoundOverride(next);
    try {
      window.localStorage.setItem(SOUND_MUTED_STORAGE_KEY, String(next));
    } catch {
      // Ignore restricted storage.
    }
  }

  const recommendationByGame = new Map<GameKey, CrossGameRecommendationDTO>(
    (recommendations?.recommendations ?? []).map((item) => [
      item.game_key,
      item,
    ]),
  );
  const primaryRec = recommendations?.primary_recommendation ?? null;

  return (
    <section
      className={cn(
        "activity-library mx-auto flex w-full max-w-[1140px] flex-col gap-5 pb-8",
        reducedMotion && "motion-reduce",
      )}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      data-sound-muted={soundMuted ? "true" : "false"}
    >
      <header className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold tracking-wide text-primary uppercase">
            Vui học tiếng Việt mỗi ngày
          </p>
          <h1 className="book-title mt-1 text-3xl text-ink sm:text-4xl">
            Giải trí
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            className="min-h-12 px-4"
            fullWidth={false}
            onClick={toggleSoundMuted}
            size="compact"
            type="button"
            variant="quiet"
          >
            {soundMuted ? (
              <VolumeX aria-hidden="true" className="size-4" />
            ) : (
              <Volume2 aria-hidden="true" className="size-4" />
            )}
            {soundMuted ? "Đang tắt tiếng" : "Âm thanh dịu"}
          </Button>
          <Button
            className="min-h-12 px-4"
            fullWidth={false}
            onClick={toggleReducedMotion}
            size="compact"
            type="button"
            variant="quiet"
          >
            <Wind aria-hidden="true" className="size-4" />
            {reducedMotion ? "Đã giảm chuyển động" : "Giảm chuyển động"}
          </Button>
          <Button
            className="min-h-12 px-4"
            fullWidth={false}
            onClick={() => {
              setOnboardingStep(0);
              setOnboardingOverride(!showOnboarding);
            }}
            size="compact"
            type="button"
            variant="secondary"
          >
            <HelpCircle aria-hidden="true" className="size-4" />
            Hướng dẫn chơi
          </Button>
        </div>
      </header>

      {/* Mascot Guide & Gentle Adaptive Recommendation */}
      <div className="flex flex-col gap-4 rounded-card border border-amber-200 bg-gradient-to-r from-amber-50/90 via-cream to-sky/60 p-5 sm:flex-row sm:items-center sm:p-6">
        <ViReadMascot reducedMotion={reducedMotion} />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1 text-xs font-extrabold text-amber-800 shadow-xs">
              <Sparkles aria-hidden="true" className="size-3.5" />
              Cú Mèo ViRead gợi ý
            </span>
            {recommendations ? (
              <span className="rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-muted">
                Hồ sơ {recommendations.child_alias} · Lớp{" "}
                {recommendations.child_grade}
              </span>
            ) : null}
          </div>
          <p className="text-lg font-extrabold text-ink">
            {recommendations?.mascot_greeting_vi ??
              "Chào bé yêu! Hôm nay bé muốn kể chuyện tranh, ghép câu, hát vui hay thử trí nhớ nào?"}
          </p>
          <p className="text-sm leading-6 text-muted">
            {primaryRec?.reason_vi ??
              "Mỗi trò chơi đều kết nối nhẹ nhàng với sách bé đang đọc để giúp bé nhớ từ lâu hơn mà không hề áp lực."}
          </p>
          {recommendations?.focus_difficult_words.length ? (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="text-xs font-bold text-ink">
                Từ bé đang ôn nhẹ:
              </span>
              {recommendations.focus_difficult_words.map((word) => (
                <span
                  className="rounded-full border border-amber-300 bg-white px-3 py-1 text-xs font-bold text-amber-900"
                  key={word}
                >
                  {word}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {primaryRec ? (
          <ButtonLink
            className="min-h-12 w-full shrink-0 sm:w-auto"
            href={primaryRec.href}
            size="compact"
          >
            Chơi gợi ý ngay <ArrowRight aria-hidden="true" className="size-4" />
          </ButtonLink>
        ) : null}
      </div>

      {/* Interactive First-Visit Onboarding (Calm, Zero Dark Patterns) */}
      {showOnboarding ? (
        <aside
          aria-label="Hướng dẫn làm quen khu vực Giải trí"
          className="rounded-card border border-primary/25 bg-white p-5 shadow-xs sm:p-6"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-extrabold tracking-wide text-primary uppercase">
                Hướng dẫn nhanh ({onboardingStep + 1}/{ONBOARDING_STEPS.length})
              </p>
              <h2 className="mt-1 text-xl font-extrabold text-ink">
                {ONBOARDING_STEPS[onboardingStep].title}
              </h2>
              <p className="mt-1 text-body text-muted">
                {ONBOARDING_STEPS[onboardingStep].body}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {onboardingStep < ONBOARDING_STEPS.length - 1 ? (
                <Button
                  className="min-h-12"
                  fullWidth={false}
                  onClick={() => setOnboardingStep((s) => s + 1)}
                  size="compact"
                  type="button"
                >
                  Tiếp theo
                </Button>
              ) : (
                <Button
                  className="min-h-12"
                  fullWidth={false}
                  onClick={finishOnboarding}
                  size="compact"
                  type="button"
                >
                  Bé đã hiểu rồi!
                </Button>
              )}
              <Button
                className="min-h-12"
                fullWidth={false}
                onClick={finishOnboarding}
                size="compact"
                type="button"
                variant="quiet"
              >
                Đóng
              </Button>
            </div>
          </div>
        </aside>
      ) : null}

      {/* 4 Child-First Play & Learn Zones */}
      <div className="grid items-stretch gap-5 md:grid-cols-2">
        {/* Zone 1: Thế giới kể chuyện */}
        <article className="flex flex-col gap-4 rounded-card border border-border bg-white p-6 shadow-xs sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-900">
              <BookOpen aria-hidden="true" className="size-3.5" />
              Thế giới kể chuyện
            </span>
            {primaryRec?.game_key === "PICTURE_DESCRIPTION" ? (
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                Gợi ý hôm nay
              </span>
            ) : null}
          </div>
          <div className="relative min-h-52 overflow-hidden rounded-card bg-cream">
            <Image
              alt="Khu vườn đầy nắng để bé quan sát và kể chuyện"
              className="object-cover"
              fill
              sizes="(max-width: 767px) 100vw, 480px"
              src="/images/picture-description/sunny-garden.jpg"
            />
          </div>
          <h2 className="text-2xl font-extrabold text-ink">
            Kể chuyện qua tranh
          </h2>
          <p className="text-body leading-6 text-muted">
            Quan sát tranh trong sách hoặc ảnh ba mẹ tải lên. Cô giáo AI đồng
            hành qua 6 chế độ: quan sát, mở rộng từ vựng, ghép câu và sáng tạo.
          </p>
          {recommendationByGame.get("PICTURE_DESCRIPTION")?.target_words
            .length ? (
            <p className="text-xs font-semibold text-primary">
              Từ gợi ý:{" "}
              {recommendationByGame
                .get("PICTURE_DESCRIPTION")
                ?.target_words.join(", ")}
            </p>
          ) : null}
          <ButtonLink
            className="mt-auto min-h-12"
            href="/entertainment/picture-description"
            size="compact"
          >
            Chọn tranh <ArrowRight aria-hidden="true" className="size-4" />
          </ButtonLink>
        </article>

        {/* Zone 2: Phiêu lưu cùng chữ */}
        <article className="flex flex-col gap-4 rounded-card border border-border bg-white p-6 shadow-xs sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sky px-3 py-1 text-xs font-extrabold text-primary-hover">
              <Sparkles aria-hidden="true" className="size-3.5" />
              Phiêu lưu cùng chữ
            </span>
            {primaryRec?.game_key === "SENTENCE_SHOOTER" ? (
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                Gợi ý hôm nay
              </span>
            ) : null}
          </div>
          <div
            aria-hidden="true"
            className="flex min-h-52 flex-col items-center justify-center gap-5 rounded-card bg-sky p-6"
          >
            <div className="flex flex-wrap justify-center gap-2">
              {["Bé", "đang", "đọc", "sách."].map((word) => (
                <span
                  className="rounded-control bg-white px-4 py-2 text-xl font-extrabold text-ink shadow-xs"
                  key={word}
                >
                  {word}
                </span>
              ))}
            </div>
            <ToyCannon className="size-24" />
          </div>
          <h2 className="text-2xl font-extrabold text-ink">Xạ thủ ghép câu</h2>
          <p className="text-body leading-6 text-muted">
            Bắn chữ siêu mượt để xếp trật tự câu, điền từ vào chỗ trống và ôn
            luyện các từ khó từ chính sách bé đang đọc.
          </p>
          <ButtonLink
            className="mt-auto min-h-12"
            href="/entertainment/sentence-shooter"
            size="compact"
          >
            Bắt đầu chơi <ArrowRight aria-hidden="true" className="size-4" />
          </ButtonLink>
        </article>

        {/* Zone 3: Sân khấu âm nhạc */}
        <article className="flex flex-col gap-4 rounded-card border border-border bg-cream p-6 shadow-xs sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-3 py-1 text-xs font-extrabold text-rose-900">
              <Music2 aria-hidden="true" className="size-3.5" />
              Sân khấu âm nhạc
            </span>
            {primaryRec?.game_key === "KARAOKE" ? (
              <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-bold text-primary">
                Gợi ý hôm nay
              </span>
            ) : null}
          </div>
          <div
            aria-hidden="true"
            className="flex min-h-52 flex-col items-center justify-center gap-4 rounded-card bg-white/90 p-6"
          >
            <div className="grid size-20 place-items-center rounded-3xl bg-rose-50 text-primary shadow-xs">
              <Music2 className="size-10" />
            </div>
            <div className="flex flex-wrap justify-center gap-2 text-xs font-bold text-rose-900">
              <span className="rounded-full bg-rose-50 px-3 py-1">
                Chấm nhịp & giai điệu
              </span>
              <span className="rounded-full bg-rose-50 px-3 py-1">
                Gõ nhịp vui
              </span>
              <span className="rounded-full bg-rose-50 px-3 py-1">
                Luyện đoạn 0.85x
              </span>
            </div>
          </div>
          <h2 className="text-2xl font-extrabold text-ink">Hát vui cùng bé</h2>
          <p className="text-body leading-6 text-muted">
            Chọn bài hát yêu thích, nghe nhạc và cùng bé hát theo lời trên màn
            hình. Hỗ trợ chấm nhịp điệu, giai điệu và luyện lại từng đoạn khó.
          </p>
          <ButtonLink
            className="mt-auto min-h-12"
            href="/karaoke"
            size="compact"
          >
            Mở thư viện bài hát{" "}
            <ArrowRight aria-hidden="true" className="size-4" />
          </ButtonLink>
        </article>

        {/* Zone 4: Khám phá trí nhớ (NEW Game V4.0) */}
        <article className="flex flex-col gap-4 rounded-card border border-emerald-200 bg-white p-6 shadow-xs sm:p-7">
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-extrabold text-emerald-900">
              <Brain aria-hidden="true" className="size-3.5" />
              Khám phá trí nhớ
            </span>
            <span className="rounded-full bg-emerald-600 px-3 py-1 text-xs font-extrabold text-white">
              Mới
            </span>
          </div>
          <MemoryPreviewIllustration />
          <h2 className="text-2xl font-extrabold text-ink">Bé nhớ được gì?</h2>
          <p className="text-body leading-6 text-muted">
            Quan sát tranh minh họa tiếng Việt trong thời gian bé tự chọn, nhớ
            lại màu sắc và vị trí rồi tưởng tượng kể tiếp câu chuyện thật hay!
          </p>
          <ButtonLink
            className="mt-auto min-h-12"
            href="/entertainment/memory-game"
            size="compact"
          >
            Khám phá trí nhớ{" "}
            <ArrowRight aria-hidden="true" className="size-4" />
          </ButtonLink>
        </article>
      </div>

      {/* Healthy Natural Break Cue (Anti-Addiction, Zero Dark Patterns) */}
      <footer className="flex items-center gap-3 rounded-card border border-border bg-white/80 px-5 py-4 text-sm text-muted">
        <Coffee aria-hidden="true" className="size-5 shrink-0 text-primary" />
        <p>
          <strong className="font-bold text-ink">
            Nhịp nghỉ mắt khỏe mạnh:
          </strong>{" "}
          {recommendations?.natural_break_reminder_vi ??
            "Mỗi phiên chơi khoảng 10–15 phút là vừa đẹp để mắt bé luôn khỏe mạnh và tiếp thu tự nhiên."}
        </p>
      </footer>
    </section>
  );
}
