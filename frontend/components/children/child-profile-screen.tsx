"use client";

import {
  ArrowLeft,
  BookOpenText,
  RefreshCw,
  Trash2,
  UserRoundX,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ChildProfileForm } from "@/components/children/child-profile-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
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
        <Card aria-busy="true" aria-label={t("parent.children.loadingAria")}>
          <span className="sr-only" role="status">
            {t("common.states.loading")}
          </span>

          <Skeleton className="h-11 w-3/5" />
          <Skeleton className="h-7 w-4/5" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-16 w-full" />
        </Card>
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
      <section className="mx-auto flex w-full max-w-[744px] flex-col gap-4">
        <div>
          <h1 className="text-heading font-extrabold text-ink">{title}</h1>

          <p className="mt-2 text-body text-muted">{description}</p>
        </div>
        <Card className="gap-4 sm:px-8 sm:py-8">
          <h2 className="text-2xl font-extrabold text-ink">
            {t("parent.children.cardHeading")}
          </h2>
          {saveNotice === "created" ? (
            <StatusMessage tone="success">
              {t("parent.children.createdSuccess")}
            </StatusMessage>
          ) : null}

          {saveNotice === "updated" ? (
            <StatusMessage tone="success">
              {t("parent.children.updatedSuccess")}
            </StatusMessage>
          ) : null}

          {saveNotice === "error" ? (
            <StatusMessage tone="error">
              {t("parent.children.saveError")}
            </StatusMessage>
          ) : null}

          {saveNotice === "avatar-error" ? (
            <StatusMessage tone="error">
              {t("parent.children.avatarSaveError")}
            </StatusMessage>
          ) : null}

          {deleteError ? (
            <StatusMessage tone="error">
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

              <Button
                onClick={() => {
                  setDeleteError(false);
                  setIsDeleteModalOpen(true);
                }}
                variant="quiet"
              >
                <Trash2 aria-hidden="true" className="size-5" />
                {t("parent.children.deleteAction")}
              </Button>
            </>
          ) : null}
        </Card>
        {!fromRegistration ? (
          <ButtonLink className="min-h-16" href="/children" variant="quiet">
            {t("common.actions.back")}
          </ButtonLink>
        ) : null}
      </section>

      {child ? (
        <Modal
          isOpen={isDeleteModalOpen}
          onClose={() => {
            if (!isDeleting) {
              setIsDeleteModalOpen(false);
            }
          }}
          title={t("parent.children.deleteModalTitle")}
        >
          <div className="flex flex-col gap-6">
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

            <div className="flex flex-col gap-3 sm:flex-row">
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
                variant="primary"
              >
                {t("parent.children.deleteConfirmAction")}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
