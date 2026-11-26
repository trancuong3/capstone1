"use client";

import {
  ArrowLeft,
  CalendarDays,
  Hash,
  Mail,
  Pencil,
  Phone,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AdminBadge,
  AdminLoading,
  AdminPageHeader,
} from "@/components/admin/admin-ui";
import {
  AdminParentFormModal,
  type AdminParentFormValues,
  type AdminParentFormSubmission,
} from "@/components/admin/admin-parent-form-modal";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import { isServiceError } from "@/lib/api/service-error";
import type { TranslateFn } from "@/lib/i18n/types";
import type { AdminParentDetailDTO } from "@/types/admin";

type LoadError = "auth" | "forbidden" | "not-found" | "unavailable";

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

function contactMessage(
  status: AdminParentDetailDTO["contact_info_status"],
  t: TranslateFn,
) {
  switch (status) {
    case "not_configured":
      return t("parents.detail.authNotConfigured");
    case "user_not_found":
      return t("parents.detail.authNotFound");
    case "lookup_failed":
      return t("parents.detail.authUnavailable");
    case "available":
      return null;
  }
}

export function AdminParentDetailScreen({ parentId }: { parentId: string }) {
  const { parents } = useAdminServices();
  const t = useTranslations("admin");
  const { formatDate, locale } = useI18n();
  const [parent, setParent] = useState<AdminParentDetailDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LoadError | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editInitialValues, setEditInitialValues] =
    useState<AdminParentFormValues>({
      display_name: "",
      email: "",
      phone: "",
    });
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
        const detail = await parents.getById(parentId, signal);
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
    [parentId, parents],
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
    ? contactMessage(parent.contact_info_status, t)
    : null;

  function openEdit() {
    if (!parent) return;
    setEditInitialValues({
      display_name: parent.display_name ?? "",
      email: parent.email ?? "",
      phone: parent.phone ?? "",
    });
    setActionError(null);
    setEditOpen(true);
  }

  async function submitEdit(
    submission: AdminParentFormSubmission,
  ): Promise<void> {
    if (!parent || submission.mode !== "edit") {
      throw new Error("Parent is unavailable.");
    }
    const updated = await parents.update(parent.id, submission.input);
    setParent(updated);
  }

  function handleEditSuccess() {
    setEditOpen(false);
    setActionNotice(t("parents.notices.updated"));
  }

  const fallbackContact =
    parent?.contact_info_status === "available"
      ? t("common.notProvided")
      : t("common.notAvailable");

  const resolvedTitle =
    parent?.display_name?.trim() || t("parents.detail.titleFallback");

  return (
    <>
      <AdminPageHeader
        breadcrumbs={[
          { label: t("layout.nav.parents"), href: "/admin/parents" },
          { label: resolvedTitle },
        ]}
        eyebrow={t("parents.eyebrow")}
        title={resolvedTitle}
        description={t("parents.detail.description")}
        actions={
          <>
            {parent ? (
              <Button
                fullWidth={false}
                onClick={openEdit}
                size="admin"
                variant="secondary"
              >
                <Pencil aria-hidden className="size-4" />
                {t("parents.detail.editProfile")}
              </Button>
            ) : null}
            <ButtonLink
              fullWidth={false}
              href="/admin/parents"
              size="admin"
              variant="outline"
            >
              <ArrowLeft aria-hidden className="size-4 viread-rtl-flip" />
              {t("parents.detail.backToList")}
            </ButtonLink>
          </>
        }
      />

      {actionNotice ? (
        <div
          className="mb-4 rounded-xl border border-primary/25 bg-sky/40 px-4 py-3 text-sm font-semibold text-primary-hover"
          role="status"
        >
          {actionNotice}
        </div>
      ) : null}
      {actionError ? (
        <div className="mb-4">
          <StatusMessage tone="error" title={actionError}>
            {t("parents.detail.retryHint")}
          </StatusMessage>
        </div>
      ) : null}
      {loading ? (
        <AdminLoading label={t("parents.detail.loading")} />
      ) : error ? (
        <StatusMessage
          tone="error"
          title={
            error === "auth"
              ? t("common.sessionInvalidTitle")
              : error === "forbidden"
                ? t("parents.detail.forbiddenTitle")
                : error === "not-found"
                  ? t("parents.detail.notFoundTitle")
                  : t("parents.detail.loadErrorTitle")
          }
        >
          <div className="flex flex-col items-start gap-3">
            <p>
              {error === "auth"
                ? t("parents.detail.authDesc")
                : error === "forbidden"
                  ? t("parents.detail.forbiddenDesc")
                  : error === "not-found"
                    ? t("parents.detail.notFoundDesc")
                    : t("parents.detail.genericDesc")}
            </p>
            {error === "auth" ? (
              <ButtonLink fullWidth={false} href="/admin/login" size="admin">
                {t("common.signInAgain")}
              </ButtonLink>
            ) : error === "not-found" || error === "forbidden" ? null : (
              <Button
                fullWidth={false}
                onClick={() => void load()}
                size="admin"
                variant="outline"
              >
                <RefreshCw aria-hidden className="size-4" />
                {t("common.retry")}
              </Button>
            )}
          </div>
        </StatusMessage>
      ) : parent ? (
        <div className="grid gap-5">
          <Card className="bg-white p-5">
            <h2 className="text-lg font-extrabold text-ink">
              {t("parents.detail.infoHeading")}
            </h2>

            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0 rounded-control border border-border bg-surface-subtle/40 px-3.5 py-2.5">
                <dt className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted">
                  <Mail aria-hidden className="size-3.5" />
                  {t("parents.emailLabel")}
                </dt>
                <dd className="break-words text-sm font-semibold text-ink">
                  {parent.email?.trim() || fallbackContact}
                </dd>
              </div>
              <div className="min-w-0 rounded-control border border-border bg-surface-subtle/40 px-3.5 py-2.5">
                <dt className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted">
                  <Phone aria-hidden className="size-3.5" />
                  {t("parents.detail.phone")}
                </dt>
                <dd className="break-words text-sm font-semibold text-ink tabular-nums">
                  {parent.phone?.trim() || fallbackContact}
                </dd>
              </div>
              <div className="min-w-0 rounded-control border border-border bg-surface-subtle/40 px-3.5 py-2.5">
                <dt className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted">
                  <CalendarDays aria-hidden className="size-3.5" />
                  {t("parents.detail.profileCreatedAt")}
                </dt>
                <dd className="text-sm font-semibold text-ink tabular-nums">
                  {formatDate(parent.created_at, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    fallback: t("common.unknown"),
                  })}
                </dd>
              </div>
              <div className="min-w-0 rounded-control border border-border bg-surface-subtle/40 px-3.5 py-2.5">
                <dt className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted">
                  <Hash aria-hidden className="size-3.5" />
                  {t("parents.detail.parentIdLabel", undefined, "Mã phụ huynh")}
                </dt>
                <dd className="break-all font-mono text-xs font-semibold text-ink">
                  {parent.id}
                </dd>
              </div>
            </dl>

            {contactNotice ? (
              <div
                className="rounded-control border border-border bg-surface-subtle/60 px-3.5 py-2.5 text-sm text-muted"
                role="status"
              >
                {contactNotice}
              </div>
            ) : null}
          </Card>

          <section aria-labelledby="children-heading" className="grid gap-3.5">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2
                  id="children-heading"
                  className="text-lg font-extrabold text-ink"
                >
                  {t("parents.detail.linkedChildrenHeading")}
                </h2>
                <p className="mt-0.5 text-sm text-muted">
                  {t("parents.detail.linkedChildrenCount", {
                    count: parent.children.length,
                  })}
                </p>
              </div>
            </div>

            {parent.children.length === 0 ? (
              <EmptyState
                title={t("parents.detail.noChildrenTitle")}
                description={t("parents.detail.noChildrenDesc")}
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {parent.children.map((child) => (
                  <Card
                    className="flex-row items-center gap-3.5 bg-white p-4 text-start"
                    key={child.id}
                  >
                    <div
                      aria-hidden="true"
                      className="grid size-11 shrink-0 place-items-center rounded-full border border-primary/20 bg-sky text-base font-extrabold text-primary-hover"
                    >
                      {child.alias.trim().charAt(0).toLocaleUpperCase(locale) ||
                        "B"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-base font-bold text-ink">
                        {child.alias}
                      </h3>
                      <div className="mt-1 flex items-center gap-2">
                        <AdminBadge tone="info">
                          {t("parents.detail.childGrade", {
                            grade: child.grade,
                          })}
                        </AdminBadge>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {editOpen ? (
        <AdminParentFormModal
          isOpen
          mode="edit"
          initialValues={editInitialValues}
          contactInfoEditable={parent?.contact_info_status === "available"}
          contactInfoMessage={contactNotice}
          onClose={() => setEditOpen(false)}
          onSubmit={submitEdit}
          onSuccess={handleEditSuccess}
        />
      ) : null}
    </>
  );
}
