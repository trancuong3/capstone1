"use client";

import {
  Check,
  ChevronRight,
  Copy,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  UserX,
  UsersRound,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";

import {
  AdminBadge,
  AdminKpiCard,
  AdminKpiGrid,
  AdminLoading,
  AdminPageHeader,
  AdminSearchInput,
  AdminToolbar,
} from "@/components/admin/admin-ui";
import {
  AdminParentFormModal,
  type AdminParentFormValues,
  type AdminParentFormSubmission,
  getAdminParentMutationErrorMessage,
} from "@/components/admin/admin-parent-form-modal";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { AdminParentProfileItemDTO } from "@/types/admin";

const PAGE_SIZE = 10;
type LoadError = "auth" | "forbidden" | "unavailable";
type ParentForm = AdminParentFormValues;

const emptyForm: ParentForm = { display_name: "", email: "", phone: "" };

export function AdminParentsScreen() {
  const { parents } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDate, formatNumber } = useI18n();
  const [items, setItems] = useState<
    readonly AdminParentProfileItemDTO[] | null
  >(null);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<LoadError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [formParentId, setFormParentId] = useState<string | null>(null);
  const [form, setForm] = useState<ParentForm>(emptyForm);
  const [formLoading, setFormLoading] = useState(false);
  const [formContactInfoEditable, setFormContactInfoEditable] = useState(false);
  const editRequestIdRef = useRef(0);
  const editLoadingRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] =
    useState<AdminParentProfileItemDTO | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        globalThis.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

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

  function clearSearch() {
    setSearchInput("");
    setSearch("");
    setOffset(0);
  }

  async function copyParentId(id: string) {
    try {
      await navigator.clipboard?.writeText(id);
      setCopiedId(id);
      if (copyTimerRef.current !== null) {
        globalThis.clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = globalThis.setTimeout(() => {
        setCopiedId((current) => (current === id ? null : current));
      }, 2000);
    } catch {
      // Clipboard API may be unavailable in restricted contexts.
    }
  }

  function closeParentForm() {
    editRequestIdRef.current += 1;
    editLoadingRef.current = false;
    setFormMode(null);
    setFormLoading(false);
    setFormParentId(null);
    setForm(emptyForm);
    setFormContactInfoEditable(false);
  }

  function openCreate() {
    closeParentForm();
    setFormContactInfoEditable(true);
    setFormMode("create");
  }

  async function openEdit(parentId: string) {
    if (editLoadingRef.current || formMode !== null) return;
    const requestId = ++editRequestIdRef.current;
    editLoadingRef.current = true;
    setActionError(null);
    setFormParentId(parentId);
    setForm(emptyForm);
    setFormContactInfoEditable(false);
    setFormLoading(true);
    setFormMode("edit");

    try {
      const detail = await parents.getById(parentId);
      if (requestId !== editRequestIdRef.current) return;
      const value = {
        display_name: detail.display_name ?? "",
        email: detail.email ?? "",
        phone: detail.phone ?? "",
      };
      setForm(value);
      setFormContactInfoEditable(detail.contact_info_status === "available");
    } catch (cause) {
      if (requestId !== editRequestIdRef.current) return;
      setActionError(getAdminParentMutationErrorMessage(cause, t));
      setFormMode(null);
      setFormParentId(null);
    } finally {
      if (requestId === editRequestIdRef.current) {
        editLoadingRef.current = false;
        setFormLoading(false);
      }
    }
  }

  async function submitParentForm(
    submission: AdminParentFormSubmission,
  ): Promise<void> {
    if (submission.mode === "create") {
      await parents.create(submission.input);
      setNotice(t("parents.notices.created"));
      return;
    }

    if (!formParentId) throw new Error("Parent id is unavailable.");
    await parents.update(formParentId, submission.input);
    setNotice(t("parents.notices.updated"));
  }

  function handleParentFormSuccess() {
    closeParentForm();
    void load();
  }

  async function confirmDeleteParent() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await parents.deactivate(pendingDelete.id);
      setNotice(t("parents.notices.deleted"));
      setPendingDelete(null);
      if (items?.length === 1 && offset > 0) {
        setOffset(Math.max(0, offset - PAGE_SIZE));
      } else {
        await load();
      }
    } catch (cause) {
      setDeleteError(getAdminParentMutationErrorMessage(cause, t));
    } finally {
      setDeleting(false);
    }
  }

  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <>
      <AdminPageHeader
        eyebrow={t("parents.eyebrow")}
        title={t("parents.listTitle")}
        description={t("parents.description")}
        actions={
          <>
            <Button fullWidth={false} onClick={openCreate} size="admin">
              <Plus aria-hidden className="size-4" />
              {t("parents.addParent")}
            </Button>
            <Button
              fullWidth={false}
              onClick={() => void load()}
              size="admin"
              variant="outline"
            >
              <RefreshCw aria-hidden className="size-4" />
              {t("parents.reload")}
            </Button>
          </>
        }
      />

      {notice ? (
        <div
          className="mb-4 rounded-xl border border-primary/25 bg-sky/40 px-4 py-3 text-sm font-semibold text-primary-hover"
          role="status"
        >
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4">
          <StatusMessage tone="error" title={actionError}>
            <Button
              fullWidth={false}
              onClick={() => void load()}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("parents.reloadData")}
            </Button>
          </StatusMessage>
        </div>
      ) : null}

      <AdminKpiGrid
        ariaLabel={t("parents.overviewAria", undefined, "Tổng quan phụ huynh")}
        className="mb-5"
        columns={2}
      >
        <AdminKpiCard
          icon={<UsersRound aria-hidden className="size-4 text-primary" />}
          label={t("parents.totalParents")}
          tone="info"
          value={formatNumber(total)}
        />
        <AdminKpiCard
          detail={t("parents.sortedNewest")}
          label={t("parents.listRange")}
          value={
            total === 0
              ? t("parents.noDataRange")
              : t("parents.rangeDisplay", {
                  start: formatNumber(offset + 1),
                  end: formatNumber(Math.min(offset + PAGE_SIZE, total)),
                  total: formatNumber(total),
                })
          }
        />
      </AdminKpiGrid>

      <form className="mb-5" onSubmit={submitSearch}>
        <AdminToolbar
          actions={
            <>
              <Button fullWidth={false} size="admin" type="submit">
                <Search aria-hidden className="size-4" />
                {t("parents.searchButton")}
              </Button>
              {search ? (
                <Button
                  fullWidth={false}
                  onClick={clearSearch}
                  size="admin"
                  type="button"
                  variant="outline"
                >
                  {t("parents.clearFilter")}
                </Button>
              ) : null}
            </>
          }
          ariaLabel={t(
            "parents.searchToolbarAria",
            undefined,
            "Tìm kiếm phụ huynh",
          )}
        >
          <AdminSearchInput
            label={t("parents.searchLabel")}
            onChange={setSearchInput}
            onClear={clearSearch}
            placeholder={t("parents.searchPlaceholder")}
            value={searchInput}
          />
        </AdminToolbar>
      </form>

      {items === null ? (
        <AdminLoading label={t("parents.loadingList")} />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? t("parents.authErrorTitle")
              : error === "forbidden"
                ? t("parents.forbiddenErrorTitle")
                : t("parents.loadErrorTitle")
          }
        >
          {error === "auth" ? (
            <Link className="font-semibold underline" href="/admin/login">
              {t("common.signInAgain")}
            </Link>
          ) : error === "forbidden" ? (
            t("parents.forbiddenDesc")
          ) : (
            <Button
              fullWidth={false}
              onClick={() => void load()}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("common.retry")}
            </Button>
          )}
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<UsersRound aria-hidden className="size-8 text-primary" />}
          title={
            search ? t("parents.emptySearchTitle") : t("parents.emptyListTitle")
          }
          description={
            search ? t("parents.emptySearchDesc") : t("parents.emptyListDesc")
          }
          action={
            search ? (
              <Button
                fullWidth={false}
                onClick={clearSearch}
                size="admin"
                variant="outline"
              >
                {t("parents.clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <section
            aria-label={t(
              "parents.directoryAria",
              undefined,
              "Danh sách tài khoản phụ huynh",
            )}
            className="overflow-hidden rounded-xl border border-border bg-white shadow-2xs"
          >
            <div
              aria-hidden="true"
              className="hidden border-b border-border bg-surface-subtle/75 px-4 py-2.5 text-xs font-bold uppercase tracking-wide text-muted md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_auto] md:items-center md:gap-4"
            >
              <span>
                {t("parents.tableHeaders.parent", undefined, "Phụ huynh")}
              </span>
              <span>{t("parents.childProfiles")}</span>
              <span>{t("parents.createdAt")}</span>
              <span className="text-end">
                {t("parents.tableHeaders.actions", undefined, "Thao tác")}
              </span>
            </div>

            <ul className="divide-y divide-border">
              {items.map((parent) => (
                <li
                  className="flex flex-col gap-3 p-4 transition-colors hover:bg-surface-subtle/40 md:grid md:grid-cols-[minmax(0,2.2fr)_minmax(0,0.8fr)_minmax(0,0.9fr)_auto] md:items-center md:gap-4 md:px-4 md:py-3"
                  key={parent.id}
                >
                  <div className="min-w-0">
                    <h2 className="truncate text-base font-bold text-ink">
                      {parent.display_name?.trim() || t("parents.nameFallback")}
                    </h2>
                    <div className="mt-0.5 flex items-center gap-1.5">
                      <p
                        className="max-w-44 truncate font-mono text-xs text-muted sm:max-w-56"
                        title={parent.id}
                      >
                        ID: {parent.id}
                      </p>
                      <button
                        aria-label={t(
                          "parents.copyIdAria",
                          { id: parent.id },
                          "Sao chép ID {id}",
                        )}
                        className="inline-flex size-6 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-primary"
                        onClick={() => void copyParentId(parent.id)}
                        title={
                          copiedId === parent.id
                            ? t("parents.copiedId", undefined, "Đã sao chép")
                            : t("parents.copyId", undefined, "Sao chép ID")
                        }
                        type="button"
                      >
                        {copiedId === parent.id ? (
                          <Check
                            aria-hidden
                            className="size-3.5 text-success-ink"
                          />
                        ) : (
                          <Copy aria-hidden className="size-3.5" />
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2 md:contents">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted md:hidden">
                        {t("parents.childProfiles")}:
                      </span>
                      <AdminBadge
                        tone={parent.children_count > 0 ? "info" : "neutral"}
                      >
                        {formatNumber(parent.children_count)}
                      </AdminBadge>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-muted md:hidden">
                        {t("parents.createdAt")}:
                      </span>
                      <span className="text-sm font-medium text-ink tabular-nums">
                        {formatDate(parent.created_at, {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          fallback: t("common.unknown"),
                        })}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 md:justify-end">
                    <ButtonLink
                      fullWidth={false}
                      href={`/admin/parents/${encodeURIComponent(parent.id)}`}
                      size="admin"
                      variant="secondary"
                    >
                      {t("parents.viewDetail")}
                      <ChevronRight
                        aria-hidden
                        className="size-4 viread-rtl-flip"
                      />
                    </ButtonLink>
                    <Button
                      disabled={formLoading || formMode !== null}
                      fullWidth={false}
                      onClick={() => void openEdit(parent.id)}
                      size="admin"
                      variant="outline"
                    >
                      <Pencil aria-hidden className="size-4" />
                      {t("parents.edit")}
                    </Button>
                    <Button
                      fullWidth={false}
                      onClick={() => {
                        setPendingDelete(parent);
                        setDeleteError(null);
                      }}
                      size="admin"
                      variant="destructive-outline"
                    >
                      <UserX aria-hidden className="size-4" />
                      {t("parents.deactivate")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <PaginationBar
            ariaLabel={t("parents.paginationAria")}
            className="mt-5"
            compact
            itemLabel={t("parents.itemLabel")}
            nextLabel={t("parents.nextLabel")}
            onPageChange={(nextPage) => setOffset((nextPage - 1) * PAGE_SIZE)}
            page={currentPage}
            pageSize={PAGE_SIZE}
            prevLabel={t("parents.prevLabel")}
            showSummaryWhenSinglePage
            total={total}
          />
        </>
      )}

      {formMode ? (
        <AdminParentFormModal
          isOpen
          key={
            formMode === "edit" && !formLoading
              ? (formParentId ?? "edit")
              : formMode
          }
          mode={formMode}
          isLoading={formLoading}
          initialValues={form}
          contactInfoEditable={formContactInfoEditable}
          onClose={closeParentForm}
          onSubmit={submitParentForm}
          onSuccess={handleParentFormSuccess}
        />
      ) : null}

      <Modal
        closeOnBackdropClick={!deleting}
        closeOnEscape={!deleting}
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              disabled={deleting}
              fullWidth={false}
              onClick={() => {
                setPendingDelete(null);
                setDeleteError(null);
              }}
              size="admin"
              type="button"
              variant="outline"
            >
              {t("common.cancel")}
            </Button>
            <Button
              fullWidth={false}
              isLoading={deleting}
              onClick={() => void confirmDeleteParent()}
              size="admin"
              type="button"
              variant="destructive"
            >
              {t("parents.deactivateTitle")}
            </Button>
          </div>
        }
        isOpen={pendingDelete !== null}
        onClose={() => {
          if (!deleting) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        role="alertdialog"
        showCloseButton={!deleting}
        title={t("parents.deactivateTitle")}
        tone="paper"
      >
        {pendingDelete ? (
          <div className="grid gap-3">
            <p className="text-sm leading-relaxed text-ink">
              {t("parents.deactivateConfirm", {
                name: pendingDelete.display_name?.trim() || pendingDelete.id,
              })}
            </p>
            <p className="text-sm text-muted">
              {t("parents.deactivateSoftDeleteNote")}
            </p>
            {deleteError ? (
              <StatusMessage tone="error" title={deleteError}>
                {t("parents.deactivateErrorFallback")}
              </StatusMessage>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
