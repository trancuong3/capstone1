"use client";

import { useEffect, useState } from "react";
import { Music2 } from "lucide-react";
import { KaraokeChildBoundary } from "@/components/karaoke/karaoke-child-boundary";
import { useKaraokeService } from "@/components/karaoke/karaoke-services-provider";
import { SongCard } from "@/components/karaoke/song-card";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";
import {
  karaokeParentErrorMessage,
  type KaraokeCatalog,
} from "@/lib/api/karaoke-service";
import type { ChildProfileDTO } from "@/types/child";

export function KaraokeLibraryScreen() {
  return (
    <KaraokeChildBoundary>
      {(child) => <Library key={`${child.id}:${child.grade}`} child={child} />}
    </KaraokeChildBoundary>
  );
}
function Library({ child }: { child: ChildProfileDTO }) {
  const t = useTranslations("entertainment");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState({ search: "", offset: 0, refresh: 0 });
  return (
    <section className="mx-auto grid w-full max-w-[1280px] gap-3.5 pb-24 sm:gap-6 sm:pb-4">
      <div className="flex flex-wrap items-start justify-between gap-2.5 sm:gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold sm:mt-2 sm:text-heading">
            {t("karaoke.library.heading", { alias: child.alias })}
          </h1>
          <p className="mt-1 text-sm text-muted sm:mt-3 sm:text-body">
            {t("karaoke.library.subtitle")}
          </p>
        </div>
        <ButtonLink
          href="/dashboard"
          variant="secondary"
          className="min-h-10 w-auto px-3 py-1.5 text-xs sm:min-h-12 sm:px-4 sm:text-button"
        >
          {t("karaoke.library.backToDashboard")}
        </ButtonLink>
      </div>
      <SelectedChildIdentity child={child} />
      <form
        className="flex flex-wrap items-end gap-2.5 sm:gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery({
            search: search.trim(),
            offset: 0,
            refresh: query.refresh + 1,
          });
        }}
      >
        <label className="grid min-w-0 flex-1 gap-1.5 text-sm font-bold sm:gap-2 sm:text-base">
          {t("karaoke.library.searchLabel")}
          <input
            className="min-h-11 w-full rounded-control border border-border bg-white px-3.5 focus-visible:outline-3 focus-visible:outline-primary sm:min-h-12 sm:px-4"
            maxLength={120}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Button
          className="min-h-11 sm:min-h-12 sm:w-auto"
          type="submit"
          variant="secondary"
        >
          {t("karaoke.library.searchAction")}
        </Button>
      </form>
      <Catalog
        key={`${query.search}:${query.offset}:${query.refresh}`}
        childId={child.id}
        query={query}
        onRetry={() => setQuery({ ...query, refresh: query.refresh + 1 })}
        onPage={(offset) => setQuery({ ...query, offset })}
      />
    </section>
  );
}
function Catalog({
  childId,
  query,
  onRetry,
  onPage,
}: {
  childId: string;
  query: { search: string; offset: number };
  onRetry: () => void;
  onPage: (offset: number) => void;
}) {
  const t = useTranslations("entertainment");
  const service = useKaraokeService();
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
  if (state.status === "loading")
    return (
      <p className="rounded-card bg-sky p-6" role="status">
        {t("karaoke.library.loading")}
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
  return (
    <>
      {data.items.length ? (
        <div className="grid gap-3.5 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3">
          {data.items.map((song) => (
            <SongCard key={`${song.song_id}:${song.version_id}`} song={song} />
          ))}
        </div>
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
