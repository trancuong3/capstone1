"use client";

import { useEffect, useRef, useState } from "react";
import { Drum, Music2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { KaraokeChildBoundary } from "@/components/karaoke/karaoke-child-boundary";
import { useKaraokeService } from "@/components/karaoke/karaoke-services-provider";
import { MagicRhythmChantPanel } from "@/components/karaoke/magic-rhythm-chant-panel";
import { SongCard } from "@/components/karaoke/song-card";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useEntertainmentPreferences } from "@/hooks/use-entertainment-preferences";
import { useTranslations } from "@/hooks/use-i18n";
import {
  karaokeParentErrorMessage,
  type KaraokeCatalog,
} from "@/lib/api/karaoke-service";
import { resolveAutoPlayFlag } from "@/lib/entertainment/autopilot";
import type { ChildProfileDTO } from "@/types/child";

export interface KaraokeLibraryScreenProps {
  readonly autoPlay?: boolean;
  readonly initialMode?: "magic-chant";
}

export function KaraokeLibraryScreen({
  autoPlay,
  initialMode,
}: KaraokeLibraryScreenProps = {}) {
  const { autoPlayFlow } = useEntertainmentPreferences();
  const autoPlayRequested = resolveAutoPlayFlag(autoPlay);
  const [hasUrlMagicChantMode] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return (
        new URLSearchParams(window.location.search).get("mode") ===
        "magic-chant"
      );
    } catch {
      return false;
    }
  });
  const shouldAutoLaunch =
    autoPlayRequested &&
    autoPlayFlow &&
    initialMode !== "magic-chant" &&
    !hasUrlMagicChantMode;

  return (
    <KaraokeChildBoundary>
      {(child) => (
        <Library
          key={`${child.id}:${child.grade}`}
          autoPlay={shouldAutoLaunch}
          child={child}
          initialMode={initialMode}
        />
      )}
    </KaraokeChildBoundary>
  );
}
function Library({
  child,
  autoPlay,
  initialMode,
}: {
  child: ChildProfileDTO;
  autoPlay: boolean;
  initialMode?: "magic-chant";
}) {
  const t = useTranslations("entertainment");
  const { calmSound, reducedMotion, autopilotEnabled, setCalmSound } =
    useEntertainmentPreferences();
  const [urlFocusWords] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const incoming = new URLSearchParams(window.location.search);
      const raw =
        incoming.get("focus") ??
        incoming.get("focusWords") ??
        incoming.get("targetWords") ??
        "";
      return raw
        .split(",")
        .map((w) => w.trim())
        .filter(Boolean)
        .slice(0, 6);
    } catch {
      return [];
    }
  });
  const [isMagicChantOpen, setIsMagicChantOpen] = useState<boolean>(() => {
    if (initialMode === "magic-chant") return true;
    if (typeof window === "undefined") return false;
    try {
      return (
        new URLSearchParams(window.location.search).get("mode") ===
        "magic-chant"
      );
    } catch {
      return false;
    }
  });
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState({ search: "", offset: 0, refresh: 0 });

  if (isMagicChantOpen) {
    return (
      <MagicRhythmChantPanel
        autopilotEnabled={autopilotEnabled}
        calmSound={calmSound}
        child={child}
        focusWords={urlFocusWords}
        onExitToLibrary={() => setIsMagicChantOpen(false)}
        onToggleCalmSound={() => setCalmSound(!calmSound)}
        reducedMotion={reducedMotion}
      />
    );
  }

  return (
    <section className="mx-auto grid w-full max-w-[1120px] gap-4 pb-4">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-3.5">
        <div className="min-w-0">
          <h1 className="book-title text-2xl text-ink sm:text-[34px]">
            {t("karaoke.library.heading", { alias: child.alias })}
          </h1>
          <p className="mt-1 text-sm text-muted sm:text-base">
            {t("karaoke.library.subtitle")}
          </p>
        </div>
        <ButtonLink
          href="/dashboard"
          size="compact"
          variant="secondary"
          className="sm:w-auto"
        >
          {t("karaoke.library.backToDashboard")}
        </ButtonLink>
      </div>
      <SelectedChildIdentity child={child} />

      <div
        className="flex flex-col justify-between gap-4 rounded-card border-2 border-rose-200 bg-gradient-to-r from-rose-50 via-white to-amber-50/80 p-5 shadow-2xs sm:flex-row sm:items-center"
        data-testid="karaoke-magic-chant-card"
      >
        <div className="flex items-start gap-3.5">
          <span
            aria-hidden="true"
            className="grid size-14 shrink-0 place-items-center rounded-2xl bg-rose-100 text-rose-900 shadow-2xs"
          >
            <Drum className="size-7" />
          </span>
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-extrabold text-rose-950">
              <Sparkles aria-hidden="true" className="size-3.5" />
              {t("karaoke.magicChant.libraryBadge")}
            </span>
            <h2 className="mt-1 text-base font-extrabold text-ink sm:text-lg">
              {t("karaoke.magicChant.libraryCardTitle")}
            </h2>
            <p className="mt-0.5 text-sm font-semibold text-muted">
              {t("karaoke.magicChant.libraryCardDesc")}
            </p>
            {urlFocusWords.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {urlFocusWords.map((word) => (
                  <span
                    className="viread-learning-content rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-extrabold text-amber-950"
                    dir="ltr"
                    key={word}
                    lang="vi"
                  >
                    ⭐ {word}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <Button
          className="min-h-12 shrink-0 sm:w-auto"
          data-testid="karaoke-open-magic-chant-btn"
          onClick={() => setIsMagicChantOpen(true)}
          size="compact"
          type="button"
        >
          <Sparkles aria-hidden="true" className="size-4" />
          {t("karaoke.magicChant.libraryOpenCta")}
        </Button>
      </div>

      <form
        className="flex flex-wrap items-end gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery({
            search: search.trim(),
            offset: 0,
            refresh: query.refresh + 1,
          });
        }}
      >
        <label className="grid min-w-0 flex-1 gap-1.5 text-sm font-bold text-ink">
          {t("karaoke.library.searchLabel")}
          <input
            className="h-12 min-h-12 w-full rounded-control border border-border bg-white px-3.5 text-sm focus-visible:outline-3 focus-visible:outline-primary"
            maxLength={120}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Button
          className="h-12 sm:w-auto"
          size="compact"
          type="submit"
          variant="secondary"
        >
          {t("karaoke.library.searchAction")}
        </Button>
      </form>
      <Catalog
        key={`${query.search}:${query.offset}:${query.refresh}`}
        autoPlay={autoPlay}
        childId={child.id}
        query={query}
        onOpenMagicChant={() => setIsMagicChantOpen(true)}
        onRetry={() => setQuery({ ...query, refresh: query.refresh + 1 })}
        onPage={(offset) => setQuery({ ...query, offset })}
      />
    </section>
  );
}
function Catalog({
  autoPlay,
  childId,
  query,
  onOpenMagicChant,
  onRetry,
  onPage,
}: {
  autoPlay: boolean;
  childId: string;
  query: { search: string; offset: number };
  onOpenMagicChant: () => void;
  onRetry: () => void;
  onPage: (offset: number) => void;
}) {
  const t = useTranslations("entertainment");
  const router = useRouter();
  const service = useKaraokeService();
  const redirectedRef = useRef(false);
  const [launchQuery] = useState(() => {
    if (typeof window === "undefined") return "";
    try {
      const incoming = new URLSearchParams(window.location.search);
      const out = new URLSearchParams();
      const autopilot = incoming.get("autopilot");
      const focus =
        incoming.get("focus") ??
        incoming.get("focusWords") ??
        incoming.get("targetWords");
      if (autopilot) out.set("autopilot", autopilot);
      if (focus) out.set("focus", focus);
      return out.toString();
    } catch {
      return "";
    }
  });
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; data: KaraokeCatalog }
    | { status: "error"; message: string }
  >({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    service
      .list(
        childId,
        { search: query.search, offset: query.offset },
        controller.signal,
      )
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            status: "error",
            message: karaokeParentErrorMessage(error),
          });
      });
    return () => controller.abort();
  }, [childId, service, query.search, query.offset]);

  const autoLaunchSong =
    autoPlay &&
    query.search === "" &&
    query.offset === 0 &&
    state.status === "ready" &&
    state.data.items.length > 0
      ? state.data.items[0]
      : null;

  useEffect(() => {
    if (!autoLaunchSong || redirectedRef.current) return;
    redirectedRef.current = true;
    const extraQuery = launchQuery ? `&${launchQuery}` : "";
    router.replace(
      `/karaoke/${autoLaunchSong.song_id}?version=${autoLaunchSong.version_id}&autoplay=1&scored=1${extraQuery}`,
    );
  }, [autoLaunchSong, launchQuery, router]);

  if (state.status === "loading" || autoLaunchSong)
    return (
      <p
        className="rounded-card bg-sky p-6"
        data-testid={
          autoLaunchSong ? "karaoke-autoplay-redirecting" : undefined
        }
        role="status"
      >
        {autoLaunchSong
          ? t("karaoke.stage.autoplayPreparing")
          : t("karaoke.library.loading")}
      </p>
    );
  if (state.status === "error")
    return (
      <StatusMessage tone="error" title={t("karaoke.library.loadErrorTitle")}>
        {state.message}
        <Button
          className="mt-3 sm:w-auto"
          variant="secondary"
          onClick={onRetry}
        >
          {t("karaoke.library.retry")}
        </Button>
      </StatusMessage>
    );
  const data = state.data;
  const hasDifficultMatches = data.items.some((song) =>
    song.matched_difficult_words?.some((word) => word.trim().length > 0),
  );
  return (
    <>
      {data.items.length ? (
        <>
          {hasDifficultMatches && (
            <p
              data-testid="karaoke-difficult-words-boost-hint"
              className="rounded-control border border-amber-200 bg-amber-50/80 px-4 py-2.5 text-sm font-semibold text-amber-950"
            >
              {t("karaoke.library.difficultWordsBoostHint")}
            </p>
          )}
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {data.items.map((song) => (
              <SongCard
                key={`${song.song_id}:${song.version_id}`}
                launchQuery={launchQuery}
                song={song}
              />
            ))}
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <EmptyState
            icon={<Music2 aria-hidden className="size-10 text-primary" />}
            title={t("karaoke.library.emptyTitle")}
            description={
              query.search
                ? t("karaoke.library.emptySearchDesc")
                : t("karaoke.library.emptyCatalogDesc")
            }
          />
          <Button
            className="sm:w-auto"
            data-testid="karaoke-empty-magic-chant-cta"
            onClick={onOpenMagicChant}
            size="compact"
            type="button"
            variant="secondary"
          >
            <Sparkles aria-hidden="true" className="size-4" />
            {t("karaoke.magicChant.libraryOpenCta")}
          </Button>
        </div>
      )}
      <PaginationBar
        ariaLabel={t("karaoke.library.paginationAria")}
        itemLabel={t("karaoke.library.paginationItem")}
        nextLabel={t("karaoke.library.nextPage")}
        onPageChange={(nextPage) =>
          onPage((nextPage - 1) * Math.max(1, data.limit))
        }
        page={Math.floor(query.offset / Math.max(1, data.limit)) + 1}
        pageSize={Math.max(1, data.limit)}
        prevLabel={t("karaoke.library.prevPage")}
        total={data.total}
      />
    </>
  );
}
