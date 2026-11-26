"use client";

import {
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Image as ImageIcon,
  MoreVertical,
  Pause,
  SlidersHorizontal,
  Volume2,
} from "lucide-react";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";

import type { BookDetailDTO } from "@/types/book";
import type { ChildProfileDTO } from "@/types/child";
import { BookCover } from "@/components/books/book-cover";
import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import {
  ReadingCompanionBubble,
  type CompanionBubbleState,
} from "@/components/reading/reading-companion-bubble";
import { ReadingControls } from "@/components/reading/reading-controls";
import { ReadingProgress } from "@/components/reading/reading-progress";
import type { ReadingPageDTO, ReadingPageWordDTO } from "@/types/reading";
import type { ComparisonResult } from "@/lib/api/comparison-service";
import type { RealtimeAlignmentSnapshot } from "@/lib/reading/realtime-alignment";

interface ReadingLayoutProps {
  selfCorrectedWordIds?: ReadonlySet<string>;
  unresolvedWordIds?: ReadonlySet<string>;
  uncertainWordIds?: ReadonlySet<string>;
  progressLabel?: string;
  totalPages?: number;
  pageRangeLabel?: string;
  onPrevPage?: () => void;
  onNextPage?: () => void;
  canPrevPage?: boolean;
  canNextPage?: boolean;
  onMarkPageCompleted?: () => void;
  canMarkPageCompleted?: boolean;
  mobileFallbackNotice?: string | null;
  canInstallVietnameseTtsVoice?: boolean;
  onOpenTtsInstallSettings?: () => Promise<boolean> | void;
  hasMobileTopBarAlert?: boolean;
  voiceEngineBadge?: ReactNode;
  audioLevel?: number;
  bookTitle: string;
  book?: BookDetailDTO;
  child?: ChildProfileDTO;
  onChoosePage?: () => void;
  children?: ReactNode;
  previewSnapshot?: RealtimeAlignmentSnapshot | null;
  controlsDisabled?: boolean;
  countdown?: number | null;
  correctWordIds?: Set<string>;
  currentWordId: string | null;
  currentWordText?: string | null;
  exitHref: string;
  onExit?: () => void;
  /** Optional voice settings control shown in the controls bar. */
  voiceSettings?: ReactNode;
  isCurrentWordMispronounced?: boolean;
  isListening: boolean;
  isMicRecording?: boolean;
  isPageTransitioning?: boolean;
  retryMode?: boolean;
  onSkipRetryWord?: () => void;
  retryWordPosition?: number;
  retryWordCount?: number;
  retryFeedback?:
    | "waiting"
    | "preparing-microphone"
    | "playing-instruction"
    | "playing-sample"
    | "listening"
    | "processing"
    | "correct"
    | "incorrect"
    | "not-recognized"
    | "microphone-unavailable"
    | "speech-unavailable"
    | "audio-unavailable"
    | "save-error";
  onRetryRead?: () => void;
  onRetryMicrophonePermission?: () => void;
  onRetrySave?: () => void;
  retryRecording?: ReactNode;
  retryContextPhrase?: string | null;
  isPlayingSample?: boolean;
  isSamplePaused?: boolean;
  onToggleSamplePause?: () => void;
  isReadingWord?: boolean;
  isSpeaking?: boolean;
  latestTranscript?: string | null;
  mispronouncedWordIds?: Set<string>;
  onFinish: () => void;
  onHelp: () => void;
  onPause: () => void;
  onReadSample?: () => void;
  onReadWord?: () => void;
  onSpellWord?: () => void;
  phonicsPanel?: ReactNode;
  sentenceReinforcementPanel?: ReactNode;
  onToggleListening?: () => void;
  onWordClick?: (word: ReadingPageWordDTO) => void;
  onRefreshPageImage?: (pageId: string) => Promise<string | null | undefined>;
  page: ReadingPageDTO;
  comparisonResult?: ComparisonResult | null;
  spokenWords?: Set<string>;
  skippedWordIds?: Set<string>;
  repeatedWordIds?: Set<string>;
  hesitationWordIds?: Set<string>;
  assistedWordIds?: ReadonlySet<string>;
  companionBubble?: CompanionBubbleState | null;
  isCompanionSpeaking?: boolean;
  /** Optional compact page-range / navigation strip rendered inside the top band. */
  topBar?: ReactNode;
}

