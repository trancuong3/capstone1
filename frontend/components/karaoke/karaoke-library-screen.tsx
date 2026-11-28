"use client";

import { useEffect, useRef, useState } from "react";
import { Music2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { KaraokeChildBoundary } from "@/components/karaoke/karaoke-child-boundary";
import { useKaraokeService } from "@/components/karaoke/karaoke-services-provider";
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

export function KaraokeLibraryScreen({
  autoPlay,
}: {
  readonly autoPlay?: boolean;
} = {}) {
  const { autoPlayFlow } = useEntertainmentPreferences();
  const autoPlayRequested = resolveAutoPlayFlag(autoPlay);
  const shouldAutoLaunch = autoPlayRequested && autoPlayFlow;

  return (
    <KaraokeChildBoundary>
      {(child) => (
        <Library
          key={`${child.id}:${child.grade}`}
          autoPlay={shouldAutoLaunch}
          child={child}
        />
      )}
    </KaraokeChildBoundary>
  );
}
function Library({
  child,
  autoPlay,
}: {
  child: ChildProfileDTO;
  autoPlay: boolean;
}) {
  const t = useTranslations("entertainment");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState({ search: "", offset: 0, refresh: 0 });
  return (
    <section className="mx-auto grid w-full max-w-[1280px] gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mt-2 text-heading font-extrabold">
            {t("karaoke.library.heading", { alias: child.alias })}
          </h1>
          <p className="mt-3 text-body text-muted">
            {t("karaoke.library.subtitle")}
          </p>
        </div>
        <ButtonLink href="/dashboard" variant="secondary" className="sm:w-auto">
          {t("karaoke.library.backToDashboard")}
        </ButtonLink>
      </div>
      <SelectedChildIdentity child={child} />
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery({
            search: search.trim(),
            offset: 0,
            refresh: query.refresh + 1,
          });
        }}
      >
        <label className="grid min-w-0 flex-1 gap-2 font-bold">
          {t("karaoke.library.searchLabel")}
          <input
            className="min-h-12 w-full rounded-control border border-border bg-white px-4 focus-visible:outline-3 focus-visible:outline-primary"
            maxLength={120}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Button className="sm:w-auto" type="submit" variant="secondary">
          {t("karaoke.library.searchAction")}
        </Button>
      </form>
      <Catalog
        key={`${query.search}:${query.offset}:${query.refresh}`}
        autoPlay={autoPlay}
        childId={child.id}
        query={query}
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
  onRetry,
  onPage,
}: {
  autoPlay: boolean;
  childId: string;
  query: { search: string; offset: number };
  onRetry: () => void;
  onPage: (offset: number) => void;
}) {
  const t = useTranslations("entertainment");
  const router = useRouter();
  const service = useKaraokeService();
  const redirectedRef = useRef(false);
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
    router.replace(
      `/karaoke/${autoLaunchSong.song_id}?version=${autoLaunchSong.version_id}&autoplay=1&scored=1`,
    );
  }, [autoLaunchSong, router]);

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
                song={song}
              />
            ))}
          </div>
        </>
      ) : (
        <EmptyState
          icon={<Music2 aria-hidden className="size-10 text-primary" />}
          title={t("karaoke.library.emptyTitle")}
          description={
            query.search
              ? t("karaoke.library.emptySearchDesc")
              : t("karaoke.library.emptyCatalogDesc")
          }
        />
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
