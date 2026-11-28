"use client";

import { BookOpen, Flower2, Mic, RefreshCw } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";

import { BookStampPassportModal } from "@/components/achievements/book-stamp-passport-modal";
import { PhonemeGardenCard } from "@/components/achievements/phoneme-garden-card";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { createChildService, type ChildService } from "@/lib/api/child-service";
import {
  createPhonemeGardenService,
  type PhonemeGardenService,
  type PhonemeGardenSummaryDTO,
} from "@/lib/api/phoneme-garden-service";
import { usePhonemeGardenTranslations } from "@/messages/features/phoneme_garden";
import type { ChildProfileDTO } from "@/types/child";

export interface ChildPhonemeGardenSectionProps {
  readonly childId: string;
  readonly gardenService?: PhonemeGardenService;
  readonly fullGardenHref?: string;
}

export function ChildPhonemeGardenSection({
  childId,
  gardenService,
  fullGardenHref,
}: ChildPhonemeGardenSectionProps) {
  const t = usePhonemeGardenTranslations();
  const resolvedService = useMemo(
    () => gardenService ?? createPhonemeGardenService(),
    [gardenService],
  );
  const [summaryState, setSummaryState] = useState<{
    readonly childId: string;
    readonly status: "loading" | "ready" | "error";
    readonly data: PhonemeGardenSummaryDTO | null;
  }>({
    childId,
    status: "loading",
    data: null,
  });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [passportOpen, setPassportOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void resolvedService
      .getChildSummary(childId, controller.signal)
      .then((summary) => {
        if (!active) return;
        setSummaryState({
          childId,
          status: "ready",
          data: summary,
        });
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setSummaryState({
          childId,
          status: "error",
          data: null,
        });
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [childId, reloadNonce, resolvedService]);

  const isCurrentChild = summaryState.childId === childId;
  if (!isCurrentChild || summaryState.status === "loading") {
    return (
      <div aria-busy="true" aria-label={t("loadingGarden")}>
        <Skeleton className="h-56 w-full rounded-card" />
      </div>
    );
  }

  if (summaryState.status === "error" || !summaryState.data) {
    return (
      <div className="space-y-3 rounded-card border border-border bg-white p-4">
        <StatusMessage tone="error">{t("errorGarden")}</StatusMessage>
        <Button
          fullWidth={false}
          onClick={() => {
            setSummaryState({ childId, status: "loading", data: null });
            setReloadNonce((n) => n + 1);
          }}
          size="compact"
          type="button"
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {t("retryAction")}
        </Button>
      </div>
    );
  }

  return (
    <>
      <PhonemeGardenCard
        fullGardenHref={fullGardenHref}
        onViewPassport={() => setPassportOpen(true)}
        summary={summaryState.data}
      />
      {passportOpen ? (
        <BookStampPassportModal
          onClose={() => setPassportOpen(false)}
          summary={summaryState.data}
        />
      ) : null}
    </>
  );
}

export interface AchievementsScreenProps {
  readonly requestedChildId?: string;
  readonly childService?: Pick<ChildService, "list">;
  readonly gardenService?: PhonemeGardenService;
}

export function AchievementsScreen({
  requestedChildId,
  childService,
  gardenService,
}: AchievementsScreenProps) {
  const t = usePhonemeGardenTranslations();
  const selectId = useId();
  const resolvedChildService = useMemo(
    () => childService ?? createChildService(),
    [childService],
  );
  const [childrenState, setChildrenState] = useState<
    | { readonly status: "loading" }
    | { readonly status: "error" }
    | {
        readonly status: "ready";
        readonly children: readonly ChildProfileDTO[];
      }
  >({ status: "loading" });
  const [selectedChildId, setSelectedChildId] = useState<string | null>(
    requestedChildId ?? null,
  );
  const [reloadChildrenKey, setReloadChildrenKey] = useState(0);

  useEffect(() => {
    let active = true;

    void resolvedChildService
      .list()
      .then((children) => {
        if (!active) return;
        setChildrenState({ status: "ready", children });
      })
      .catch(() => {
        if (!active) return;
        setChildrenState({ status: "error" });
      });

    return () => {
      active = false;
    };
  }, [reloadChildrenKey, resolvedChildService]);

  const activeChild: ChildProfileDTO | null = useMemo(() => {
    if (
      childrenState.status !== "ready" ||
      childrenState.children.length === 0
    ) {
      return null;
    }
    const preferredId = selectedChildId ?? requestedChildId ?? null;
    if (preferredId) {
      const matched = childrenState.children.find((c) => c.id === preferredId);
      if (matched) return matched;
    }
    return childrenState.children[0] ?? null;
  }, [childrenState, requestedChildId, selectedChildId]);

  if (childrenState.status === "loading") {
    return (
      <section className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:px-6">
        <Skeleton className="h-12 w-72 rounded-card" />
        <Skeleton className="h-80 w-full rounded-card" />
      </section>
    );
  }

  if (childrenState.status === "error") {
    return (
      <section className="mx-auto max-w-7xl space-y-4 px-4 py-6 sm:px-6">
        <StatusMessage tone="error">{t("errorGarden")}</StatusMessage>
        <Button
          fullWidth={false}
          onClick={() => {
            setChildrenState({ status: "loading" });
            setReloadChildrenKey((n) => n + 1);
          }}
          type="button"
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          {t("retryAction")}
        </Button>
      </section>
    );
  }

  if (!activeChild) {
    return (
      <section className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <EmptyState
          action={
            <ButtonLink href="/children">{t("createChildAction")}</ButtonLink>
          }
          description={t("noChildrenDescription")}
          icon={
            <Flower2 aria-hidden="true" className="size-10 text-emerald-700" />
          }
          title={t("noChildrenTitle")}
        />
      </section>
    );
  }

  return (
    <section
      className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6"
      data-testid="achievements-screen"
    >
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        {childrenState.children.length > 1 ? (
          <div className="max-w-xs">
            <label
              className="mb-1 block text-xs font-bold text-muted"
              htmlFor={selectId}
            >
              {t("selectChildLabel")}
            </label>
            <select
              aria-label={t("selectChildLabel")}
              className="min-h-11 w-full rounded-control border border-border bg-white px-3.5 text-sm font-bold text-ink"
              data-testid="achievements-child-selector"
              id={selectId}
              onChange={(event) => setSelectedChildId(event.target.value)}
              value={activeChild.id}
            >
              {childrenState.children.map((child) => (
                <option key={child.id} value={child.id}>
                  {t("childOptionLabel", {
                    alias: child.alias,
                    grade: child.grade,
                  })}
                </option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <ButtonLink
            className="min-h-11 px-4"
            href={`/books?childId=${encodeURIComponent(activeChild.id)}`}
            size="compact"
            variant="secondary"
          >
            <BookOpen aria-hidden="true" className="size-4" />
            {t("browseBooksAction")}
          </ButtonLink>
          <ButtonLink
            className="min-h-11 px-4"
            href={`/reports/difficult-words?childId=${encodeURIComponent(activeChild.id)}`}
            size="compact"
            variant="quiet"
          >
            <Mic aria-hidden="true" className="size-4" />
            {t("practiceWordsAction")}
          </ButtonLink>
        </div>
      </div>

      <ChildPhonemeGardenSection
        childId={activeChild.id}
        gardenService={gardenService}
      />
    </section>
  );
}
