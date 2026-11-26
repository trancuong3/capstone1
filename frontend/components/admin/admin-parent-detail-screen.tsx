"use client";

import {
  CalendarDays,
  Mail,
  Pencil,
  Phone,
  RefreshCw,
  UsersRound,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
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

  return (
    <>
      <AdminPageHeader
        eyebrow={t("parents.eyebrow")}
        title={
          parent?.display_name?.trim() || t("parents.detail.titleFallback")
        }
        description={t("parents.detail.description")}
        actions={
          <>
            {parent ? (
              <Button
                className="sm:w-auto"
                onClick={openEdit}
                variant="secondary"
              >
                <Pencil aria-hidden className="size-5" />
                {t("parents.detail.editProfile")}
              </Button>
            ) : null}
            <ButtonLink
              className="sm:w-auto"
              href="/admin/parents"
              variant="quiet"
            >
              <UsersRound aria-hidden className="size-5" />
              {t("parents.detail.backToList")}
            </ButtonLink>
          </>
        }
      />

      {actionNotice ? (
        <div
          className="mb-4 rounded-control border border-border bg-white p-4 text-sm font-semibold"
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
              <ButtonLink href="/admin/login" className="sm:w-auto">
                {t("common.signInAgain")}
              </ButtonLink>
            ) : error === "not-found" || error === "forbidden" ? null : (
              <Button
                className="sm:w-auto"
                onClick={() => void load()}
                variant="secondary"
              >
                <RefreshCw aria-hidden className="size-5" />
                {t("common.retry")}
              </Button>
            )}
          </div>
        </StatusMessage>
      ) : parent ? (
        <div className="grid gap-6">
          <Card className="bg-white">
            <h2 className="text-xl font-bold text-ink">
              {t("parents.detail.infoHeading")}
            </h2>

            <dl className="grid gap-4 sm:grid-cols-2">
              <div className="min-w-0 rounded-control border border-border bg-white px-4 py-3">
                <dt className="mb-1 flex items-center gap-2 text-sm font-semibold text-muted">
                  <Mail aria-hidden className="size-4" />
                  {t("parents.emailLabel")}
                </dt>
                <dd className="break-words font-semibold">
                  {parent.email?.trim() || fallbackContact}
                </dd>
              </div>
              <div className="min-w-0 rounded-control border border-border bg-white px-4 py-3">
                <dt className="mb-1 flex items-center gap-2 text-sm font-semibold text-muted">
                  <Phone aria-hidden className="size-4" />
                  {t("parents.detail.phone")}
                </dt>
                <dd className="break-words font-semibold">
                  {parent.phone?.trim() || fallbackContact}
                </dd>
              </div>
              <div className="min-w-0 rounded-control border border-border bg-white px-4 py-3">
                <dt className="mb-1 flex items-center gap-2 text-sm font-semibold text-muted">
                  <CalendarDays aria-hidden className="size-4" />
                  {t("parents.detail.profileCreatedAt")}
                </dt>
                <dd className="font-semibold">
                  {formatDate(parent.created_at, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    fallback: t("common.unknown"),
                  })}
                </dd>
              </div>
              <div className="min-w-0 rounded-control border border-border bg-white px-4 py-3">
                <dt className="mb-1 text-sm font-semibold text-muted">
                  ID Parent
                </dt>
                <dd className="break-all font-semibold">{parent.id}</dd>
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
                  className="text-xl font-semibold text-ink"
                >
                  {t("parents.detail.linkedChildrenHeading")}
                </h2>
                <p className="mt-1 text-sm text-muted">
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
              <div className="grid gap-4 sm:grid-cols-2">
                {parent.children.map((child) => (
                  <Card
                    className="items-center bg-white p-5 text-center sm:p-6"
                    key={child.id}
                  >
                    <div
                      aria-hidden="true"
                      className="grid size-14 shrink-0 place-items-center rounded-full bg-sky text-lg font-bold text-primary"
                    >
                      {child.alias.trim().charAt(0).toLocaleUpperCase(locale) ||
                        "B"}
                    </div>
                    <div className="min-w-0">
                      <h3 className="break-words text-lg font-bold text-ink">
                        {child.alias}
                      </h3>
                      <p className="mt-1 text-sm text-muted">
                        {t("parents.detail.childGrade", {
                          grade: child.grade,
                        })}
                      </p>
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
