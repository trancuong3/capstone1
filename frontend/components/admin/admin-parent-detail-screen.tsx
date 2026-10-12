"use client";

import {
  ArrowLeft,
  CalendarDays,
  GraduationCap,
  Mail,
  Pencil,
  Phone,
  RefreshCw,
  UserRound,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { Modal } from "@/components/common/modal";
import { TextField } from "@/components/common/text-field";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminParentDetailDTO } from "@/types/admin";

type LoadError = "auth" | "forbidden" | "not-found" | "unavailable";

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

function getLoadError(error: unknown): LoadError {
  if (!isServiceError(error)) return "unavailable";
  if (error.code === "AUTH_REQUIRED") return "auth";
  if (error.code === "FORBIDDEN") return "forbidden";
  if (
    error.code === "RESOURCE_NOT_FOUND" ||
    error.code === "VALIDATION_ERROR"
  ) {
    return "not-found";
  }
  return "unavailable";
}

function contactMessage(status: AdminParentDetailDTO["contact_info_status"]) {
  switch (status) {
    case "not_configured":
      return "Chưa thể tải email và số điện thoại vì backend chưa được cấu hình quyền truy xuất Supabase Auth.";
    case "user_not_found":
      return "Không tìm thấy tài khoản Supabase Auth liên kết với hồ sơ này. Thông tin hồ sơ và trẻ em vẫn được hiển thị.";
    case "lookup_failed":
      return "Không thể tải thông tin liên hệ từ Supabase Auth lúc này. Hãy kiểm tra cấu hình hoặc thử tải lại.";
    case "available":
      return null;
  }
}

