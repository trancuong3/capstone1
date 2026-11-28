"use client";

import {
  ArrowLeft,
  BookOpenText,
  RefreshCw,
  Trash2,
  UserRoundX,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ChildProfileForm } from "@/components/children/child-profile-form";
import { Button, ButtonLink } from "@/components/common/button";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useIsMobileViewport } from "@/components/dashboard/use-is-mobile-viewport";
import { useChildService } from "@/hooks/use-child-service";
import { useI18n } from "@/hooks/use-i18n";
import { ServiceError } from "@/lib/api/service-error";
import type { ChildProfileCreateDTO, ChildProfileDTO } from "@/types/child";

type ChildLoadState =
  | {
      status: "create-ready";
    }
  | {
      status: "loading";
    }
  | {
      status: "ready";
      child: ChildProfileDTO;
    }
  | {
      status: "not-found";
    }
  | {
      status: "error";
    };

interface ChildProfileScreenProps {
  childId?: string;
  fromRegistration?: boolean;
  hasCreatedNotice?: boolean;
  hasAvatarError?: boolean;
  mode: "create" | "edit";
}

export function ChildProfileScreen({
  childId,
  fromRegistration = false,
  hasCreatedNotice = false,
  hasAvatarError = false,
  mode,
}: ChildProfileScreenProps) {
  const { t } = useI18n();
  const childService = useChildService();
  const router = useRouter();
  const isMobile = useIsMobileViewport();

  const [requestKey, setRequestKey] = useState(0);

  const [loadState, setLoadState] = useState<ChildLoadState>(
    mode === "create"
      ? {
          status: "create-ready",
        }
      : {
          status: "loading",
        },
  );

  const [saveNotice, setSaveNotice] = useState<
    "created" | "updated" | "error" | "avatar-error" | null
  >(hasAvatarError ? "avatar-error" : hasCreatedNotice ? "created" : null);
  const [selectedAvatarFile, setSelectedAvatarFile] = useState<File | null>(
    null,
  );
  const [isAvatarRemoved, setIsAvatarRemoved] = useState(false);

  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);

  const [isDeleting, setIsDeleting] = useState(false);

  const [deleteError, setDeleteError] = useState(false);

  useEffect(() => {
    if (mode === "create" || !childId) {
      return;
    }

    const requestedChildId = childId;

    let isActive = true;

    async function loadChild() {
      setLoadState({
        status: "loading",
      });

      try {
        const child = await childService.get(requestedChildId);

        if (!isActive) {
          return;
        }

        setLoadState({
          status: "ready",
          child,
        });
      } catch (error) {
        if (!isActive) {
          return;
        }

        if (
          error instanceof ServiceError &&
          error.code === "RESOURCE_NOT_FOUND"
        ) {
          setLoadState({
            status: "not-found",
          });

          return;
        }

        setLoadState({
          status: "error",
        });
      }
    }

    void loadChild();

    return () => {
      isActive = false;
    };
  }, [childId, childService, mode, requestKey]);

  async function handleSubmit(values: ChildProfileCreateDTO) {
    setSaveNotice(null);
    setDeleteError(false);

    try {
      if (mode === "create") {
        let child = await childService.create(values);

        if (selectedAvatarFile) {
          try {
            child = await childService.uploadAvatar(
              child.id,
              selectedAvatarFile,
            );
          } catch {
            router.push(
              `/children/${encodeURIComponent(child.id)}?created=1&avatarError=1`,
            );
            return;
          }
        }

        if (fromRegistration) {
          router.push(`/books?childId=${encodeURIComponent(child.id)}`);
        } else {
          router.push(`/children/${encodeURIComponent(child.id)}?created=1`);
        }

        return;
      }

      if (!childId) {
        setSaveNotice("error");
        return;
      }

      let child = await childService.update(childId, {
        alias: values.alias,
        grade: values.grade,
      });

      if (selectedAvatarFile) {
        try {
          child = await childService.uploadAvatar(childId, selectedAvatarFile);
        } catch {
          setLoadState({ status: "ready", child });
          setSaveNotice("avatar-error");
          return;
        }
      } else if (isAvatarRemoved && child.avatar_url) {
        try {
          child = await childService.removeAvatar(childId);
        } catch {
          setLoadState({ status: "ready", child });
          setSaveNotice("avatar-error");
          return;
        }
      }

      setLoadState({
        status: "ready",
        child,
      });
      setSelectedAvatarFile(null);
      setIsAvatarRemoved(false);

      setSaveNotice("updated");
    } catch (error) {
      if (
        error instanceof ServiceError &&
        error.code === "RESOURCE_NOT_FOUND"
      ) {
        setLoadState({
          status: "not-found",
        });

        return;
      }

      setSaveNotice("error");
    }
  }

  async function handleDelete() {
    if (!childId || loadState.status !== "ready") {
      return;
    }

    setIsDeleting(true);
    setDeleteError(false);

    try {
      await childService.delete(childId);

      setIsDeleteModalOpen(false);

      router.replace("/children");
    } catch (error) {
      setIsDeleting(false);

      if (
        error instanceof ServiceError &&
        error.code === "RESOURCE_NOT_FOUND"
      ) {
        setIsDeleteModalOpen(false);

        setLoadState({
          status: "not-found",
        });

        return;
      }

      setDeleteError(true);
    }
  }

  if (loadState.status === "loading") {
    return (
      <section className="mx-auto w-full max-w-[744px]">
        <div
          aria-busy="true"
          aria-label={t("parent.children.loadingAria")}
          className="flex w-full flex-col gap-4 rounded-3xl border border-border bg-white p-4 sm:rounded-card sm:p-8"
        >
          <span className="sr-only" role="status">
            {t("common.states.loading")}
          </span>

          <Skeleton className="h-11 w-3/5" />
          <Skeleton className="h-7 w-4/5" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </section>
    );
  }

  if (loadState.status === "not-found") {
    return (
      <section className="mx-auto w-full max-w-[744px]">
        <EmptyState
          headingLevel={1}
          action={
            <ButtonLink
              className="max-w-80"
              href="/children"
              variant="secondary"
            >
              <ArrowLeft
                aria-hidden="true"
                className="size-5 viread-rtl-flip"
              />
              {t("parent.children.backToList")}
            </ButtonLink>
          }
          description={t("parent.children.notFoundDescription")}
          icon={
            <UserRoundX aria-hidden="true" className="size-10 text-primary" />
          }
          title={t("parent.children.notFoundTitle")}
        />
      </section>
    );
  }

  if (loadState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[744px] flex-col gap-4">
        <StatusMessage title={t("parent.children.loadErrorTitle")} tone="error">
          {t("auth.errors.generic")}
        </StatusMessage>

        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          {t("common.actions.retry")}
        </Button>
      </section>
    );
  }

  const child = loadState.status === "ready" ? loadState.child : null;

  const title = fromRegistration
    ? t("parent.children.onboardingTitle")
    : mode === "create"
      ? t("parent.children.createTitle")
      : t("parent.children.editTitle", {
          alias: child?.alias ?? t("parent.children.childFallback"),
        });

  const description = fromRegistration
    ? t("parent.children.onboardingDescription")
    : mode === "create"
      ? t("parent.children.createDescription")
      : t("parent.children.editDescription");

  return (
    <>
      <section className="mx-auto flex w-full max-w-[744px] flex-col gap-5 pb-2 sm:gap-4 sm:pb-0">
        {isMobile && !fromRegistration ? (
          <Link
            className="inline-flex min-h-11 w-fit items-center gap-1.5 rounded-full border border-border bg-white px-3.5 text-sm font-bold text-primary transition-colors hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-primary"
            href="/children"
          >
            <ArrowLeft aria-hidden="true" className="size-4 viread-rtl-flip" />
            {t("common.actions.back")}
          </Link>
        ) : null}
        <div>
          <h1 className="book-title text-[26px] leading-tight text-ink sm:text-heading sm:font-extrabold">
            {title}
          </h1>

          <p className="mt-1.5 text-sm leading-relaxed text-muted sm:mt-2 sm:text-body">
            {description}
          </p>
        </div>
        <div className="flex w-full flex-col gap-5 rounded-3xl border border-border bg-white p-4 sm:gap-4 sm:rounded-card sm:p-8">
          <h2 className="text-lg font-extrabold text-ink sm:text-2xl">
            {t("parent.children.cardHeading")}
          </h2>
          {saveNotice === "created" ? (
            <StatusMessage compact={isMobile} tone="success">
              {t("parent.children.createdSuccess")}
            </StatusMessage>
          ) : null}

          {saveNotice === "updated" ? (
            <StatusMessage compact={isMobile} tone="success">
              {t("parent.children.updatedSuccess")}
            </StatusMessage>
          ) : null}

          {saveNotice === "error" ? (
            <StatusMessage compact={isMobile} tone="error">
              {t("parent.children.saveError")}
            </StatusMessage>
          ) : null}

          {saveNotice === "avatar-error" ? (
            <StatusMessage compact={isMobile} tone="error">
              {t("parent.children.avatarSaveError")}
            </StatusMessage>
          ) : null}

          {deleteError ? (
            <StatusMessage compact={isMobile} tone="error">
              {t("parent.children.deleteError")}
            </StatusMessage>
          ) : null}

          <ChildProfileForm
            avatarUrl={mode === "edit" ? child?.avatar_url : null}
            showOptionalAvatarNote={mode === "create"}
            defaultValues={
              mode === "edit" && child
                ? {
                    alias: child.alias,
                    grade: child.grade,
                  }
                : undefined
            }
            mode={mode}
            isAvatarRemoved={isAvatarRemoved}
            onSubmit={handleSubmit}
            onAvatarFileChange={(file) => {
              setSelectedAvatarFile(file);
              if (file) setIsAvatarRemoved(false);
            }}
            onAvatarRemove={() => {
              if (isAvatarRemoved) {
                setIsAvatarRemoved(false);
                return;
              }
              setSelectedAvatarFile(null);
              setIsAvatarRemoved(
                loadState.status === "ready" &&
                  Boolean(loadState.child.avatar_url),
              );
            }}
            selectedAvatarFile={selectedAvatarFile}
            submitLabel={
              fromRegistration
                ? t("parent.children.saveAndChooseBook")
                : undefined
            }
          />

          {mode === "edit" && child ? (
            <>
              <ButtonLink
                href={`/books?childId=${encodeURIComponent(child.id)}`}
                variant="secondary"
              >
                <BookOpenText aria-hidden="true" className="size-5" />
                {t("parent.children.chooseBooksFor", { alias: child.alias })}
              </ButtonLink>

              <div className="mt-1 border-t border-border pt-4 sm:mt-0 sm:border-0 sm:pt-0">
                <Button
                  onClick={() => {
                    setDeleteError(false);
                    setIsDeleteModalOpen(true);
                  }}
                  variant="destructive-outline"
                >
                  <Trash2 aria-hidden="true" className="size-5" />
                  {t("parent.children.deleteAction")}
                </Button>
              </div>
            </>
          ) : null}
        </div>
        {!isMobile && !fromRegistration ? (
          <ButtonLink className="min-h-16" href="/children" variant="quiet">
            {t("common.actions.back")}
          </ButtonLink>
        ) : null}
      </section>

      {child ? (
        <Modal
          footer={
            <div className="flex w-full flex-col-reverse gap-2.5 sm:flex-row sm:gap-3">
              <Button
                disabled={isDeleting}
                onClick={() => setIsDeleteModalOpen(false)}
                variant="secondary"
              >
                {t("common.actions.cancel")}
              </Button>

              <Button
                isLoading={isDeleting}
                onClick={() => void handleDelete()}
                variant="destructive"
              >
                {t("parent.children.deleteConfirmAction")}
              </Button>
            </div>
          }
          isOpen={isDeleteModalOpen}
          maxWidth="sm"
          onClose={() => {
            if (!isDeleting) {
              setIsDeleteModalOpen(false);
            }
          }}
          role="alertdialog"
          title={t("parent.children.deleteModalTitle")}
        >
          <div className="flex flex-col gap-4">
            <p className="text-body text-ink">
              {t("parent.children.deleteConfirmPrefix")}
              <strong>{child.alias}</strong>
              {t("parent.children.deleteConfirmQuestion")}
              <br />
              {t("parent.children.deleteIrreversible")}
            </p>

            {deleteError ? (
              <StatusMessage tone="error">
                {t("parent.children.deleteError")}
              </StatusMessage>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
