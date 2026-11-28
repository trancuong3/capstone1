"use client";

import { BookOpen, Sparkles, WandSparkles } from "lucide-react";
import { useContext, useMemo, useState } from "react";

import { ReadabilityBadge } from "@/components/books/readability-badge";
import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button, ButtonLink } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useTranslations } from "@/hooks/use-i18n";
import { emitStudioTasksChanged } from "@/lib/api/global-tasks-service";
import { createParentPrivateBookService } from "@/lib/api/parent-private-book-service";
import { isServiceError } from "@/lib/api/service-error";
import {
  DEFAULT_USER_CACHE_TTL_MS,
  PERSISTENT_USER_CACHE_MAX_STALE_MS,
  readUserCacheWithStale,
} from "@/lib/cache/user-query-cache";
import type { ChildProfileDTO } from "@/types/child";
import type {
  ParentStoryweaverResponseDTO,
  StoryweaverStyleMode,
} from "@/types/parent-private-book";

interface FamilyStoryweaverModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onCreated?: (result: ParentStoryweaverResponseDTO) => void;
}

export function FamilyStoryweaverModal({
  isOpen,
  onClose,
  onCreated,
}: FamilyStoryweaverModalProps) {
  const t = useTranslations("books");
  const tCommon = useTranslations("common");
  const authRuntime = useAuthRuntime();
  const appStore = useContext(AppStoreContext);
  const service = useMemo(() => createParentPrivateBookService(), []);

  const currentUserId =
    authRuntime.session?.user?.id ?? authRuntime.initialUserId ?? null;
  const validatedChild = appStore?.validatedSelectedChild ?? null;
  const childrenProfiles = useMemo<readonly ChildProfileDTO[]>(() => {
    const cached =
      readUserCacheWithStale<ChildProfileDTO[]>(
        currentUserId,
        "children",
        DEFAULT_USER_CACHE_TTL_MS,
        PERSISTENT_USER_CACHE_MAX_STALE_MS,
      )?.data ?? [];
    if (cached.length > 0) return cached;
    return validatedChild ? [validatedChild] : [];
  }, [currentUserId, validatedChild]);
  const defaultChildId =
    appStore?.selectedChildId ?? childrenProfiles[0]?.id ?? "";

  const [selectedChildId, setSelectedChildId] =
    useState<string>(defaultChildId);
  const [theme, setTheme] = useState<string>("khu vườn nắng sớm");
  const [title, setTitle] = useState<string>("");
  const [styleMode, setStyleMode] =
    useState<StoryweaverStyleMode>("DUET_DIALOGUE");
  const [pageCount, setPageCount] = useState<3 | 4>(3);
  const [targetGrade, setTargetGrade] = useState<number>(1);
  const [customWordsRaw, setCustomWordsRaw] = useState<string>("");
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [createdResult, setCreatedResult] =
    useState<ParentStoryweaverResponseDTO | null>(null);
  const [resetEpoch, setResetEpoch] = useState<number>(0);

  const selectedChild = useMemo(
    () =>
      childrenProfiles.find((c) => c.id === selectedChildId) ??
      childrenProfiles[0] ??
      null,
    [childrenProfiles, selectedChildId],
  );

  const effectiveGrade = selectedChild ? selectedChild.grade : targetGrade;

  const progress = useAiProgress({
    active: isGenerating,
    completed: Boolean(createdResult && !isGenerating),
    failed: Boolean(errorMessage && !isGenerating),
    expectedDurationMs: 14_000,
    resetKey: resetEpoch,
    stages: [
      { atPct: 0, label: t("myBooks.storyweaver.stagePreparing") },
      { atPct: 35, label: t("myBooks.storyweaver.stageWeaving") },
      { atPct: 72, label: tCommon("aiProgress.safetyChecking") },
      { atPct: 88, label: tCommon("aiProgress.finalizing") },
    ],
  });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isGenerating || !service.createStoryweaverBook) return;
    const trimmedTheme = theme.trim();
    if (trimmedTheme.length < 2) {
      setErrorMessage(t("myBooks.storyweaver.themeRequiredError"));
      return;
    }

    setErrorMessage(null);
    setCreatedResult(null);
    setResetEpoch((n) => n + 1);
    setIsGenerating(true);

    const customWords = customWordsRaw
      .split(/[,;\n]+/)
      .map((w) => w.trim())
      .filter(Boolean)
      .slice(0, 6);

    try {
      const response = await service.createStoryweaverBook({
        child_id: selectedChild?.id ?? null,
        title: title.trim() || null,
        theme: trimmedTheme,
        page_count: pageCount,
        target_grade: effectiveGrade,
        style_mode: styleMode,
        custom_words: customWords,
      });
      setCreatedResult(response);
      onCreated?.(response);

      if (currentUserId) {
        emitStudioTasksChanged({
          portal: "parent",
          actorId: currentUserId,
          source: "family-storyweaver",
        });
      }
    } catch (error: unknown) {
      if (isServiceError(error)) {
        setErrorMessage(error.message);
      } else {
        setErrorMessage(t("myBooks.storyweaver.genericError"));
      }
    } finally {
      setIsGenerating(false);
    }
  }

  const createdBook = createdResult?.book_detail.book ?? null;
  const firstPage = createdResult?.book_detail.pages[0] ?? null;
  const lastPage =
    createdResult?.book_detail.pages[
      createdResult.book_detail.pages.length - 1
    ] ?? null;
  const readNowHref =
    createdBook && firstPage && lastPage
      ? `/reading-preparation?${new URLSearchParams({
          bookId: createdBook.id,
          pageId: firstPage.page_id,
          endPageId: lastPage.page_id,
          ...(selectedChild ? { childId: selectedChild.id } : {}),
        }).toString()}`
      : createdBook
        ? `/my-books/${encodeURIComponent(createdBook.id)}`
        : "/my-books";

  return (
    <Modal
      closeOnEscape={!isGenerating}
      isOpen={isOpen}
      onClose={() => {
        if (!isGenerating) onClose();
      }}
      title={t("myBooks.storyweaver.modalTitle")}
    >
      <div className="space-y-4" data-testid="family-storyweaver-modal">
        <p className="text-sm text-muted">
          {t("myBooks.storyweaver.modalDescription")}
        </p>

        {errorMessage ? (
          <StatusMessage tone="error">{errorMessage}</StatusMessage>
        ) : null}

        {isGenerating ? (
          <div className="rounded-card border border-primary/30 bg-sky/40 p-4">
            <AiProgressBar
              active
              elapsedSeconds={progress.elapsedSeconds}
              label={
                progress.stageLabel ?? t("myBooks.storyweaver.stageWeaving")
              }
              percent={progress.percent}
              size="md"
              testId="storyweaver-ai-progress"
            />
          </div>
        ) : null}

        {createdResult && createdBook ? (
          <div
            className="space-y-3 rounded-card border border-emerald-300 bg-emerald-50/70 p-4"
            data-testid="storyweaver-created-card"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-base font-extrabold text-emerald-950">
                {createdBook.title}
              </p>
              <ReadabilityBadge readability={createdResult.readability} />
            </div>
            {createdResult.target_words_used.length > 0 ? (
              <p className="text-xs font-semibold text-emerald-900">
                {t("myBooks.storyweaver.wordsUsedLabel", {
                  words: createdResult.target_words_used.join(", "),
                })}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <ButtonLink className="sm:w-auto" href={readNowHref}>
                <BookOpen aria-hidden="true" className="size-4" />
                {t("myBooks.storyweaver.readTogetherNow")}
              </ButtonLink>
              <ButtonLink
                className="sm:w-auto"
                href={`/my-books/${encodeURIComponent(createdBook.id)}`}
                variant="secondary"
              >
                {t("myBooks.storyweaver.openBookDetail")}
              </ButtonLink>
            </div>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
            {childrenProfiles.length > 0 ? (
              <label className="block space-y-1.5 text-sm font-bold text-ink">
                <span>{t("myBooks.storyweaver.childLabel")}</span>
                <select
                  className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-sm font-semibold text-ink"
                  disabled={isGenerating}
                  onChange={(e) => setSelectedChildId(e.target.value)}
                  value={selectedChild?.id ?? ""}
                >
                  {childrenProfiles.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.alias} (Lớp {c.grade})
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="block space-y-1.5 text-sm font-bold text-ink">
                <span>{t("myBooks.storyweaver.gradeLabel")}</span>
                <select
                  className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-sm font-semibold text-ink"
                  disabled={isGenerating}
                  onChange={(e) => setTargetGrade(Number(e.target.value) || 1)}
                  value={targetGrade}
                >
                  {[1, 2, 3, 4, 5].map((g) => (
                    <option key={g} value={g}>
                      Lớp {g}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="block space-y-1.5 text-sm font-bold text-ink">
              <span>{t("myBooks.storyweaver.themeLabel")}</span>
              <input
                className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-sm text-ink"
                disabled={isGenerating}
                maxLength={120}
                onChange={(e) => setTheme(e.target.value)}
                placeholder={t("myBooks.storyweaver.themePlaceholder")}
                required
                type="text"
                value={theme}
              />
            </label>

            <label className="block space-y-1.5 text-sm font-bold text-ink">
              <span>{t("myBooks.storyweaver.titleOptionalLabel")}</span>
              <input
                className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-sm text-ink"
                disabled={isGenerating}
                maxLength={180}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t("myBooks.storyweaver.titleOptionalPlaceholder")}
                type="text"
                value={title}
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5 text-sm font-bold text-ink">
                <span>{t("myBooks.storyweaver.styleModeLabel")}</span>
                <select
                  className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-sm font-semibold text-ink"
                  disabled={isGenerating}
                  onChange={(e) =>
                    setStyleMode(e.target.value as StoryweaverStyleMode)
                  }
                  value={styleMode}
                >
                  <option value="DUET_DIALOGUE">
                    {t("myBooks.storyweaver.styleDuet")}
                  </option>
                  <option value="POEM">
                    {t("myBooks.storyweaver.stylePoem")}
                  </option>
                  <option value="PROSE">
                    {t("myBooks.storyweaver.styleProse")}
                  </option>
                </select>
              </label>

              <label className="block space-y-1.5 text-sm font-bold text-ink">
                <span>{t("myBooks.storyweaver.pageCountLabel")}</span>
                <select
                  className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-sm font-semibold text-ink"
                  disabled={isGenerating}
                  onChange={(e) =>
                    setPageCount(Number(e.target.value) === 4 ? 4 : 3)
                  }
                  value={pageCount}
                >
                  <option value={3}>
                    {t("myBooks.storyweaver.threePages")}
                  </option>
                  <option value={4}>
                    {t("myBooks.storyweaver.fourPages")}
                  </option>
                </select>
              </label>
            </div>

            <label className="block space-y-1.5 text-sm font-bold text-ink">
              <span>{t("myBooks.storyweaver.customWordsLabel")}</span>
              <input
                className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-sm text-ink"
                disabled={isGenerating}
                onChange={(e) => setCustomWordsRaw(e.target.value)}
                placeholder={t("myBooks.storyweaver.customWordsPlaceholder")}
                type="text"
                value={customWordsRaw}
              />
            </label>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              <Button
                className="w-auto"
                disabled={isGenerating}
                fullWidth={false}
                onClick={onClose}
                type="button"
                variant="secondary"
              >
                {tCommon("actions.cancel", undefined, "Đóng")}
              </Button>
              <Button
                className="w-auto"
                disabled={isGenerating}
                fullWidth={false}
                isLoading={isGenerating}
                type="submit"
              >
                <WandSparkles aria-hidden="true" className="size-4" />
                {t("myBooks.storyweaver.submitAction")}
              </Button>
            </div>
          </form>
        )}

        <p className="flex items-center gap-1.5 text-xs text-muted">
          <Sparkles
            aria-hidden="true"
            className="size-3.5 shrink-0 text-primary"
          />
          {t("myBooks.storyweaver.safetyFootnote")}
        </p>
      </div>
    </Modal>
  );
}
