"use client";

import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";

import {
  AdminLoading,
  AdminPageHeader,
} from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminParentProfileItemDTO } from "@/types/admin";

const PAGE_SIZE = 10;

type LoadError = "auth" | "forbidden" | "unavailable";

function formatDate(value: string) {
  const date = new Date(value);

  return Number.isNaN(date.getTime())
    ? "Không rõ"
    : new Intl.DateTimeFormat("vi-VN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date);
}

export function AdminParentsScreen() {
  const { parents } = useAdminServices();
  const [items, setItems] = useState<
    readonly AdminParentProfileItemDTO[] | null
  >(null);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<LoadError | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setError(null);
    setItems(null);

    try {
      const page = await parents.list({
        search: search || undefined,
        limit: PAGE_SIZE,
        offset,
      });

      if (requestId !== requestIdRef.current) return;

      setItems(page.items);
      setTotal(page.total);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;

      setItems([]);
      setTotal(0);
      setError(
        isServiceError(cause) && cause.code === "AUTH_REQUIRED"
          ? "auth"
          : isServiceError(cause) && cause.code === "FORBIDDEN"
            ? "forbidden"
            : "unavailable",
      );
    }
  }, [offset, parents, search]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);

    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOffset(0);
    setSearch(searchInput.trim());
  }

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <AdminPageHeader
        eyebrow="Quản lý tài khoản"
        title="Danh sách phụ huynh"
        description="Xem hồ sơ phụ huynh đã đăng ký, ngày tạo tài khoản và số hồ sơ bé liên kết. Dữ liệu được tải từ database."
        actions={
          <Button
            className="sm:w-auto"
            onClick={() => void load()}
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-5" />
            Tải lại
          </Button>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="bg-white">
          <p className="text-sm font-bold text-muted">
            Tổng phụ huynh phù hợp
          </p>
          <div className="flex items-center gap-3">
            <UsersRound aria-hidden className="size-8 text-primary" />
            <p className="text-3xl font-black">
              {total.toLocaleString("vi-VN")}
            </p>
          </div>
        </Card>

        <Card className="bg-white">
          <p className="text-sm font-bold text-muted">Phạm vi danh sách</p>
          <p className="text-lg font-black">
            {total === 0
              ? "Chưa có dữ liệu"
              : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} / ${total}`}
          </p>
          <p className="text-sm text-muted">
            Sắp xếp theo ngày tạo mới nhất
          </p>
        </Card>
      </div>

      <Card className="mb-6 bg-white">
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={submitSearch}
        >
          <div className="min-w-0 flex-1">
            <TextField
              label="Tìm phụ huynh theo tên hiển thị"
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Nhập tên phụ huynh"
              value={searchInput}
            />
          </div>

          <Button className="sm:w-auto" type="submit">
            <Search aria-hidden className="size-5" />
            Tìm kiếm
          </Button>

          {search ? (
            <Button
              className="sm:w-auto"
              onClick={() => {
                setSearchInput("");
                setSearch("");
                setOffset(0);
              }}
              type="button"
              variant="secondary"
            >
              Xóa lọc
            </Button>
          ) : null}
        </form>
      </Card>

      {items === null ? (
        <AdminLoading label="Đang tải danh sách phụ huynh từ database…" />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? "Phiên đăng nhập không hợp lệ"
              : error === "forbidden"
                ? "Bạn không có quyền xem danh sách phụ huynh"
                : "Không thể tải danh sách phụ huynh"
          }
        >
          {error === "auth" ? (
            <Link className="font-extrabold underline" href="/admin/login">
              Đăng nhập lại
            </Link>
          ) : error === "forbidden" ? (
            "Chỉ tài khoản có role admin mới được phép xem dữ liệu này."
          ) : (
            <button
              className="font-extrabold underline"
              onClick={() => void load()}
              type="button"
            >
              Thử lại
            </button>
          )}
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          title={
            search
              ? "Không tìm thấy phụ huynh"
              : "Chưa có hồ sơ phụ huynh"
          }
          description={
            search
              ? "Thử tên khác hoặc xóa bộ lọc tìm kiếm."
              : "Các tài khoản có role parent sẽ xuất hiện ở đây khi đã có hồ sơ trong database."
          }
          action={
            search ? (
              <Button
                className="sm:w-auto"
                onClick={() => {
                  setSearchInput("");
                  setSearch("");
                  setOffset(0);
                }}
                variant="secondary"
              >
                Xóa bộ lọc
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="grid gap-4">
            {items.map((parent) => (
              <Card className="bg-white" key={parent.id}>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                  <div className="grid size-12 shrink-0 place-items-center rounded-full bg-sky text-primary">
                    <UsersRound aria-hidden className="size-6" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <h2 className="break-words text-xl font-black text-ink">
                      {parent.display_name?.trim() || "Chưa cập nhật tên"}
                    </h2>
                    <p className="mt-1 break-all text-xs text-muted">
                      ID: {parent.id}
                    </p>
                  </div>

                  <dl className="grid grid-cols-2 gap-3 sm:min-w-64">
                    <div className="rounded-control bg-canvas px-4 py-3">
                      <dt className="text-xs font-bold text-muted">
                        Ngày tạo
                      </dt>
                      <dd className="mt-1 font-bold">
                        {formatDate(parent.created_at)}
                      </dd>
                    </div>
                    <div className="rounded-control bg-canvas px-4 py-3">
                      <dt className="text-xs font-bold text-muted">
                        Hồ sơ bé
                      </dt>
                      <dd className="mt-1 font-bold">
                        {parent.children_count}
                      </dd>
                    </div>
                  </dl>
                  <div className="sm:w-auto">
                    <ButtonLink
                      className="sm:w-auto"
                      href={`/admin/parents/${encodeURIComponent(parent.id)}`}
                      variant="secondary"
                    >
                      Xem chi tiết
                      <ChevronRight aria-hidden className="size-5" />
                    </ButtonLink>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          <div className="mt-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <p className="text-sm text-muted">
              Trang {currentPage} / {totalPages}
            </p>

            <div className="flex gap-3">
              <Button
                className="sm:w-auto"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                type="button"
                variant="secondary"
              >
                <ChevronLeft aria-hidden className="size-5" />
                Trang trước
              </Button>

              <Button
                className="sm:w-auto"
                disabled={offset + PAGE_SIZE >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                type="button"
                variant="secondary"
              >
                Trang sau
                <ChevronRight aria-hidden className="size-5" />
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
