"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { karaokeInputClass } from "@/components/admin/karaoke/song-metadata-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminKaraoke } from "@/components/karaoke/karaoke-services-provider";
import { karaokeErrorMessage } from "@/lib/api/admin-karaoke-service";
import { formatKaraokeTime } from "@/lib/karaoke/lyrics-timeline";
import type { AdminKaraokeList } from "@/types/karaoke";

export const karaokeStatusLabels = {
  DRAFT: "Bản nháp",
  PUBLISHED: "Đang hiển thị",
  HIDDEN: "Đã ẩn",
};
export function KaraokeLibraryScreen() {
  const service = useAdminKaraoke();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | "DRAFT" | "PUBLISHED" | "HIDDEN">(
    "",
  );
  const [query, setQuery] = useState({ search: "", status, offset: 0 });
  const [data, setData] = useState<AdminKaraokeList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const mutation = useRef<AbortController | null>(null);
  useEffect(() => () => mutation.current?.abort(), []);
  useEffect(() => {
    const controller = new AbortController();
    service
      .list({ ...query, status: query.status || undefined }, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(karaokeErrorMessage(e));
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [service, query, reload]);
  function refresh() {
    setError("");
    setLoading(true);
    setReload((n) => n + 1);
  }
  function filter(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setQuery({ search: search.trim(), status, offset: 0 });
  }
  async function visibility(item: AdminKaraokeList["items"][number]) {
    if (mutation.current) return;
    const visible = item.status === "HIDDEN";
    if (
      !window.confirm(
        `${visible ? "Hiện lại" : "Ẩn"} bài hát “${item.title}” cho trẻ?`,
      )
    )
      return;
    const controller = new AbortController();
    mutation.current = controller;
    setBusy(true);
    setError("");
    try {
      await service.visibility(
        item.song_id,
        item.revision,
        visible,
        controller.signal,
      );
      if (!controller.signal.aborted) refresh();
    } catch (e) {
      if (!controller.signal.aborted) setError(karaokeErrorMessage(e));
    } finally {
      mutation.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="grid gap-6">
      <AdminPageHeader
        eyebrow="NỘI DUNG CHO BÉ"
        title="Bài hát"
        description="Quản lý nhạc nền, lời và thời gian hiển thị từng câu. Bản nháp không xuất hiện trong thư viện của trẻ."
        actions={<ButtonLink href="/admin/karaoke/new">Tạo bài hát</ButtonLink>}
      />
      <Card>
        <form
          onSubmit={filter}
          className="grid items-end gap-4 md:grid-cols-[2fr_1fr_auto]"
        >
          <label className="grid gap-2 font-bold">
            Tìm bài hát
            <input
              className={karaokeInputClass}
              value={search}
              maxLength={120}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label className="grid gap-2 font-bold">
            Trạng thái
            <select
              className={karaokeInputClass}
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
            >
              <option value="">Tất cả</option>
              {Object.entries(karaokeStatusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" disabled={busy}>
            Áp dụng
          </Button>
        </form>
      </Card>
      {error && (
        <StatusMessage tone="error">
          {error}
          <Button
            className="mt-3 sm:w-auto"
            variant="quiet"
            onClick={refresh}
            disabled={busy}
          >
            Thử tải lại
          </Button>
        </StatusMessage>
      )}
      {loading ? (
        <AdminLoading label="Đang tải bài hát…" />
      ) : (
        !error &&
        data && (
          <>
            {!data.items.length ? (
              <Card>
                <p>
                  Chưa có bài hát phù hợp. Tạo bản nháp để tải nhạc và lời của
                  bạn lên.
                </p>
              </Card>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {data.items.map((item) => (
                  <Card key={item.song_id}>
                    <p className="text-sm font-bold text-primary-hover">
                      {karaokeStatusLabels[item.status]}
                      {item.published_version_id && item.draft_version_id
                        ? " · Có bản đang sửa"
                        : ""}
                    </p>
                    <h2 className="break-words text-xl font-extrabold">
                      {item.title || "Bài hát chưa đặt tên"}
                    </h2>
                    <p className="break-words text-muted">
                      {item.author || "Chưa có tác giả"} · Lớp {item.min_grade}–
                      {item.max_grade}
                    </p>
                    <p>
                      {item.has_audio && item.duration_ms !== null
                        ? `Nhạc ${formatKaraokeTime(item.duration_ms)}`
                        : "Chưa có nhạc"}
                    </p>
                    <div className="mt-auto flex flex-wrap gap-2">
                      <ButtonLink
                        href={`/admin/karaoke/${item.song_id}/edit`}
                        variant="secondary"
                        className="sm:w-auto"
                      >
                        Chi tiết / Chỉnh sửa
                      </ButtonLink>
                      {item.published_version_id && (
                        <Button
                          variant="quiet"
                          className="sm:w-auto"
                          disabled={busy}
                          onClick={() => void visibility(item)}
                        >
                          {item.status === "HIDDEN" ? "Hiện lại" : "Ẩn bài hát"}
                        </Button>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
            <nav
              aria-label="Phân trang bài hát"
              className="flex flex-wrap items-center justify-between gap-3"
            >
              <Button
                className="sm:w-auto"
                variant="secondary"
                disabled={query.offset === 0 || busy}
                onClick={() => {
                  setLoading(true);
                  setQuery({
                    ...query,
                    offset: Math.max(0, query.offset - 12),
                  });
                }}
              >
                Trang trước
              </Button>
              <p>
                {data.items.length
                  ? `${data.offset + 1}–${Math.min(data.offset + data.items.length, data.total)} / ${data.total} bài`
                  : `0 / ${data.total} bài`}
              </p>
              <Button
                className="sm:w-auto"
                variant="secondary"
                disabled={query.offset + 12 >= data.total || busy}
                onClick={() => {
                  setLoading(true);
                  setQuery({ ...query, offset: query.offset + 12 });
                }}
              >
                Trang sau
              </Button>
            </nav>
          </>
        )
      )}
    </div>
  );
}