export function ReadingLayout({
  selfCorrectedWordIds,
  unresolvedWordIds,
  uncertainWordIds,
  progressLabel,
  totalPages,
  pageRangeLabel,
  onPrevPage,
  onNextPage,
  canPrevPage = false,
  canNextPage = false,
  onMarkPageCompleted,
  canMarkPageCompleted = false,
  mobileFallbackNotice,
  canInstallVietnameseTtsVoice = false,
  onOpenTtsInstallSettings,
  hasMobileTopBarAlert = false,
  voiceEngineBadge,
  bookTitle,
  book,
  child,
  onChoosePage,
  children,
  controlsDisabled = false,
  countdown = null,
  correctWordIds,
  currentWordId,
  currentWordText,
  exitHref,
  onExit,
  voiceSettings,
  isCurrentWordMispronounced = false,
  isListening,
  isMicRecording = false,
  isPageTransitioning = false,
  retryMode = false,
  onSkipRetryWord,
  retryWordPosition = 0,
  retryWordCount = 0,
  retryFeedback = "waiting",
  onRetryRead,
  onRetryMicrophonePermission,
  onRetrySave,
  retryRecording,
  retryContextPhrase,
  isPlayingSample = false,
  isSamplePaused = false,
  onToggleSamplePause,
  isReadingWord = false,
  latestTranscript,
  mispronouncedWordIds,
  onFinish,
  onHelp,
  onPause,
  onReadSample,
  onReadWord,
  onSpellWord,
  phonicsPanel,
  sentenceReinforcementPanel,
  onToggleListening,
  onWordClick,
  onRefreshPageImage,
  page,
  comparisonResult,
  spokenWords,
  skippedWordIds,
  repeatedWordIds,
  hesitationWordIds,
  assistedWordIds,
  companionBubble = null,
  isCompanionSpeaking = false,
  previewSnapshot,
  topBar,
}: ReadingLayoutProps) {
  const rootSectionRef = useRef<HTMLElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileImageSheetOpen, setMobileImageSheetOpen] = useState(false);

  const hasStatusBanner =
    retryMode ||
    countdown !== null ||
    isPlayingSample ||
    isReadingWord ||
    (isMicRecording &&
      (isCurrentWordMispronounced || Boolean(latestTranscript))) ||
    Boolean(latestTranscript);
  const hasFeedbackPanel =
    hasStatusBanner ||
    Boolean(sentenceReinforcementPanel) ||
    Boolean(phonicsPanel) ||
    Boolean(!retryMode && companionBubble);

  const openMobileVoiceSettings = () => {
    setMobileMenuOpen(false);
    const trigger = rootSectionRef.current?.querySelector<HTMLButtonElement>(
      '[data-voice-settings-wrap="true"] > button',
    );
    trigger?.click();
  };

  const mobilePageHeading = `Trang ${page.page_number}${totalPages ? `/${totalPages}` : ""} · ${bookTitle}`;

  return (
    <section
      ref={rootSectionRef}
      className="relative mx-auto flex min-h-0 w-full max-w-[1200px] flex-1 flex-col gap-1 px-1.5 pt-1 md:gap-3 md:px-6 md:pt-3"
    >
      <header className="flex h-12 shrink-0 flex-nowrap items-center gap-1 md:h-auto md:gap-3">
        <div className="flex shrink-0 items-center">
          <Link
            aria-label="Thoát khỏi buổi đọc"
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-control px-2 text-xs font-semibold text-ink focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary hover:bg-sky md:h-11 md:min-h-11 md:gap-2 md:px-3 md:text-label"
            href={exitHref}
            onClick={
              onExit
                ? (event) => {
                    event.preventDefault();
                    onExit();
                  }
                : undefined
            }
          >
            <ArrowLeft
              aria-hidden="true"
              className="size-5 shrink-0 md:size-5"
            />
            <span className="hidden md:inline">Quay lại</span>
          </Link>
        </div>

        {/* Mobile compact 1-line title / page indicator */}
        {onChoosePage && !retryMode ? (
          <button
            type="button"
            aria-label="Mở danh sách trang"
            disabled={controlsDisabled}
            onClick={onChoosePage}
            className="min-h-11 min-w-0 flex-1 truncate rounded-control px-1.5 text-left text-sm font-bold text-ink hover:bg-sky disabled:opacity-55 md:hidden"
          >
            {mobilePageHeading}
          </button>
        ) : (
          <p className="min-w-0 flex-1 truncate px-1.5 text-sm font-bold text-ink md:hidden">
            {mobilePageHeading}
          </p>
        )}

        {/* Desktop child + progress summary */}
        <div className="mr-auto hidden min-w-0 md:block">
          {child && (
            <p className="truncate text-xs font-bold text-primary md:text-sm">
              {child.alias} · Lớp {child.grade}
            </p>
          )}
          {!topBar && progressLabel && (
            <p className="truncate text-xs tabular-nums text-muted md:text-sm">
              {progressLabel}
            </p>
          )}
        </div>

        {/* Mobile & compact-landscape page image trigger + mobile options menu */}
        {page.image_url ||
        (page.illustration_url && page.illustration_text_free) ? (
          <button
            type="button"
            aria-label="Mở ảnh trang sách"
            data-landscape-image-btn="true"
            onClick={() => setMobileImageSheetOpen(true)}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control text-ink hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
          >
            <ImageIcon aria-hidden="true" className="size-5 shrink-0" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Tùy chọn buổi đọc"
          data-testid="mobile-reading-menu-btn"
          onClick={() => setMobileMenuOpen(true)}
          className="relative inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control text-ink hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary md:hidden"
        >
          <MoreVertical aria-hidden="true" className="size-5 shrink-0" />
          {mobileFallbackNotice || canInstallVietnameseTtsVoice ? (
            <span
              aria-hidden="true"
              className="absolute top-2 right-2 size-2 rounded-full bg-amber-500"
            />
          ) : null}
        </button>

        {/* Desktop right actions (unchanged on >= 768px) */}
        {onSpellWord && (currentWordText || page.words.length > 0) ? (
          <button
            type="button"
            aria-label="Nghe đánh vần"
            onClick={onSpellWord}
            disabled={controlsDisabled}
            className="hidden min-h-11 shrink-0 items-center gap-2 rounded-control border border-primary/30 bg-sky/60 px-3 text-sm font-semibold text-primary hover:bg-sky disabled:opacity-55 md:inline-flex"
          >
            <Volume2 aria-hidden="true" className="size-4 shrink-0" />
            <span>Nghe đánh vần</span>
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Nhờ gia sư giúp đọc"
          onClick={onHelp}
          disabled={controlsDisabled || retryMode}
          className="hidden min-h-11 min-w-11 shrink-0 items-center justify-center gap-2 rounded-control px-3 text-sm font-semibold text-ink hover:bg-sky disabled:opacity-55 md:inline-flex"
        >
          <CircleHelp aria-hidden="true" className="size-5 shrink-0" />
          <span>Gia sư</span>
        </button>
      </header>

      {topBar ? (
        <div
          data-reading-topbar="true"
          data-mobile-alert={hasMobileTopBarAlert ? "true" : undefined}
          className={
            hasMobileTopBarAlert ? "shrink-0" : "hidden shrink-0 md:block"
          }
        >
          {topBar}
        </div>
      ) : null}

      <section
        aria-label="Nội dung trang sách"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <BookPageViewer
          title={bookTitle}
          illustrationUrl={page.illustration_url || undefined}
          illustrationTextFree={
            page.illustration_url
              ? Boolean(page.illustration_text_free)
              : undefined
          }
          illustration={
            book && (
              <BookCover
                book={book}
                hero
                className="reader-cover-art shrink-0"
              />
            )
          }
          mobileImageSheetOpen={mobileImageSheetOpen}
          onCloseMobileImageSheet={() => setMobileImageSheetOpen(false)}
          selfCorrectedWordIds={selfCorrectedWordIds}
          unresolvedWordIds={unresolvedWordIds}
          uncertainWordIds={uncertainWordIds}
          activeRetryWordId={
            retryMode && retryFeedback !== "correct" ? currentWordId : null
          }
          correctWordIds={correctWordIds}
          currentWordId={currentWordId}
          isTransitioning={isPageTransitioning}
          mispronouncedWordIds={mispronouncedWordIds}
          onRefreshImageUrl={onRefreshPageImage}
          onWordClick={onWordClick}
          page={page}
          previewSnapshot={previewSnapshot}
          spokenWords={spokenWords}
          skippedWordIds={skippedWordIds}
          repeatedWordIds={repeatedWordIds}
          hesitationWordIds={hesitationWordIds}
          assistedWordIds={assistedWordIds}
          comparisonResult={comparisonResult}
        />
      </section>

      <div
        data-reading-dock="true"
        className="reading-dock -mx-1.5 px-1.5 pt-1 pb-[max(0.35rem,env(safe-area-inset-bottom))] md:-mx-6 md:px-6 md:pt-2.5 md:pb-2"
      >
        {hasFeedbackPanel ? (
          <div
            data-reading-feedback="true"
            className="mx-auto mb-1 max-h-[24dvh] w-full max-w-[1104px] space-y-1.5 overflow-y-auto overscroll-contain md:mb-2 md:max-h-[26dvh] md:space-y-2"
          >
            {retryMode ? (
              <div
                className="mx-auto flex w-full max-w-[1008px] flex-wrap items-center gap-3 rounded-card border border-border bg-white px-4 py-2.5"
                aria-live="polite"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-primary">
                    Bé đọc lại từ · {retryWordPosition}/{retryWordCount}
                  </p>

                  <p className="mt-1 break-words text-base font-bold text-ink">
                    {retryFeedback === "preparing-microphone"
                      ? "Đang chuẩn bị microphone..."
                      : retryFeedback === "playing-instruction"
                        ? "ViRead đang hướng dẫn bé..."
                        : retryFeedback === "playing-sample"
                          ? "Nghe mẫu"
                          : retryFeedback === "listening"
                            ? isMicRecording
                              ? "Đang nghe bé"
                              : "Đang bật microphone..."
                            : retryFeedback === "processing"
                              ? "Đang kiểm tra"
                              : retryFeedback === "correct"
                                ? "Bé đã tự sửa đúng"
                                : retryFeedback === "incorrect"
                                  ? "Thử lại · Từ này chưa đúng"
                                  : retryFeedback === "not-recognized"
                                    ? "Thử lại · ViRead chưa nghe rõ"
                                    : retryFeedback === "microphone-unavailable"
                                      ? "Microphone chưa sẵn sàng."
                                      : retryFeedback === "speech-unavailable"
                                        ? "Dịch vụ nhận diện đang tạm dừng."
                                        : retryFeedback === "audio-unavailable"
                                          ? "Chưa phát được lời hướng dẫn."
                                          : retryFeedback === "save-error"
                                            ? "Chưa lưu được kết quả đọc lại."
                                            : "Bé hãy đọc riêng từ bên dưới nhé."}
                  </p>

                  <p className="mt-1.5 w-fit max-w-full break-words rounded-control bg-warning-surface px-3 py-1 text-xl font-extrabold text-ink">
                    <span className="sr-only">Từ cần luyện </span>
                    {currentWordText}
                  </p>

                  {retryContextPhrase ? (
                    <p className="mt-1.5 break-words text-base font-bold text-ink md:text-lg">
                      {retryContextPhrase}
                    </p>
                  ) : null}
                  {latestTranscript ? (
                    <p className="mt-1 line-clamp-2 text-sm font-medium text-ink">
                      {latestTranscript}
                    </p>
                  ) : null}
                </div>
                {onSkipRetryWord ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onSkipRetryWord}
                    className="min-h-11 shrink-0 rounded-control border border-border bg-white px-3.5 py-2 text-xs font-semibold text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    Bỏ qua từ này
                  </button>
                ) : null}
                {retryFeedback === "microphone-unavailable" &&
                onRetryMicrophonePermission ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onRetryMicrophonePermission}
                    className="min-h-11 shrink-0 rounded-control bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    Thử bật mic
                  </button>
                ) : null}
                {(retryFeedback === "incorrect" ||
                  retryFeedback === "not-recognized" ||
                  retryFeedback === "audio-unavailable" ||
                  retryFeedback === "speech-unavailable") &&
                onRetryRead ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onRetryRead}
                    className="min-h-11 shrink-0 rounded-control bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    Nghe lại và thử
                  </button>
                ) : null}
                {retryFeedback === "save-error" && onRetrySave ? (
                  <button
                    type="button"
                    disabled={controlsDisabled}
                    onClick={onRetrySave}
                    className="min-h-11 shrink-0 rounded-control bg-primary px-3.5 py-2 text-xs font-semibold text-white hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
                  >
                    Thử lưu lại
                  </button>
                ) : null}
                {retryRecording}
              </div>
            ) : countdown !== null ? (
              <div className="mx-auto flex w-full max-w-[1008px] items-center justify-center gap-3 rounded-card border border-border bg-white px-4 py-2.5">
                <span className="text-sm font-semibold text-primary">
                  Chuẩn bị đọc
                </span>
                <span className="flex size-9 items-center justify-center rounded-control bg-sky text-lg font-semibold text-primary">
                  {countdown > 0 ? countdown : "✓"}
                </span>
                <span className="text-base font-medium text-ink">
                  {countdown > 0 ? "Bé sẵn sàng đọc to nhé" : "Bắt đầu đọc"}
                </span>
              </div>
            ) : isPlayingSample ? (
              <div className="mx-auto flex w-full max-w-[1008px] flex-wrap items-center justify-between gap-2 rounded-card border border-border bg-white/95 px-2.5 py-1 md:gap-2.5 md:bg-white md:px-4 md:py-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Volume2
                    aria-hidden="true"
                    className="size-4 shrink-0 text-primary"
                  />
                  <span className="shrink-0 text-xs font-semibold text-ink md:text-sm">
                    Đọc mẫu
                  </span>
                  <span className="hidden min-w-0 truncate text-xs text-muted md:inline md:text-sm">
                    {isSamplePaused
                      ? "Đã tạm dừng đọc mẫu."
                      : "Đang phát âm toàn bộ trang sách theo giọng mẫu..."}
                  </span>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {onToggleSamplePause ? (
                    <button
                      type="button"
                      onClick={onToggleSamplePause}
                      className="min-h-11 shrink-0 rounded-control border border-border bg-white px-2.5 py-1 text-xs font-semibold text-ink hover:bg-canvas md:px-3 md:text-sm"
                    >
                      {isSamplePaused ? "Tiếp tục mẫu" : "Tạm dừng mẫu"}
                    </button>
                  ) : null}
                  {onReadSample ? (
                    <button
                      type="button"
                      onClick={onReadSample}
                      className="hidden min-h-11 shrink-0 rounded-control border border-border bg-white px-3 py-1 text-sm font-semibold text-ink hover:bg-canvas md:inline-flex md:items-center"
                    >
                      Dừng mẫu
                    </button>
                  ) : null}
                </div>
              </div>
            ) : isReadingWord ? (
              <div className="mx-auto flex w-full max-w-[1008px] items-center gap-3 rounded-card border border-purple/50 bg-purple px-4 py-2">
                <span className="shrink-0 text-xs font-semibold text-purple-ink md:text-sm">
                  Đọc mẫu từ
                </span>
                <p className="min-w-0 flex-1 truncate text-base font-semibold text-purple-900 md:text-lg">
                  &ldquo;{currentWordText || latestTranscript}&rdquo;
                </p>
              </div>
            ) : isMicRecording ? (
              isCurrentWordMispronounced ? (
                <div className="mx-auto flex w-full max-w-[1008px] items-center justify-between gap-2 rounded-card border border-danger/30 bg-danger-surface px-3 py-2 md:gap-3 md:px-4 md:py-2.5">
                  <div className="flex min-w-0 flex-1 items-center gap-2 md:gap-3">
                    <span className="size-2.5 shrink-0 rounded-full bg-danger" />
                    <span className="shrink-0 text-xs font-semibold text-danger md:text-sm">
                      Chưa chính xác
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold text-rose-950 md:text-base">
                      Hãy đọc lại từ &ldquo;
                      <span className="underline decoration-2 underline-offset-2">
                        {currentWordText}
                      </span>
                      &rdquo;
                    </p>
                  </div>
                  {currentWordText && onReadWord ? (
                    <button
                      type="button"
                      onClick={onReadWord}
                      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-control border border-danger/30 bg-white px-3 py-1.5 text-xs font-semibold text-danger hover:bg-danger-surface md:text-sm"
                      title="Bấm để nghe đọc mẫu từ này"
                    >
                      <>
                        <Volume2 aria-hidden="true" className="size-4" /> Nghe
                        mẫu
                      </>
                    </button>
                  ) : null}
                </div>
              ) : latestTranscript ? (
                <p className="mx-auto line-clamp-1 w-full max-w-[1008px] rounded-full border border-border/70 bg-white/95 px-3 py-1.5 text-xs text-muted md:line-clamp-2 md:rounded-none md:border-0 md:bg-transparent md:px-1 md:py-0 md:text-body">
                  Bé vừa đọc: <span>“{latestTranscript}”</span>
                </p>
              ) : null
            ) : latestTranscript ? (
              <div className="mx-auto flex w-full max-w-[1008px] items-center gap-2 rounded-card border border-purple/50 bg-white/95 px-3 py-1.5 md:gap-3 md:bg-purple/40 md:px-4 md:py-2">
                <span className="shrink-0 text-xs font-semibold text-purple-ink md:text-sm">
                  Bản ghi mới nhất
                </span>
                <p className="min-w-0 flex-1 truncate text-xs font-semibold italic text-ink md:text-sm">
                  &ldquo;{latestTranscript}&rdquo;
                </p>
              </div>
            ) : null}

            {sentenceReinforcementPanel ? (
              <div className="mx-auto w-full max-w-[1008px]">
                {sentenceReinforcementPanel}
              </div>
            ) : null}

            {phonicsPanel ? (
              <div className="mx-auto w-full max-w-[1008px]">
                {phonicsPanel}
              </div>
            ) : null}

            {!retryMode && companionBubble ? (
              <ReadingCompanionBubble
                isSpeaking={isCompanionSpeaking}
                state={companionBubble}
              />
            ) : null}
          </div>
        ) : null}

        <ReadingControls
          pauseDisabled={false}
          disabled={controlsDisabled}
          isListening={isMicRecording}
          isPlayingSample={isPlayingSample}
          retryMode={retryMode}
          onFinish={onFinish}
          onHelp={onHelp}
          onPause={onPause}
          onReadSample={onReadSample}
          onSpellWord={
            onSpellWord && (currentWordText || page.words.length > 0)
              ? onSpellWord
              : undefined
          }
          onToggleListening={onToggleListening}
          voiceSettings={voiceSettings}
          onChoosePage={onChoosePage}
        />

        <div data-reading-progress-wrap="true" className="mt-1">
          <ReadingProgress
            isListening={isListening}
            pageNumber={page.page_number}
            wordCount={page.words.length}
            readCount={
              page.words.filter(
                (word) =>
                  correctWordIds?.has(word.word_id) ||
                  mispronouncedWordIds?.has(word.word_id),
              ).length
            }
            currentWord={currentWordText}
          />
        </div>
      </div>

      {mobileMenuOpen ? (
        <Modal
          closeOnBackdropClick
          isOpen
          onClose={() => setMobileMenuOpen(false)}
          title="Tùy chọn buổi đọc"
          tone="paper"
        >
          <div className="flex flex-col gap-2.5">
            {child ? (
              <p className="text-xs font-semibold text-primary">
                {child.alias} · Lớp {child.grade}
                {pageRangeLabel ? ` · ${pageRangeLabel}` : ""}
              </p>
            ) : pageRangeLabel ? (
              <p className="text-xs font-semibold text-muted">
                {pageRangeLabel}
              </p>
            ) : null}

            {onPrevPage || onNextPage ? (
              <div className="grid grid-cols-2 gap-2">
                <Button
                  disabled={controlsDisabled || !canPrevPage}
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onPrevPage?.();
                  }}
                  size="compact"
                  variant="secondary"
                >
                  <ChevronLeft aria-hidden="true" className="size-4 shrink-0" />
                  Trang trước
                </Button>
                <Button
                  disabled={controlsDisabled || !canNextPage}
                  onClick={() => {
                    setMobileMenuOpen(false);
                    onNextPage?.();
                  }}
                  size="compact"
                  variant="secondary"
                >
                  Trang tiếp
                  <ChevronRight
                    aria-hidden="true"
                    className="size-4 shrink-0"
                  />
                </Button>
              </div>
            ) : null}

            {onChoosePage && !retryMode ? (
              <Button
                disabled={controlsDisabled}
                onClick={() => {
                  setMobileMenuOpen(false);
                  onChoosePage();
                }}
                size="compact"
                variant="secondary"
              >
                <BookOpen aria-hidden="true" className="size-4 shrink-0" />
                Chọn trang khác
              </Button>
            ) : null}

            {canMarkPageCompleted && onMarkPageCompleted ? (
              <Button
                disabled={controlsDisabled}
                onClick={() => {
                  setMobileMenuOpen(false);
                  onMarkPageCompleted();
                }}
                size="compact"
                variant="quiet"
              >
                <CheckCircle2 aria-hidden="true" className="size-4 shrink-0" />
                Đánh dấu trang đã đọc xong
              </Button>
            ) : null}

            {voiceSettings ? (
              <Button
                disabled={isMicRecording}
                onClick={openMobileVoiceSettings}
                size="compact"
                variant="secondary"
              >
                <SlidersHorizontal
                  aria-hidden="true"
                  className="size-4 shrink-0"
                />
                Cài đặt giọng đọc
              </Button>
            ) : null}

            {!retryMode ? (
              <Button
                disabled={controlsDisabled}
                onClick={() => {
                  setMobileMenuOpen(false);
                  onHelp();
                }}
                size="compact"
                variant="secondary"
              >
                <CircleHelp aria-hidden="true" className="size-4 shrink-0" />
                Nhờ gia sư giúp đọc
              </Button>
            ) : null}

            <Button
              disabled={controlsDisabled}
              onClick={() => {
                setMobileMenuOpen(false);
                onPause();
              }}
              size="compact"
              variant="quiet"
            >
              <Pause aria-hidden="true" className="size-4 shrink-0" />
              Tạm dừng buổi đọc
            </Button>

            {voiceEngineBadge ? (
              <div className="pt-1">{voiceEngineBadge}</div>
            ) : null}

            {mobileFallbackNotice ? (
              <StatusMessage tone="warning">
                {mobileFallbackNotice}
              </StatusMessage>
            ) : null}

            {canInstallVietnameseTtsVoice && onOpenTtsInstallSettings ? (
              <Button
                onClick={() => {
                  setMobileMenuOpen(false);
                  void onOpenTtsInstallSettings();
                }}
                size="compact"
                variant="primary"
              >
                Mở Cài đặt TTS
              </Button>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {children}
    </section>
  );
}
