"use client";

import {
  ChevronRight,
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

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import {
  AdminParentFormModal,
  type AdminParentFormValues,
  type AdminParentFormSubmission,
  getAdminParentMutationErrorMessage,
} from "@/components/admin/admin-parent-form-modal";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { TextField } from "@/components/common/text-field";
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
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [formParentId, setFormParentId] = useState<string | null>(null);
  const [form, setForm] = useState<ParentForm>(emptyForm);
  const [formLoading, setFormLoading] = useState(false);
  const [formContactInfoEditable, setFormContactInfoEditable] = useState(false);
  const editRequestIdRef = useRef(0);
  const editLoadingRef = useRef(false);
  const [pendingDelete, setPendingDelete] =
    useState<AdminParentProfileItemDTO | null>(null);
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
            <Button className="sm:w-auto" onClick={openCreate}>
              <Plus aria-hidden className="size-5" />
              {t("parents.addParent")}
            </Button>
            <Button
              className="sm:w-auto"
              onClick={() => void load()}
              variant="secondary"
            >
              <RefreshCw aria-hidden className="size-5" />
              {t("parents.reload")}
            </Button>
          </>
        }
      />

      {notice ? (
        <div
          className="mb-4 rounded-control border border-border bg-white p-4 text-sm font-semibold"
          role="status"
        >
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4">
          <StatusMessage tone="error" title={actionError}>
            <Button
              className="sm:w-auto"
              onClick={() => void load()}
              type="button"
              variant="secondary"
            >
              {t("parents.reloadData")}
            </Button>
          </StatusMessage>
        </div>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className="bg-white">
          <p className="text-sm font-semibold text-muted">
            {t("parents.totalParents")}
          </p>
          <div className="flex items-center gap-3">
            <UsersRound aria-hidden className="size-8 text-primary" />
            <p className="text-3xl font-semibold">{formatNumber(total)}</p>
          </div>
        </Card>
        <Card className="bg-white">
          <p className="text-sm font-semibold text-muted">
            {t("parents.listRange")}
          </p>
          <p className="text-lg font-semibold">
            {total === 0
              ? t("parents.noDataRange")
              : t("parents.rangeDisplay", {
                  start: formatNumber(offset + 1),
                  end: formatNumber(Math.min(offset + PAGE_SIZE, total)),
                  total: formatNumber(total),
                })}
          </p>
          <p className="text-sm text-muted">{t("parents.sortedNewest")}</p>
        </Card>
      </div>

      <Card className="mb-6 bg-white">
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={submitSearch}
        >
          <div className="min-w-0 flex-1">
            <TextField
              label={t("parents.searchLabel")}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t("parents.searchPlaceholder")}
              value={searchInput}
            />
          </div>
          <Button className="sm:w-auto" type="submit">
            <Search aria-hidden className="size-5" />
            {t("parents.searchButton")}
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
              {t("parents.clearFilter")}
            </Button>
          ) : null}
        </form>
      </Card>

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
              className="sm:w-auto"
              onClick={() => void load()}
              type="button"
              variant="secondary"
            >
              {t("common.retry")}
            </Button>
          )}
        </StatusMessage>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<UsersRound aria-hidden className="size-10 text-primary" />}
          title={
            search ? t("parents.emptySearchTitle") : t("parents.emptyListTitle")
          }
          description={
            search ? t("parents.emptySearchDesc") : t("parents.emptyListDesc")
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
                {t("parents.clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            {items.map((parent) => (
              <Card className="bg-white" key={parent.id}>
                <div className="flex min-w-0 flex-col gap-4">
                  <div className="min-w-0 flex-1">
                    <h2 className="break-words text-xl font-semibold text-ink">
                      {parent.display_name?.trim() || t("parents.nameFallback")}
                    </h2>
                    <p className="mt-1 break-all text-xs text-muted">
                      ID: {parent.id}
                    </p>
                  </div>
                  <dl className="grid grid-cols-2 gap-3">
                    <div className="rounded-control bg-canvas px-4 py-3">
                      <dt className="text-xs font-semibold text-muted">
                        {t("parents.createdAt")}
                      </dt>
                      <dd className="mt-1 font-semibold">
                        {formatDate(parent.created_at, {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          fallback: t("common.unknown"),
                        })}
                      </dd>
                    </div>
                    <div className="rounded-control bg-canvas px-4 py-3">
                      <dt className="text-xs font-semibold text-muted">
                        {t("parents.childProfiles")}
                      </dt>
                      <dd className="mt-1 font-semibold">
                        {formatNumber(parent.children_count)}
                      </dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap gap-2">
                    <ButtonLink
                      fullWidth={false}
                      href={`/admin/parents/${encodeURIComponent(parent.id)}`}
                      variant="secondary"
                    >
                      {t("parents.viewDetail")}
                      <ChevronRight
                        aria-hidden
                        className="size-5 rtl:rotate-180"
                      />
                    </ButtonLink>
                    <Button
                      disabled={formLoading || formMode !== null}
                      fullWidth={false}
                      onClick={() => void openEdit(parent.id)}
                      variant="secondary"
                    >
                      <Pencil aria-hidden className="size-5" />{" "}
                      {t("parents.edit")}
                    </Button>
                    <Button
                      fullWidth={false}
                      onClick={() => {
                        setPendingDelete(parent);
                        setDeleteError(null);
                      }}
                      variant="secondary"
                    >
                      <UserX aria-hidden className="size-5" />{" "}
                      {t("parents.deactivate")}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
          <PaginationBar
            ariaLabel={t("parents.paginationAria")}
            className="mt-6"
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
        isOpen={pendingDelete !== null}
        onClose={() => {
          if (!deleting) {
            setPendingDelete(null);
            setDeleteError(null);
          }
        }}
        title={t("parents.deactivateTitle")}
      >
        {pendingDelete ? (
          <div className="grid gap-4">
            <p>
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
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
              <Button
                className="sm:w-auto"
                disabled={deleting}
                onClick={() => {
                  setPendingDelete(null);
                  setDeleteError(null);
                }}
                type="button"
                variant="secondary"
              >
                {t("common.cancel")}
              </Button>
              <Button
                className="sm:w-auto"
                isLoading={deleting}
                onClick={() => void confirmDeleteParent()}
                type="button"
                variant="destructive"
              >
                {t("parents.deactivateTitle")}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
