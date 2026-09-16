"use client";

import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AdminLoading,
  AdminPageHeader,
  AdminStatusBadge,
} from "@/components/admin/admin-ui";
import { ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminBookListItemUI } from "@/types/admin";
import type { BookLifecycleStatus } from "@/types/book";
import type { PageRevisionVerificationStatus } from "@/types/reading";

export function AdminBooksScreen() {
  const { books } = useAdminServices();
  const [items, setItems] = useState<readonly AdminBookListItemUI[] | null>(
    null,
  );
  const [error, setError] = useState<"auth" | "forbidden" | "safe" | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [lifecycle, setLifecycle] = useState<BookLifecycleStatus | "">("");
  const [verification, setVerification] = useState<
    PageRevisionVerificationStatus | ""
  >("");
  const requestIdRef = useRef(0);
  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setError(null);
    setItems(null);
    try {
      const nextItems = await books.list({
        search,
        lifecycle_status: lifecycle || undefined,
        verification_status: verification || undefined,
      });
      if (requestId !== requestIdRef.current) return;
      setItems(nextItems);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setError(
        isServiceError(cause) && cause.code === "AUTH_REQUIRED"
          ? "auth"
          : isServiceError(cause) && cause.code === "FORBIDDEN"
            ? "forbidden"
            : "safe",
      );
      setItems([]);
    }
  }, [books, lifecycle, search, verification]);
  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);
  return (
    <>
      <AdminPageHeader
        eyebrow="Quản trị nội dung"
        title="Kho sách"
        description="Theo dõi vòng đời sách và trạng thái OCR của từng trang."
        actions={
          <ButtonLink className="sm:w-auto" href="/admin/books/new">
            <Plus aria-hidden className="size-5" /> Thêm sách
          </ButtonLink>
        }
      />
      <Card className="mb-6 bg-white">
        <div className="grid gap-4 lg:grid-cols-[1fr_240px_240px]">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute right-5 top-9 size-5 text-muted"
            />
            <TextField
              label="Tìm theo tên sách hoặc tác giả"
              onChange={(event) => setSearch(event.target.value)}
              value={search}
            />
          </div>
          <SelectField
            label="Vòng đời"
            onChange={(event) =>
              setLifecycle(event.target.value as BookLifecycleStatus | "")
            }
            value={lifecycle}
          >
            <option value="">Tất cả</option>
            <option value="ACTIVE">ACTIVE</option>
            <option value="RETIRED">RETIRED</option>
          </SelectField>
          <SelectField
            label="Trạng thái OCR"
            onChange={(event) =>
              setVerification(
                event.target.value as PageRevisionVerificationStatus | "",
              )
            }
            value={verification}
          >
            <option value="">Tất cả</option>
            <option value="PROCESSING">PROCESSING</option>
            <option value="NEEDS_REVIEW">NEEDS_REVIEW</option>
            <option value="VERIFIED">VERIFIED</option>
          </SelectField>
        </div>
      </Card>
      {items === null ? (
        <AdminLoading />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? "Cần đăng nhập quản trị"
              : error === "forbidden"
                ? "Không có quyền truy cập"
                : "Không thể tải kho sách"
          }
        >
          {error === "safe" ? (
            <button
              className="mt-2 inline-flex min-h-11 items-center rounded-md px-1 font-extrabold underline focus-visible:outline-3 focus-visible:outline-primary"
              onClick={() => void load()}
              type="button"
            >
              Thử lại
            </button>
          ) : (
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/login"
            >
              Đến trang đăng nhập
            </Link>
          )}
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          description="Điều chỉnh bộ lọc hoặc tạo sách mới."
          title="Không tìm thấy sách"
        />
      ) : (
        <div className="grid gap-4">
          {items.map((item) => (
            <Link
              className="rounded-card focus-visible:outline-3 focus-visible:outline-primary"
              href={`/admin/books/${item.book.id}`}
              key={item.book.id}
            >
              <Card className="bg-white transition-transform hover:-translate-y-0.5 hover:shadow-lg">
                <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-center">
                  <div>
                    <div className="mb-2 flex flex-wrap gap-2">
                      <AdminStatusBadge status={item.book.lifecycle_status} />
                      {item.parent_catalog_eligible ? (
                        <span className="rounded-full bg-sky px-3 py-1 text-sm font-extrabold text-primary-hover">
                          Có trong thư viện ba mẹ
                        </span>
                      ) : null}
                    </div>
                    <h2 className="text-2xl font-black">{item.book.title}</h2>
                    <p className="text-muted">
                      {item.book.author ?? "Chưa có tác giả"} · Khối{" "}
                      {item.book.min_grade}–{item.book.max_grade}
                    </p>
                  </div>
                  <dl className="grid grid-cols-4 gap-3 text-center">
                    <Metric label="Trang" value={item.page_count} />
                    <Metric label="Xử lý" value={item.processing_count} />
                    <Metric label="Cần duyệt" value={item.needs_review_count} />
                    <Metric label="Đã duyệt" value={item.verified_count} />
                  </dl>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-control bg-canvas px-3 py-2">
      <dt className="text-xs font-bold text-muted">{label}</dt>
      <dd className="text-xl font-black">{value}</dd>
    </div>
  );
}