export function AdminParentDetailScreen({
  parentId,
  includeHidden = false,
}: {
  parentId: string;
  includeHidden?: boolean;
}) {
  const { parents } = useAdminServices();
  const [parent, setParent] = useState<AdminParentDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({ display_name: "", email: "", phone: "" });
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      setParent(null);

      try {
        const detail = includeHidden
          ? await parents.getById(parentId, signal, true)
          : await parents.getById(parentId, signal);
        if (signal?.aborted || requestId !== requestIdRef.current) return;
        setParent(detail);
      } catch (cause) {
        if (signal?.aborted || requestId !== requestIdRef.current) return;
        setError(getLoadError(cause));
      } finally {
        if (!signal?.aborted && requestId === requestIdRef.current) {
          setLoading(false);
        }
      }
    },
    [includeHidden, parentId, parents],
  );

  useEffect(() => {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => {
      void load(controller.signal);
    }, 0);

    return () => {
      globalThis.clearTimeout(timeout);
      controller.abort();
      requestIdRef.current += 1;
    };
  }, [load]);

  const contactNotice = parent
    ? contactMessage(parent.contact_info_status)
    : null;
  const isHidden = Boolean(parent?.admin_hidden_at);

  function openEdit() {
    if (!parent) return;
    setEditForm({
      display_name: parent.display_name ?? "",
      email: parent.email ?? "",
      phone: parent.phone ?? "",
    });
    setEditError(null);
    setActionError(null);
    setEditOpen(true);
  }

  async function submitEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!parent || saving) return;
    const displayName = editForm.display_name.trim();
    const email = editForm.email.trim().toLowerCase();
    const phone = editForm.phone.trim();
    if (!displayName) {
      setEditError("Vui lòng nhập tên hiển thị.");
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEditError("Email chưa đúng định dạng.");
      return;
    }
    const update: { display_name: string; email?: string; phone?: string } = {
      display_name: displayName,
    };
    if (email && email !== (parent.email ?? "").trim().toLowerCase()) update.email = email;
    if (phone && phone !== (parent.phone ?? "").trim()) update.phone = phone;

    setSaving(true);
    setEditError(null);
    try {
      const updated = await parents.update(parent.id, update);
      setParent(updated);
      setEditOpen(false);
      setActionNotice("Đã cập nhật hồ sơ Parent.");
    } catch (cause) {
      setEditError(
        isServiceError(cause) && cause.status === 409
          ? "Email hoặc số điện thoại bị trùng với tài khoản khác."
          : isServiceError(cause) && cause.status === 422
            ? "Thông tin chưa hợp lệ. Vui lòng kiểm tra lại."
            : "Không thể cập nhật hồ sơ lúc này. Vui lòng thử lại.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function restoreHiddenParent() {
    if (!parent || visibilityBusy) return;
    setVisibilityBusy(true);
    setActionError(null);
    try {
      await parents.restore(parent.id);
      setParent({ ...parent, admin_hidden_at: null });
      setActionNotice("Đã khôi phục hiển thị Parent.");
    } catch {
      setActionError("Không thể khôi phục hồ sơ lúc này. Vui lòng thử lại.");
    } finally {
      setVisibilityBusy(false);
    }
  }
  const fallbackContact =
    parent?.contact_info_status === "available"
      ? "Chưa cung cấp"
      : "Chưa khả dụng";

  return (
    <>
      <AdminPageHeader
        eyebrow="Quản lý tài khoản"
        title={parent?.display_name?.trim() || "Chi tiết phụ huynh"}
        description="Thông tin tài khoản phụ huynh và các hồ sơ trẻ em được liên kết."
        actions={
          <>
            {parent && !isHidden ? (
              <Button className="sm:w-auto" onClick={openEdit} variant="secondary">
                <Pencil aria-hidden className="size-5" />
                Sửa Parent
              </Button>
            ) : null}
            {parent && isHidden ? (
              <Button className="sm:w-auto" disabled={visibilityBusy} isLoading={visibilityBusy} onClick={() => void restoreHiddenParent()}>
                Khôi phục hiển thị
              </Button>
            ) : null}
            <ButtonLink
              className="sm:w-auto"
              href="/admin/parents"
              variant="secondary"
            >
              <ArrowLeft aria-hidden className="size-5" />
              Quay lại danh sách
            </ButtonLink>
          </>
        }
      />

      {actionNotice ? (
        <div className="mb-4 rounded-control border border-border bg-white p-4 text-sm font-bold" role="status">{actionNotice}</div>
      ) : null}
      {actionError ? (
        <div className="mb-4"><StatusMessage tone="error" title={actionError}>Vui lòng thử lại.</StatusMessage></div>
      ) : null}
      {parent && isHidden ? (
        <div className="mb-4 rounded-control border border-border bg-canvas p-4 text-sm font-bold" role="status">
          Hồ sơ này đang bị ẩn khỏi danh sách Admin. Tài khoản và dữ liệu liên quan vẫn được giữ nguyên.
        </div>
      ) : null}

      {loading ? (
        <AdminLoading label="Đang tải thông tin phụ huynh…" />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? "Phiên đăng nhập không hợp lệ"
              : error === "forbidden"
                ? "Bạn không có quyền xem thông tin phụ huynh"
                : error === "not-found"
                  ? "Không tìm thấy phụ huynh"
                  : "Không thể tải thông tin phụ huynh"
          }
        >
          <div className="flex flex-col items-start gap-3">
            <p>
              {error === "auth"
                ? "Vui lòng đăng nhập lại bằng tài khoản quản trị."
                : error === "forbidden"
                  ? "Chỉ tài khoản có role admin mới được phép xem thông tin này."
                  : error === "not-found"
                    ? "Hồ sơ không tồn tại hoặc ID không hợp lệ."
                    : "Có lỗi khi kết nối đến hệ thống. Vui lòng thử lại."}
            </p>
            {error === "auth" ? (
              <ButtonLink href="/admin/login" className="sm:w-auto">
                Đăng nhập lại
              </ButtonLink>
            ) : error === "not-found" || error === "forbidden" ? null : (
              <Button
                className="sm:w-auto"
                onClick={() => void load()}
                variant="secondary"
              >
                <RefreshCw aria-hidden className="size-5" />
                Thử lại
              </Button>
            )}
          </div>
        </StatusMessage>
      ) : parent ? (
        <div className="grid gap-6">
          <Card className="bg-white">
            <div className="flex items-center gap-3">
              <div className="grid size-12 shrink-0 place-items-center rounded-full bg-sky text-primary">
                <UserRound aria-hidden className="size-6" />
              </div>
              <div className="min-w-0">
                <h2 className="text-xl font-black text-ink">
                  Thông tin phụ huynh
                </h2>
              </div>
            </div>

            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0 rounded-control bg-canvas px-4 py-3">
                <dt className="mb-1 flex items-center gap-2 text-sm font-bold text-muted">
                  <Mail aria-hidden className="size-4" />
                  Email
                </dt>
                <dd className="break-words font-bold">
                  {parent.email?.trim() || fallbackContact}
                </dd>
              </div>
              <div className="min-w-0 rounded-control bg-canvas px-4 py-3">
                <dt className="mb-1 flex items-center gap-2 text-sm font-bold text-muted">
                  <Phone aria-hidden className="size-4" />
                  Số điện thoại
                </dt>
                <dd className="break-words font-bold">
                  {parent.phone?.trim() || fallbackContact}
                </dd>
              </div>
              <div className="min-w-0 rounded-control bg-canvas px-4 py-3">
                <dt className="mb-1 flex items-center gap-2 text-sm font-bold text-muted">
                  <CalendarDays aria-hidden className="size-4" />
                  Ngày tạo hồ sơ
                </dt>
                <dd className="font-bold">{formatDate(parent.created_at)}</dd>
              </div>
              <div className="min-w-0 rounded-control bg-canvas px-4 py-3">
                <dt className="mb-1 text-sm font-bold text-muted">
                  Mã phụ huynh
                </dt>
                <dd className="break-all font-bold">{parent.id}</dd>
              </div>
            </dl>

            {contactNotice ? (
              <div
                className="rounded-control border border-border bg-canvas p-4 text-sm text-muted"
                role="status"
              >
                {contactNotice}
              </div>
            ) : null}
          </Card>

          <section aria-labelledby="children-heading" className="grid gap-4">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2
                  id="children-heading"
                  className="text-xl font-black text-ink"
                >
                  Danh sách trẻ em
                </h2>
                <p className="mt-1 text-sm text-muted">
                  {parent.children.length} hồ sơ trẻ em được liên kết với phụ
                  huynh này.
                </p>
              </div>
            </div>

            {parent.children.length === 0 ? (
              <EmptyState
                title="Phụ huynh chưa có hồ sơ trẻ em"
                description="Các hồ sơ trẻ em liên kết với phụ huynh sẽ xuất hiện tại đây."
              />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {parent.children.map((child) => (
                  <Card className="bg-white" key={child.id}>
                    <div className="flex items-center gap-3">
                      <div className="grid size-11 shrink-0 place-items-center rounded-full bg-sky text-primary">
                        <UsersRound aria-hidden className="size-5" />
                      </div>
                      <div className="min-w-0">
                        <h3 className="break-words text-lg font-black text-ink">
                          {child.alias}
                        </h3>
                        <p className="text-sm text-muted">
                          ID: <span className="break-all">{child.id}</span>
                        </p>
                      </div>
                    </div>
                    <dl className="grid grid-cols-2 gap-3">
                      <div className="rounded-control bg-canvas px-3 py-2">
                        <dt className="flex items-center gap-1 text-xs font-bold text-muted">
                          <GraduationCap aria-hidden className="size-4" />
                          Khối lớp
                        </dt>
                        <dd className="mt-1 font-bold">{child.grade}</dd>
                      </div>
                      <div className="rounded-control bg-canvas px-3 py-2">
                        <dt className="text-xs font-bold text-muted">
                          Ngày tạo
                        </dt>
                        <dd className="mt-1 font-bold">
                          {formatDate(child.created_at)}
                        </dd>
                      </div>
                    </dl>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}

      <Modal
        isOpen={editOpen}
        onClose={() => { if (!saving) { setEditOpen(false); setEditError(null); } }}
        title="Sửa hồ sơ Parent"
      >
        <form className="grid gap-4" noValidate onSubmit={submitEdit}>
          {editError ? <StatusMessage tone="error" title={editError}>Kiểm tra thông tin và thử lại.</StatusMessage> : null}
          <TextField label="Tên hiển thị" autoComplete="name" value={editForm.display_name} onChange={(event) => setEditForm({ ...editForm, display_name: event.target.value })} required disabled={saving} />
          <TextField label="Email" type="email" autoComplete="email" value={editForm.email} onChange={(event) => setEditForm({ ...editForm, email: event.target.value })} disabled={saving} />
          <TextField label="Số điện thoại" type="tel" autoComplete="tel" value={editForm.phone} onChange={(event) => setEditForm({ ...editForm, phone: event.target.value })} disabled={saving} />
          <p className="text-sm text-muted">
            Các trường liên hệ được cập nhật qua backend và Supabase Auth. Để giữ nguyên email hoặc số điện thoại, hãy để nguyên giá trị hiện tại.
          </p>
          <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
            <Button className="sm:w-auto" disabled={saving} onClick={() => setEditOpen(false)} type="button" variant="secondary">Hủy</Button>
            <Button className="sm:w-auto" isLoading={saving} type="submit">Lưu thay đổi</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
