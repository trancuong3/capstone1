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
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState({ search: "", offset: 0, refresh: 0 });
  return (
    <section className="mx-auto grid w-full max-w-[1280px] gap-3.5 md:gap-6">
      <div className="flex items-center justify-between gap-2 md:flex-wrap md:items-start md:gap-4">
        <div className="min-w-0">
          <h1 className="line-clamp-2 break-words text-xl font-extrabold md:mt-2 md:line-clamp-none md:whitespace-normal md:text-heading">
            Hát vui cùng {child.alias}
          </h1>
          <p className="mt-3 hidden text-body text-muted md:block">
            Chọn một bài bé thích, nghe nhạc và cùng hát theo chữ nhé!
          </p>
        </div>
        <ButtonLink
          href="/dashboard"
          variant="secondary"
          className="min-h-11 w-auto shrink-0 px-3 py-2 text-xs md:px-5 md:text-label"
        >
          Về Tổng quan
        </ButtonLink>
      </div>
      <SelectedChildIdentity child={child} />
      <form
        className="flex flex-wrap items-end gap-2.5 md:gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery({
            search: search.trim(),
            offset: 0,
            refresh: query.refresh + 1,
          });
        }}
      >
        <label className="grid min-w-0 flex-1 gap-1.5 text-sm font-bold md:gap-2 md:text-base">
          Tìm bài hát hoặc tác giả
          <input
            className="min-h-11 w-full rounded-control border border-border bg-white px-3.5 focus-visible:outline-3 focus-visible:outline-primary md:min-h-12 md:px-4"
            maxLength={120}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Button
          className="w-full min-[640px]:w-auto"
          type="submit"
          variant="secondary"
        >
          Tìm bài hát
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
        Đang tìm những bài hát cho bé…
      </p>
    );
  if (state.status === "error")
    return (
      <StatusMessage tone="error" title="Chưa tải được thư viện">
        {state.message}
        <Button
          className="mt-3 w-full min-[640px]:w-auto"
          variant="secondary"
          onClick={onRetry}
        >
          Thử lại thư viện
        </Button>
      </StatusMessage>
    );
  const data = state.data;
  return (
    <>
      {data.items.length ? (
        <div className="grid gap-3.5 min-[640px]:grid-cols-2 md:gap-5 lg:grid-cols-3">
          {data.items.map((song) => (
            <SongCard key={`${song.song_id}:${song.version_id}`} song={song} />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Music2 aria-hidden className="size-10 text-primary" />}
          title="Chưa có bài hát phù hợp"
          description={
            query.search
              ? "Thử tìm bằng tên khác hoặc xóa từ khóa nhé."
              : "Những bài hát mới đang được chuẩn bị. Bé quay lại sau nhé!"
          }
        />
      )}
      <PaginationBar
        ariaLabel="Phân trang Hát vui"
        itemLabel="bài"
        nextLabel="Trang sau"
        onPageChange={(nextPage) =>
          onPage((nextPage - 1) * Math.max(1, data.limit))
        }
        page={Math.floor(query.offset / Math.max(1, data.limit)) + 1}
        pageSize={Math.max(1, data.limit)}
        prevLabel="Trang trước"
        total={data.total}
      />
    </>
  );
}
