"use client";

import {
  BookOpen,
  Check,
  CheckCircle2,
  Lock,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AiProgressBar } from "@/components/common/ai-progress-bar";
import { Button, ButtonLink } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useAiProgress } from "@/hooks/use-ai-progress";
import { createChildService, type ChildService } from "@/lib/api/child-service";
import {
  defaultMicroStoryService,
  type MicroStoryGenerateResponseDTO,
  type MicroStoryPreviewDTO,
  type MicroStoryService,
  type MicroStoryTargetWordDTO,
} from "@/lib/api/micro-story-service";
import { isServiceError } from "@/lib/api/service-error";
import { useMicroStoryTranslations } from "@/messages/features/micro_story";
import type { ChildProfileDTO } from "@/types/child";

const MIN_WORDS = 3;
const MAX_WORDS = 5;

function normalizeWordKey(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

export interface CreateMicroStoryModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly child?: ChildProfileDTO | null;
  readonly childrenProfiles?: readonly ChildProfileDTO[];
  readonly service?: MicroStoryService;
  readonly childService?: Pick<ChildService, "list">;
  readonly onStoryCreated?: (result: MicroStoryGenerateResponseDTO) => void;
}

export function CreateMicroStoryModal({
  isOpen,
  onClose,
  child: explicitChild = null,
  childrenProfiles,
  service = defaultMicroStoryService,
  childService: injectedChildService,
  onStoryCreated,
}: CreateMicroStoryModalProps) {
  const t = useMicroStoryTranslations();
  const childApi = useMemo(
    () => injectedChildService ?? createChildService(),
    [injectedChildService],
  );

  const [fetchedChildren, setFetchedChildren] = useState<
    readonly ChildProfileDTO[]
  >([]);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [selectedChildId, setSelectedChildId] = useState<string>(
    explicitChild?.id ?? "",
  );

  const [preview, setPreview] = useState<MicroStoryPreviewDTO | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  const [candidates, setCandidates] = useState<MicroStoryTargetWordDTO[]>([]);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [customWordInput, setCustomWordInput] = useState("");
  const [themeHint, setThemeHint] = useState("");

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [createdStory, setCreatedStory] =
    useState<MicroStoryGenerateResponseDTO | null>(null);

  const reqSeqRef = useRef(0);

  const availableChildren = useMemo(() => {
    if (childrenProfiles && childrenProfiles.length > 0) {
      return childrenProfiles;
    }
    if (explicitChild) {
      return [explicitChild];
    }
    return fetchedChildren;
  }, [childrenProfiles, explicitChild, fetchedChildren]);

  const activeChild = useMemo(() => {
    if (explicitChild && (!selectedChildId || selectedChildId === explicitChild.id)) {
      return explicitChild;
    }
    return (
      availableChildren.find((c) => c.id === selectedChildId) ??
      availableChildren[0] ??
      null
    );
  }, [availableChildren, explicitChild, selectedChildId]);

  const genProgress = useAiProgress({
    active: generating,
    stages: [
      { atPct: 0, label: t("progressStageWords") },
      { atPct: 28, label: t("progressStageStory") },
      { atPct: 60, label: t("progressStageArt") },
      { atPct: 88, label: t("progressStageSave") },
    ],
    expectedDurationMs: 9_000,
  });

  useEffect(() => {
    if (
      !isOpen ||
      explicitChild ||
      (childrenProfiles && childrenProfiles.length > 0)
    ) {
      return;
    }

    let cancelled = false;
    void Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        setLoadingChildren(true);
        setPreviewError(null);
        return childApi.list();
      })
      .then((items) => {
        if (cancelled || !items) return;
        setFetchedChildren(items);
        if (items.length > 0) {
          setSelectedChildId((prev) =>
            items.some((c) => c.id === prev) ? prev : items[0].id,
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewError(t("errorGeneric"));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingChildren(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [childApi, childrenProfiles, explicitChild, isOpen, t]);

  useEffect(() => {
    if (!isOpen || !activeChild?.id) {
      return;
    }
    const targetChildId = activeChild.id;
    const seq = ++reqSeqRef.current;
    const controller = new AbortController();

    void Promise.resolve()
      .then(() => {
        if (seq !== reqSeqRef.current) return undefined;
        setLoadingPreview(true);
        setPreviewError(null);
        setGenerateError(null);
        setCreatedStory(null);
        return service.previewWords(targetChildId, controller.signal);
      })
      .then((res) => {
        if (seq !== reqSeqRef.current || !res) return;
        setPreview(res);
        const pool =
          res.candidate_pool.length > 0
            ? res.candidate_pool
            : res.recommended_words;
        setCandidates(pool);
        const defaults = res.recommended_words
          .map((w) => w.normalized_word)
          .slice(0, MAX_WORDS);
        setSelectedKeys(
          defaults.length >= MIN_WORDS
            ? defaults
            : pool.slice(0, MIN_WORDS).map((w) => w.normalized_word),
        );
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || seq !== reqSeqRef.current) return;
        setPreview(null);
        setPreviewError(
          isServiceError(err) && err.message ? err.message : t("errorGeneric"),
        );
      })
      .finally(() => {
        if (seq === reqSeqRef.current) {
          setLoadingPreview(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [activeChild?.id, isOpen, reloadSeq, service, t]);

  const handleClose = useCallback(() => {
    if (generating) return;
    setCreatedStory(null);
    setGenerateError(null);
    setCustomWordInput("");
    setThemeHint("");
    onClose();
  }, [generating, onClose]);

  function toggleWord(normKey: string) {
    if (generating) return;
    setSelectedKeys((prev) => {
      if (prev.includes(normKey)) {
        if (prev.length <= MIN_WORDS) {
          return prev;
        }
        return prev.filter((item) => item !== normKey);
      }
      if (prev.length >= MAX_WORDS) {
        return prev;
      }
      return [...prev, normKey];
    });
  }

  function handleAddCustomWord() {
    const cleaned = customWordInput.normalize("NFC").trim().replace(/\s+/g, " ");
    if (!cleaned || cleaned.length < 2) return;
    const norm = normalizeWordKey(cleaned);
    if (!norm) return;

    const exists = candidates.some((c) => c.normalized_word === norm);
    if (!exists) {
      const customItem: MicroStoryTargetWordDTO = {
        normalized_word: norm,
        display_text: cleaned,
        source: "PARENT_CUSTOM",
        priority_score: 1.2,
        practice_count: 0,
        phonics_category: "general",
        phonics_label_vi: t("sourceCustom"),
        reason_vi: t("sourceCustom"),
        selected_by_default: true,
      };
      setCandidates((prev) => [customItem, ...prev]);
    }
    setSelectedKeys((prev) => {
      if (prev.includes(norm)) return prev;
      if (prev.length >= MAX_WORDS) {
        return [...prev.slice(0, MAX_WORDS - 1), norm];
      }
      return [...prev, norm];
    });
    setCustomWordInput("");
  }

  const activeQuota = createdStory?.quota ?? preview?.quota ?? null;
  const isQuotaExceeded = Boolean(activeQuota?.quota_exceeded);
  const selectedWordTexts = useMemo(() => {
    const byKey = new Map(candidates.map((c) => [c.normalized_word, c]));
    return selectedKeys
      .map((k) => byKey.get(k)?.display_text ?? k)
      .filter(Boolean);
  }, [candidates, selectedKeys]);

  const canSubmit =
    Boolean(activeChild?.id) &&
    !loadingPreview &&
    !generating &&
    !isQuotaExceeded &&
    selectedWordTexts.length >= MIN_WORDS &&
    selectedWordTexts.length <= MAX_WORDS;

  async function handleGenerate() {
    if (!activeChild?.id || !canSubmit) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const result = await service.generateStory(activeChild.id, {
        selected_words: selectedWordTexts,
        theme_hint: themeHint.trim() || null,
      });
      setCreatedStory(result);
      setPreview((prev) => (prev ? { ...prev, quota: result.quota } : prev));
      onStoryCreated?.(result);
    } catch (err: unknown) {
      if (isServiceError(err)) {
        if (err.status === 429) {
          setPreview((prev) =>
            prev
              ? {
                  ...prev,
                  quota: {
                    ...prev.quota,
                    used_today: prev.quota.daily_limit,
                    remaining_today: 0,
                    quota_exceeded: true,
                  },
                }
              : prev,
          );
          setGenerateError(
            t("quotaExceededBody", {
              limit: activeQuota?.daily_limit ?? 2,
              alias: activeChild.alias,
            }),
          );
        } else if (err.status === 422) {
          setGenerateError(err.message || t("errorSafetyRejected"));
        } else {
          setGenerateError(err.message || t("errorGeneric"));
        }
      } else {
        setGenerateError(t("errorGeneric"));
      }
    } finally {
      setGenerating(false);
    }
  }

  const modalTitle = activeChild?.alias
    ? t("modalTitle", { alias: activeChild.alias })
    : t("modalTitleDefault");

  return (
    <Modal
      closeOnBackdropClick={!generating}
      closeOnEscape={!generating}
      isOpen={isOpen}
      onClose={handleClose}
      showCloseButton={!generating}
      title={modalTitle}
      tone="paper"
    >
      <div className="flex flex-col gap-4 text-sm text-ink">
        {/* Household PARENT_PRIVATE privacy banner */}
        <div className="flex items-start gap-2.5 rounded-control border border-emerald-200 bg-emerald-50/75 px-3.5 py-2.5 text-xs text-emerald-950">
          <Lock
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-emerald-700"
          />
          <div className="min-w-0 leading-relaxed">
            <strong className="font-extrabold">{t("privacyLockLabel")}:</strong>{" "}
            <span>{preview?.privacy_notice_vi ?? t("privacyNotice")}</span>
          </div>
        </div>

        {/* Multi-child selector when invoked from /my-books */}
        {availableChildren.length > 1 && !createdStory ? (
          <label className="flex flex-col gap-1.5 font-semibold text-ink">
            <span>{t("selectChildLabel")}</span>
            <select
              aria-label={t("selectChildLabel")}
              className="min-h-11 rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:outline-3 focus-visible:outline-primary"
              disabled={generating}
              onChange={(e) => setSelectedChildId(e.target.value)}
              value={activeChild?.id ?? ""}
            >
              {availableChildren.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.alias} ({t("gradeBadge", { grade: c.grade })})
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {/* Daily quota pill */}
        {activeQuota ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {preview ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-subtle px-3 py-1 text-xs font-extrabold text-ink">
                <Sparkles aria-hidden="true" className="size-3.5 text-primary" />
                {preview.child_alias} ·{" "}
                {t("gradeBadge", { grade: preview.child_grade })}
              </span>
            ) : null}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-extrabold ${
                activeQuota.quota_exceeded
                  ? "border-amber-300 bg-amber-50 text-amber-950"
                  : "border-sky-200 bg-sky-50 text-sky-950"
              }`}
              data-testid="micro-story-quota-badge"
            >
              {activeQuota.quota_exceeded
                ? t("quotaExceededBadge", { limit: activeQuota.daily_limit })
                : t("quotaAvailable", {
                    remaining: activeQuota.remaining_today,
                    limit: activeQuota.daily_limit,
                  })}
            </span>
          </div>
        ) : null}

        {loadingChildren || loadingPreview ? (
          <div
            aria-busy="true"
            className="flex flex-col items-center justify-center gap-3 rounded-card border border-border bg-canvas/60 py-8 text-center"
            data-testid="micro-story-preview-loading"
          >
            <RefreshCw
              aria-hidden="true"
              className="size-6 animate-spin text-primary"
            />
            <p className="font-semibold text-muted">{t("loadingPreview")}</p>
          </div>
        ) : !activeChild && availableChildren.length === 0 ? (
          <div className="flex flex-col gap-3 rounded-card border border-border bg-canvas/60 p-4">
            <p className="font-extrabold text-ink">{t("noChildrenTitle")}</p>
            <p className="text-muted">{t("noChildrenBody")}</p>
            <ButtonLink className="sm:w-auto sm:self-start" href="/children/new">
              {t("createChildAction")}
            </ButtonLink>
          </div>
        ) : previewError ? (
          <div className="flex flex-col gap-3">
            <StatusMessage tone="error">{previewError}</StatusMessage>
            <Button
              className="sm:w-auto sm:self-start"
              onClick={() => setReloadSeq((n) => n + 1)}
              variant="secondary"
            >
              <RefreshCw aria-hidden="true" className="size-4" />
              {t("retryPreviewAction")}
            </Button>
          </div>
        ) : createdStory ? (
          /* Success state with 1-click Open & Read CTA */
          <div
            className="flex flex-col gap-4"
            data-testid="micro-story-created-view"
          >
            <div className="flex flex-col gap-2 rounded-card border border-emerald-300 bg-emerald-50/80 p-4">
              <div className="inline-flex items-center gap-1.5 text-xs font-extrabold text-emerald-800">
                <CheckCircle2 aria-hidden="true" className="size-4" />
                <span>{t("createdBadge")}</span>
              </div>
              <h3
                className="book-title viread-learning-content text-xl font-black text-ink"
                dir="ltr"
                lang="vi"
              >
                {createdStory.title}
              </h3>
              <p className="text-xs leading-relaxed text-emerald-950">
                {t("createdSummary", {
                  wordCount: createdStory.target_weak_words.length,
                  questionCount: createdStory.comprehension_questions.length,
                  alias: createdStory.child_alias,
                })}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-xs font-bold text-muted">
                  {t("embeddedWordsLabel")}
                </span>
                {createdStory.target_weak_words.map((word) => (
                  <span
                    className="viread-learning-content rounded-full border border-emerald-300 bg-white px-2.5 py-0.5 text-xs font-extrabold text-emerald-900"
                    dir="ltr"
                    key={word.normalized_word}
                    lang="vi"
                  >
                    {word.display_text}
                  </span>
                ))}
              </div>
            </div>

            {createdStory.safety_status === "SANITIZED_FALLBACK" ? (
              <p className="rounded-control border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-950">
                {t("safetySanitizedNote")}
              </p>
            ) : null}

            {createdStory.illustration_fallback_used ? (
              <p className="rounded-control border border-border bg-canvas px-3 py-2 text-xs text-muted">
                {t("fallbackIllustrationNote")}
              </p>
            ) : null}

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {createdStory.pages.map((p) => (
                <div
                  className="flex flex-col gap-1 rounded-control border border-border bg-canvas/55 p-3"
                  key={p.page_id}
                >
                  <span className="text-[11px] font-extrabold uppercase tracking-wide text-primary">
                    {t("pagePreviewLabel", { page: p.page_number })}
                  </span>
                  <p
                    className="viread-learning-content line-clamp-3 text-xs leading-relaxed text-ink"
                    dir="ltr"
                    lang="vi"
                  >
                    {p.text}
                  </p>
                </div>
              ))}
            </div>

            <div className="flex flex-col gap-2.5 pt-1 sm:flex-row sm:items-center">
              <Link
                className="inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-control bg-primary px-4 text-sm font-extrabold text-white shadow-sm transition hover:bg-primary-hover"
                data-testid="open-created-micro-story-link"
                href={createdStory.reader_href}
                onClick={handleClose}
              >
                <BookOpen aria-hidden="true" className="size-4" />
                {t("openReaderPrimary")}
              </Link>
              <Link
                className="inline-flex min-h-12 items-center justify-center gap-1.5 rounded-control border border-border bg-white px-4 text-sm font-bold text-ink transition hover:bg-canvas"
                href={createdStory.my_book_href}
                onClick={handleClose}
              >
                {t("openMyBooksSecondary")}
              </Link>
            </div>
          </div>
        ) : (
          /* Word customization & generation form */
          <>
            {isQuotaExceeded ? (
              <StatusMessage
                title={t("quotaExceededTitle")}
                tone="warning"
              >
                {t("quotaExceededBody", {
                  limit: activeQuota?.daily_limit ?? 2,
                  alias: activeChild?.alias ?? "",
                })}
              </StatusMessage>
            ) : null}

            {preview?.cold_start_filled ? (
              <p className="rounded-control border border-sky-200 bg-sky-50/80 px-3 py-2 text-xs text-sky-950">
                {t("coldStartNotice", { grade: preview.child_grade })}
              </p>
            ) : null}

            <div className="flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-extrabold text-ink">
                  {t("targetWordsHeading")}
                </span>
                <span
                  className="rounded-full bg-surface-subtle px-2.5 py-0.5 text-xs font-extrabold text-primary"
                  data-testid="micro-story-selected-count"
                >
                  {t("selectedCountBadge", { count: selectedKeys.length })}
                </span>
              </div>

              <div
                aria-label={t("targetWordsHeading")}
                className="flex flex-wrap gap-2"
                role="group"
              >
                {candidates.map((item) => {
                  const isSelected = selectedKeys.includes(
                    item.normalized_word,
                  );
                  return (
                    <button
                      aria-pressed={isSelected}
                      className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 py-1.5 text-left text-xs font-bold transition focus-visible:outline-3 focus-visible:outline-primary ${
                        isSelected
                          ? "border-primary bg-primary text-white shadow-2xs"
                          : "border-border bg-white text-ink hover:bg-canvas"
                      }`}
                      data-testid={`micro-story-word-chip-${item.normalized_word}`}
                      disabled={generating}
                      key={item.normalized_word}
                      onClick={() => toggleWord(item.normalized_word)}
                      type="button"
                    >
                      {isSelected ? (
                        <Check aria-hidden="true" className="size-3.5 shrink-0" />
                      ) : (
                        <Plus aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                      )}
                      <span
                        className="viread-learning-content text-sm font-extrabold"
                        dir="ltr"
                        lang="vi"
                      >
                        {item.display_text}
                      </span>
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                          isSelected
                            ? "bg-white/20 text-white"
                            : "bg-surface-subtle text-muted"
                        }`}
                      >
                        {item.phonics_label_vi}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-muted">{t("minMaxWordsHint")}</p>
            </div>

            {/* Add custom word */}
            <div className="flex flex-col gap-1.5">
              <label
                className="text-xs font-bold text-ink"
                htmlFor="micro-story-custom-word-input"
              >
                {t("customWordLabel")}
              </label>
              <div className="flex gap-2">
                <input
                  className="min-h-11 flex-1 rounded-control border border-border bg-white px-3 text-sm text-ink placeholder:text-muted focus-visible:outline-3 focus-visible:outline-primary"
                  disabled={generating || isQuotaExceeded}
                  id="micro-story-custom-word-input"
                  maxLength={40}
                  onChange={(e) => setCustomWordInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddCustomWord();
                    }
                  }}
                  placeholder={t("customWordPlaceholder")}
                  type="text"
                  value={customWordInput}
                />
                <Button
                  className="min-h-11 w-auto shrink-0 px-3.5 text-xs"
                  disabled={
                    generating ||
                    isQuotaExceeded ||
                    customWordInput.trim().length < 2
                  }
                  fullWidth={false}
                  onClick={handleAddCustomWord}
                  type="button"
                  variant="secondary"
                >
                  <Plus aria-hidden="true" className="size-4" />
                  {t("addCustomWordAction")}
                </Button>
              </div>
            </div>

            {/* Optional theme hint */}
            <div className="flex flex-col gap-1.5">
              <label
                className="text-xs font-bold text-ink"
                htmlFor="micro-story-theme-input"
              >
                {t("themeHintLabel")}
              </label>
              <input
                className="min-h-11 w-full rounded-control border border-border bg-white px-3 text-sm text-ink placeholder:text-muted focus-visible:outline-3 focus-visible:outline-primary"
                disabled={generating || isQuotaExceeded}
                id="micro-story-theme-input"
                maxLength={160}
                onChange={(e) => setThemeHint(e.target.value)}
                placeholder={t("themeHintPlaceholder")}
                type="text"
                value={themeHint}
              />
            </div>

            {generating ? (
              <div
                className="rounded-card border border-primary/25 bg-cream/70 p-3.5"
                data-testid="micro-story-progress-container"
              >
                <AiProgressBar
                  active
                  label={genProgress.stageLabel ?? t("generatingAction")}
                  percent={genProgress.percent}
                  size="compact"
                  testId="micro-story-generating-progress"
                />
              </div>
            ) : null}

            {generateError ? (
              <StatusMessage tone="error">{generateError}</StatusMessage>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-border pt-3">
              <Button
                className="min-h-12 w-auto px-4"
                disabled={generating}
                fullWidth={false}
                onClick={handleClose}
                type="button"
                variant="secondary"
              >
                <X aria-hidden="true" className="size-4" />
                {t("cancelAction")}
              </Button>
              <Button
                className="min-h-12 w-auto px-5 font-extrabold"
                data-testid="generate-micro-story-submit"
                disabled={!canSubmit}
                fullWidth={false}
                isLoading={generating}
                onClick={() => void handleGenerate()}
                type="button"
              >
                <Sparkles aria-hidden="true" className="size-4" />
                {generating ? t("generatingAction") : t("generateAction")}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
