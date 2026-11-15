"use client";

import { useEffect, useState } from "react";
import { Music2 } from "lucide-react";
import { KaraokeChildBoundary } from "@/components/karaoke/karaoke-child-boundary";
import { useKaraokeService } from "@/components/karaoke/karaoke-services-provider";
import { SongCard } from "@/components/karaoke/song-card";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
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
    <section className="mx-auto grid w-full max-w-[1120px] gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="font-bold text-primary">CÙNG BÉ HÁT MỖI NGÀY</p>
          <h1 className="mt-2 text-heading font-extrabold">
            Hát vui cùng {child.alias}
          </h1>
          <p className="mt-3 text-muted">
            Chọn bài hát phù hợp với lớp của bé. Chỉ hiển thị bài đã được admin
            xuất bản.
          </p>
        </div>
        <ButtonLink href="/dashboard" variant="secondary" className="sm:w-auto">
          Về Tổng quan
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
          Tìm bài hát hoặc tác giả
          <input
            className="min-h-12 w-full rounded-control border border-border bg-white px-4 focus-visible:outline-3 focus-visible:outline-primary"
            maxLength={120}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Button className="sm:w-auto" type="submit" variant="secondary">
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
          className="mt-3 sm:w-auto"
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
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
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
              : "Khi admin xuất bản bài hát phù hợp với lớp của bé, bài hát sẽ xuất hiện ở đây."
          }
        />
      )}
      <nav
        aria-label="Phân trang Hát vui"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <Button
          variant="secondary"
          className="sm:w-auto"
          disabled={query.offset === 0}
          onClick={() => onPage(Math.max(0, query.offset - 12))}
        >
          Trang trước
        </Button>
        <p>
          {data.items.length
            ? `${data.offset + 1}–${data.offset + data.items.length} / ${data.total} bài`
            : `0 / ${data.total} bài`}
        </p>
        <Button
          variant="secondary"
          className="sm:w-auto"
          disabled={query.offset + data.limit >= data.total}
          onClick={() => onPage(query.offset + data.limit)}
        >
          Trang sau
        </Button>
      </nav>
    </>
  );
}
