"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { RefreshCw, Search } from "lucide-react";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { SelectField } from "@/components/common/select-field";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type {
  MetadataQualityDashboardDTO,
  MetadataQualityIssueType,
  MetadataQualityLifecycleStatus,
} from "@/types/metadata-quality";

const issueLabels: Record<MetadataQualityIssueType, string> = {
  MISSING_TITLE: "Thiếu tiêu đề",
  MISSING_AUTHOR: "Chưa có tác giả",
  INVALID_GRADE_RANGE: "Khoảng lớp không hợp lệ",
  POSSIBLE_DUPLICATE: "Có thể trùng sách",
};

const lifecycleLabels: Record<string, string> = {
  ACTIVE: "Đang hoạt động",
  RETIRED: "Đã ngừng",
};

export function AdminMetadataQualityScreen() {
  const { metadataQuality } = useAdminServices();
  const [dashboard, setDashboard] =
    useState<MetadataQualityDashboardDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<"auth" | "forbidden" | "safe" | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [issueType, setIssueType] = useState<MetadataQualityIssueType | "">("");
  const [lifecycle, setLifecycle] = useState<
    MetadataQualityLifecycleStatus | ""
  >("");
  const [offset, setOffset] = useState(0);
  const requestIdRef = useRef(0);
  const limit = 10;

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await metadataQuality.get({
        search: search.trim() || undefined,
        issue_type: issueType || undefined,
        lifecycle_status: lifecycle || undefined,
        limit,
        offset,
      });
      if (requestId !== requestIdRef.current) return;
      setDashboard(next);
    } catch (cause) {
      if (requestId !== requestIdRef.current) return;
      setDashboard(null);
      setError(
        isServiceError(cause) && cause.code === "AUTH_REQUIRED"
          ? "auth"
          : isServiceError(cause) && cause.code === "FORBIDDEN"
            ? "forbidden"
            : "safe",
      );
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [issueType, lifecycle, metadataQuality, offset, search]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 180);
    return () => {
      globalThis.clearTimeout(timeout);
      requestIdRef.current += 1;
    };
  }, [load]);

  function clearFilters() {
    setSearch("");
    setIssueType("");
    setLifecycle("");
    setOffset(0);
  }

  const firstItem = dashboard && dashboard.total > 0 ? dashboard.offset + 1 : 0;
  const lastItem = dashboard
    ? Math.min(dashboard.offset + dashboard.limit, dashboard.total)
    : 0;
  const hasFilters = Boolean(search.trim() || issueType || lifecycle);

  return (
    <>
      <AdminPageHeader
        eyebrow="Quản trị nội dung"
        title="Chất lượng metadata sách"
        description="Phát hiện thông tin catalog cần kiểm tra. Các cảnh báo là gợi ý để Admin xem xét, không tự sửa hoặc xóa dữ liệu sách."
        actions={
          <button
            className="inline-flex min-h-12 items-center justify-center gap-2 rounded-control border border-border bg-white px-4 font-bold text-ink hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
            disabled={loading}
            onClick={() => void load()}
            type="button"
          >
            <RefreshCw aria-hidden className="size-4" />
            Tải lại
          </button>
        }
      />

      <section
        aria-label="Bộ lọc chất lượng metadata"
        className="mb-6 rounded-card border border-border bg-white p-4 sm:p-6"
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px_200px]">
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute right-4 top-9 size-5 text-muted"
            />
            <TextField
              label="Tìm theo tiêu đề hoặc tác giả"
              onChange={(event) => {
                setOffset(0);
                setSearch(event.target.value);
              }}
              value={search}
            />
          </div>
          <SelectField
            label="Loại vấn đề"
            onChange={(event) => {
              setOffset(0);
              setIssueType(event.target.value as MetadataQualityIssueType | "");
            }}
            value={issueType}
          >
            <option value="">Tất cả vấn đề</option>
            <option value="MISSING_TITLE">Thiếu tiêu đề</option>
            <option value="MISSING_AUTHOR">Chưa có tác giả</option>
            <option value="INVALID_GRADE_RANGE">Khoảng lớp không hợp lệ</option>
            <option value="POSSIBLE_DUPLICATE">Có thể trùng sách</option>
          </SelectField>
          <SelectField
            label="Vòng đời sách"
            onChange={(event) => {
              setOffset(0);
              setLifecycle(
                event.target.value as MetadataQualityLifecycleStatus | "",
              );
            }}
            value={lifecycle}
          >
            <option value="">Tất cả trạng thái</option>
            <option value="ACTIVE">Đang hoạt động</option>
            <option value="RETIRED">Đã ngừng</option>
          </SelectField>
        </div>
        {hasFilters ? (
          <button
            className="mt-4 min-h-10 rounded-control px-2 font-bold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
            onClick={clearFilters}
            type="button"
          >
            Xóa bộ lọc
          </button>
        ) : null}
      </section>

      {loading ? (
        <AdminLoading label="Đang kiểm tra metadata catalog…" />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? "Cần đăng nhập quản trị"
              : error === "forbidden"
                ? "Không có quyền truy cập"
                : "Không thể tải dữ liệu chất lượng metadata"
          }
        >
          {error === "auth" ? (
            <Link
              className="inline-flex min-h-11 items-center rounded-md px-1 font-extrabold underline focus-visible:outline-3 focus-visible:outline-primary"
              href="/admin/login"
            >
              Đến trang đăng nhập
            </Link>
          ) : error === "safe" ? (
            <button
              className="mt-2 inline-flex min-h-11 items-center rounded-md px-1 font-extrabold underline focus-visible:outline-3 focus-visible:outline-primary"
              onClick={() => void load()}
              type="button"
            >
              Thử lại
            </button>
          ) : (
            <p>Hãy sử dụng tài khoản có quyền Admin để mở dashboard này.</p>
          )}
        </StatusMessage>
      ) : dashboard ? (
        <>
          <section
            aria-label="Tổng quan metadata"
            className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          >
            {[
              {
                label: "Tổng số sách",
                value: dashboard.summary.total_books,
                detail: "Toàn bộ catalog Admin",
              },
              {
                label: "Sách cần kiểm tra",
                value: dashboard.summary.books_with_issues,
                detail: "Mỗi sách chỉ tính một lần",
              },
              {
                label: "Thiếu tiêu đề",
                value: dashboard.summary.missing_title,
                detail: "Tiêu đề rỗng hoặc chỉ có khoảng trắng",
              },
              {
                label: "Chưa có tác giả",
                value: dashboard.summary.missing_author,
                detail: "Cảnh báo bổ sung metadata",
              },
              {
                label: "Khoảng lớp không hợp lệ",
                value: dashboard.summary.invalid_grade_range,
                detail: "Ngoài lớp 1–5 hoặc lớp tối thiểu lớn hơn lớp tối đa",
              },
              {
                label: "Nhóm có thể trùng",
                value: dashboard.summary.possible_duplicate_groups,
                detail:
                  dashboard.summary.books_in_duplicate_groups +
                  " sách nằm trong các nhóm ứng viên",
              },
            ].map((metric) => (
              <article
                className="rounded-card border border-border bg-white p-5"
                key={metric.label}
              >
                <p className="text-sm font-bold text-muted">{metric.label}</p>
                <p className="mt-2 text-3xl font-black tabular-nums text-ink">
                  {metric.value.toLocaleString("vi-VN")}
                </p>
                <p className="mt-2 text-sm text-muted">{metric.detail}</p>
              </article>
            ))}
          </section>

          <section className="rounded-card border border-border bg-white p-4 sm:p-6">
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-xl font-black text-ink">
                  Sách cần kiểm tra
                </h2>
                <p className="mt-1 text-sm text-muted">
                  Các trường hợp trùng chỉ dựa trên tiêu đề và tác giả sau khi
                  bỏ khoảng trắng ngoài và không phân biệt chữ hoa/chữ thường.
                </p>
              </div>
              <p aria-live="polite" className="text-sm font-bold text-muted">
                {dashboard.total.toLocaleString("vi-VN")} kết quả
              </p>
            </div>

            {dashboard.items.length === 0 ? (
              <div className="rounded-card bg-cream p-8 text-center">
                <h3 className="font-extrabold text-ink">
                  {hasFilters
                    ? "Không có kết quả phù hợp"
                    : dashboard.summary.books_with_issues === 0
                      ? "Chưa phát hiện vấn đề metadata"
                      : "Không có sách trong trang này"}
                </h3>
                <p className="mt-2 text-sm text-muted">
                  {hasFilters
                    ? "Thử thay đổi bộ lọc hoặc tìm kiếm."
                    : "Các chỉ số được tính từ metadata sách đã lưu; dashboard không tự sửa dữ liệu."}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] border-collapse text-left text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted">
                      <th className="px-3 py-3 font-extrabold" scope="col">
                        Sách
                      </th>
                      <th className="px-3 py-3 font-extrabold" scope="col">
                        Tác giả
                      </th>
                      <th className="px-3 py-3 font-extrabold" scope="col">
                        Khối lớp
                      </th>
                      <th className="px-3 py-3 font-extrabold" scope="col">
                        Trạng thái
                      </th>
                      <th className="px-3 py-3 font-extrabold" scope="col">
                        Vấn đề phát hiện
                      </th>
                      <th className="px-3 py-3 font-extrabold" scope="col">
                        Thao tác
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.items.map((book) => (
                      <tr
                        className="border-b border-border last:border-0"
                        key={book.id}
                      >
                        <td className="px-3 py-4 font-bold text-ink">
                          {book.title?.trim() ? book.title : "Chưa có tiêu đề"}
                        </td>
                        <td className="px-3 py-4 text-muted">
                          {book.author?.trim() ? book.author : "Chưa có"}
                        </td>
                        <td className="px-3 py-4 text-muted">
                          {book.min_grade == null || book.max_grade == null
                            ? "Chưa đủ dữ liệu"
                            : "Lớp " + book.min_grade + "–" + book.max_grade}
                        </td>
                        <td className="px-3 py-4">
                          <span className="inline-flex rounded-full bg-canvas px-3 py-1 font-bold text-muted">
                            {lifecycleLabels[book.lifecycle_status] ??
                              book.lifecycle_status}
                          </span>
                        </td>
                        <td className="px-3 py-4">
                          <div className="flex max-w-sm flex-wrap gap-2">
                            {book.issues.map((issue) => (
                              <span
                                className="inline-flex rounded-full bg-warning-surface px-3 py-1 font-bold text-warning"
                                key={issue}
                              >
                                {issueLabels[issue]}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-4">
                          <Link
                            className="inline-flex min-h-10 items-center rounded-control px-2 font-extrabold text-primary underline focus-visible:outline-3 focus-visible:outline-primary"
                            href={"/admin/books/" + encodeURIComponent(book.id)}
                          >
                            Xem chi tiết
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-muted">
                Hiển thị {firstItem}–{lastItem} trên{" "}
                {dashboard.total.toLocaleString("vi-VN")} kết quả
              </p>
              <div className="flex gap-2">
                <button
                  className="min-h-11 rounded-control border border-border px-4 font-bold text-ink hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={dashboard.offset === 0 || loading}
                  onClick={() =>
                    setOffset((current) => Math.max(0, current - limit))
                  }
                  type="button"
                >
                  Trước
                </button>
                <button
                  className="min-h-11 rounded-control border border-border px-4 font-bold text-ink hover:bg-canvas focus-visible:outline-3 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={
                    dashboard.offset + dashboard.limit >= dashboard.total ||
                    loading
                  }
                  onClick={() => setOffset((current) => current + limit)}
                  type="button"
                >
                  Tiếp
                </button>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted">
              Lần kiểm tra dữ liệu:{" "}
              {new Date(dashboard.summary.checked_at).toLocaleString("vi-VN")}.
              Đây là cảnh báo metadata; không có thao tác sửa hoặc xóa sách tự
              động.
            </p>
          </section>
        </>
      ) : null}
    </>
  );
}
