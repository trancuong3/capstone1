"use client";

import {
  ChevronLeft,
  ChevronRight,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminParentProfileItemDTO } from "@/types/admin";

const PAGE_SIZE = 10;
type LoadError = "auth" | "forbidden" | "unavailable";
type ParentForm = { display_name: string; email: string; phone: string };

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

function safeMutationError(error: unknown) {
  if (isServiceError(error) && error.status === 409) {
    return "Email hoặc số điện thoại bị trùng với tài khoản khác.";
  }
  if (isServiceError(error) && error.status === 422) {
    return "Thông tin chưa hợp lệ. Vui lòng kiểm tra lại các trường.";
  }
  if (isServiceError(error) && error.status === 503) {
    return "Backend thiếu khóa Supabase Auth Admin. Hãy cấu hình SUPABASE_SECRET_KEY hoặc SUPABASE_SERVICE_ROLE_KEY trong backend/.env rồi khởi động lại Backend.";
  }
  return "Không thể hoàn thành thao tác. Vui lòng thử lại.";
}

const emptyForm: ParentForm = { display_name: "", email: "", phone: "" };

export function AdminParentsScreen() {
  const { parents } = useAdminServices();
  const [items, setItems] = useState<readonly AdminParentProfileItemDTO[] | null>(null);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<LoadError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [formParentId, setFormParentId] = useState<string | null>(null);
  const [form, setForm] = useState<ParentForm>(emptyForm);
  const [originalForm, setOriginalForm] = useState<ParentForm>(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [formLoading, setFormLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AdminParentProfileItemDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setError(null);
    setItems(null);
    try {
      const query = {
        search: search || undefined,
        limit: PAGE_SIZE,
        offset,
      };
      const page = await parents.list(query);
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

  function openCreate() {
    setFormParentId(null);
    setForm(emptyForm);
    setOriginalForm(emptyForm);
    setFormError(null);
    setFormMode("create");
  }

  async function openEdit(parentId: string) {
    setFormLoading(true);
    setFormError(null);
    setActionError(null);
    try {
      const detail = await parents.getById(parentId);
      const value = {
        display_name: detail.display_name ?? "",
        email: detail.email ?? "",
        phone: detail.phone ?? "",
      };
      setForm(value);
      setOriginalForm(value);
      setFormParentId(parentId);
      setFormMode("edit");
    } catch (cause) {
      setActionError(safeMutationError(cause));
    } finally {
      setFormLoading(false);
    }
  }

  async function submitParentForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const displayName = form.display_name.trim();
    const email = form.email.trim().toLowerCase();
    const phone = form.phone.trim();
    if (!displayName) {
      setFormError("Vui lòng nhập tên hiển thị.");
      return;
    }
    if (formMode === "create" && (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      setFormError("Vui lòng nhập email hợp lệ.");
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFormError("Email chưa đúng định dạng.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (formMode === "create") {
        await parents.create({
          display_name: displayName,
          email,
          ...(phone ? { phone } : {}),
        });
        setNotice("Đã gửi lời mời tạo tài khoản Parent. Tài khoản cần hoàn tất quy trình xác minh theo cấu hình Supabase.");
      } else if (formMode === "edit" && formParentId) {
        const update: { display_name: string; email?: string; phone?: string } = {
          display_name: displayName,
        };
        if (email && email !== originalForm.email.trim().toLowerCase()) update.email = email;
        if (phone && phone !== originalForm.phone.trim()) update.phone = phone;
        await parents.update(formParentId, update);
        setNotice("Đã cập nhật hồ sơ Parent.");
      }
      setFormMode(null);
      await load();
    } catch (cause) {
      setFormError(safeMutationError(cause));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDeleteParent() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await parents.deactivate(pendingDelete.id);
      setNotice("Đã ẩn Parent khỏi danh sách. Tài khoản Supabase Auth và dữ liệu liên quan vẫn được giữ.");
      setPendingDelete(null);
      if (items?.length === 1 && offset > 0) {
        setOffset(Math.max(0, offset - PAGE_SIZE));
      } else {
        await load();
      }
    } catch (cause) {
      setDeleteError(safeMutationError(cause));
    } finally {
      setDeleting(false);
    }
  }

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <AdminPageHeader
        eyebrow="Quản lý tài khoản"
        title="Danh sách phụ huynh"
        description="Quản lý hồ sơ Parent và các hồ sơ bé liên kết."
        actions={
          <>
            <Button className="sm:w-auto" onClick={openCreate}>
              <Plus aria-hidden className="size-5" />
              Thêm Parent
            </Button>
            <Button className="sm:w-auto" onClick={() => void load()} variant="secondary">
              <RefreshCw aria-hidden className="size-5" />
              Tải lại
            </Button>
          </>
        }
      />

      {notice ? (
        <div className="mb-4 rounded-control border border-border bg-white p-4 text-sm font-bold" role="status">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4">
          <StatusMessage tone="error" title={actionError}>
            <button className="font-extrabold underline" onClick={() => void load()} type="button">
              Tải lại dữ liệu
            </button>
          </StatusMessage>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="bg-white">
          <p className="text-sm font-bold text-muted">
            Tổng Parent
          </p>
          <div className="flex items-center gap-3">
            <UsersRound aria-hidden className="size-8 text-primary" />
            <p className="text-3xl font-black">{total.toLocaleString("vi-VN")}</p>
          </div>
        </Card>
        <Card className="bg-white">
          <p className="text-sm font-bold text-muted">Phạm vi danh sách</p>
          <p className="text-lg font-black">
            {total === 0 ? "Chưa có dữ liệu" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} / ${total}`}
          </p>
          <p className="text-sm text-muted">Sắp xếp theo ngày tạo mới nhất</p>
        </Card>
      </div>

      <Card className="mb-6 bg-white">
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submitSearch}>
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
            <Button className="sm:w-auto" onClick={() => { setSearchInput(""); setSearch(""); setOffset(0); }} type="button" variant="secondary">
              Xóa lọc
            </Button>
          ) : null}
        </form>
      </Card>

      {formLoading ? <AdminLoading label="Đang tải dữ liệu Parent để chỉnh sửa…" /> : null}

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
            <Link className="font-extrabold underline" href="/admin/login">Đăng nhập lại</Link>
          ) : error === "forbidden" ? (
            "Chỉ tài khoản có role admin mới được phép xem dữ liệu này."
          ) : (
            <button className="font-extrabold underline" onClick={() => void load()} type="button">Thử lại</button>
          )}
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          title={search ? "Không tìm thấy phụ huynh" : "Chưa có hồ sơ phụ huynh"}
          description={
            search
              ? "Thử tên khác hoặc xóa bộ lọc tìm kiếm."
              : "Các tài khoản có role parent sẽ xuất hiện ở đây khi đã có hồ sơ trong database."
          }
          action={search ? (
            <Button className="sm:w-auto" onClick={() => { setSearchInput(""); setSearch(""); setOffset(0); }} variant="secondary">
              Xóa bộ lọc
            </Button>
          ) : undefined}
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
                    <p className="mt-1 break-all text-xs text-muted">ID: {parent.id}</p>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 sm:min-w-64">
                    <div className="rounded-control bg-canvas px-4 py-3">
                      <dt className="text-xs font-bold text-muted">Ngày tạo</dt>
                      <dd className="mt-1 font-bold">{formatDate(parent.created_at)}</dd>
                    </div>
                    <div className="rounded-control bg-canvas px-4 py-3">
                      <dt className="text-xs font-bold text-muted">Hồ sơ bé</dt>
                      <dd className="mt-1 font-bold">{parent.children_count}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-2 sm:w-auto">
                    <ButtonLink className="sm:w-auto" href={`/admin/parents/${encodeURIComponent(parent.id)}`} variant="secondary">
                      Xem chi tiết
                      <ChevronRight aria-hidden className="size-5" />
                    </ButtonLink>
                    <Button className="sm:w-auto" onClick={() => void openEdit(parent.id)} variant="secondary">
                      <Pencil aria-hidden className="size-5" /> Sửa
                    </Button>
                    <Button
                      className="sm:w-auto"
                      onClick={() => { setPendingDelete(parent); setDeleteError(null); }}
                      variant="secondary"
                    >
                      <Trash2 aria-hidden className="size-5" /> Xóa
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
          <div className="mt-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <p className="text-sm text-muted">Trang {currentPage} / {totalPages}</p>
            <div className="flex gap-3">
              <Button className="sm:w-auto" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} type="button" variant="secondary">
                <ChevronLeft aria-hidden className="size-5" /> Trang trước
              </Button>
              <Button className="sm:w-auto" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)} type="button" variant="secondary">
                Trang sau <ChevronRight aria-hidden className="size-5" />
              </Button>
            </div>
          </div>
        </>
      )}

      <Modal
        isOpen={formMode !== null}
        onClose={() => { if (!saving) { setFormMode(null); setFormError(null); } }}
        title={formMode === "create" ? "Thêm Parent" : "Sửa hồ sơ Parent"}
      >
        <form className="grid gap-4" noValidate onSubmit={submitParentForm}>
          {formError ? <StatusMessage tone="error" title={formError}>Kiểm tra thông tin và thử lại.</StatusMessage> : null}
          <TextField label="Tên hiển thị" autoComplete="name" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} required disabled={saving} />
          <TextField label="Email" type="email" autoComplete="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required={formMode === "create"} disabled={saving} />
          <TextField label="Số điện thoại" type="tel" autoComplete="tel" value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} disabled={saving} />
          <p className="text-sm text-muted">
            Tài khoản được tạo qua lời mời Supabase Auth. Đổi email/số điện thoại được xử lý bởi backend; không thay đổi role Parent.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button className="sm:w-auto" disabled={saving} onClick={() => setFormMode(null)} type="button" variant="secondary">Hủy</Button>
            <Button className="sm:w-auto" isLoading={saving} type="submit">{formMode === "create" ? "Tạo Parent" : "Lưu thay đổi"}</Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={pendingDelete !== null}
        onClose={() => { if (!deleting) { setPendingDelete(null); setDeleteError(null); } }}
        title="Xóa Parent"
      >
        {pendingDelete ? (
          <div className="grid gap-4">
            <p>
              Bạn có chắc muốn ẩn Parent{" "}
              <strong>{pendingDelete.display_name?.trim() || pendingDelete.id}</strong>{" "}
              khỏi danh sách quản trị?
            </p>
            <p className="text-sm text-muted">
              Đây là xóa mềm: trạng thái active sẽ chuyển thành 0. Hồ sơ, tài khoản Supabase Auth,
              hồ sơ bé và lịch sử học tập sẽ được giữ nguyên.
            </p>
            {deleteError ? <StatusMessage tone="error" title={deleteError}>Hãy kiểm tra cấu hình và thử lại.</StatusMessage> : null}
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
              <Button className="sm:w-auto" disabled={deleting} onClick={() => { setPendingDelete(null); setDeleteError(null); }} type="button" variant="secondary">
                Hủy
              </Button>
              <Button className="sm:w-auto" isLoading={deleting} onClick={() => void confirmDeleteParent()} type="button">
                Xóa Parent
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
