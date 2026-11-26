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
import { useContext, useEffect, useState } from "react";

import { ChildProfileForm } from "@/components/children/child-profile-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Modal } from "@/components/common/modal";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { AppStoreContext } from "@/components/providers/app-store-provider";
import { useChildService } from "@/hooks/use-child-service";
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
  const childService = useChildService();
  const appStore = useContext(AppStoreContext);
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

      if (appStore?.selectedChildId === childId) {
        appStore.clearSelectedChild();
      }

      setIsDeleteModalOpen(false);

      router.replace("/children");
    } catch (error) {
      setIsDeleting(false);

      if (
        error instanceof ServiceError &&
        error.code === "RESOURCE_NOT_FOUND"
      ) {
        if (appStore?.selectedChildId === childId) {
          appStore.clearSelectedChild();
        }
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
        <Card aria-busy="true" aria-label="Đang tải hồ sơ bé">
          <span className="sr-only" role="status">
            Đang tải…
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
              <ArrowLeft aria-hidden="true" className="size-5" />
              Về danh sách hồ sơ
            </ButtonLink>
          }
          description="Hồ sơ này không tồn tại hoặc không thuộc tài khoản hiện tại."
          icon={
            <UserRoundX aria-hidden="true" className="size-10 text-primary" />
          }
          title="Không tìm thấy hồ sơ bé"
        />
      </section>
    );
  }

  if (loadState.status === "error") {
    return (
      <section className="mx-auto flex w-full max-w-[744px] flex-col gap-4">
        <StatusMessage title="Chưa tải được hồ sơ bé" tone="error">
          Có lỗi xảy ra. Ba mẹ vui lòng thử lại sau.
        </StatusMessage>

        <Button
          className="sm:w-auto sm:self-start sm:px-8"
          onClick={() => setRequestKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-5" />
          Thử lại
        </Button>
      </section>
    );
  }

  const child = loadState.status === "ready" ? loadState.child : null;

  const title = fromRegistration
    ? "Tài khoản đã sẵn sàng"
    : mode === "create"
      ? "Tạo hồ sơ bé"
      : `Hồ sơ của ${child?.alias ?? "bé"}`;

  const description = fromRegistration
    ? "Ba mẹ tạo hồ sơ đầu tiên để bé bắt đầu đọc nhé."
    : mode === "create"
      ? "Tạo hồ sơ để bắt đầu hành trình đọc cùng ViRead."
      : "Xem và chỉnh sửa hồ sơ của bé.";

  return (
    <>
      <section className="mx-auto flex w-full max-w-[744px] flex-col gap-3 md:gap-4">
        {!fromRegistration ? (
          <div className="flex items-center justify-between gap-2">
            <Link
              className="-ml-2 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-control px-2 text-sm font-bold text-primary hover:bg-sky focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
              href="/children"
            >
              <ArrowLeft aria-hidden="true" className="size-4 shrink-0" />
              Quay lại
            </Link>
          </div>
        ) : null}
        <div>
          <h1 className="text-xl font-extrabold text-ink md:text-heading">
            {title}
          </h1>

          <p className="mt-2 hidden text-body text-muted md:block">
            {description}
          </p>
        </div>
        <Card className="gap-3.5 p-4 sm:gap-4 sm:px-8 sm:py-8">
          <h2 className="text-lg font-extrabold text-ink md:text-2xl">
            Thông tin của bé
          </h2>
          {saveNotice === "created" ? (
            <StatusMessage tone="success">Hồ sơ bé đã được tạo.</StatusMessage>
          ) : null}

          {saveNotice === "updated" ? (
            <StatusMessage tone="success">
              Thay đổi của hồ sơ bé đã được lưu.
            </StatusMessage>
          ) : null}

          {saveNotice === "error" ? (
            <StatusMessage tone="error">
              Chưa thể lưu hồ sơ. Ba mẹ vui lòng thử lại sau.
            </StatusMessage>
          ) : null}

          {saveNotice === "avatar-error" ? (
            <StatusMessage tone="error">
              Thông tin hồ sơ đã lưu, nhưng ảnh đại diện chưa được cập nhật. Ba
              mẹ có thể thử tải ảnh lại.
            </StatusMessage>
          ) : null}

          {deleteError ? (
            <StatusMessage tone="error">
              Chưa thể xóa hồ sơ. Ba mẹ vui lòng thử lại sau.
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
            submitLabel={fromRegistration ? "Lưu và chọn sách" : undefined}
          />

          {mode === "edit" && child ? (
            <>
              <ButtonLink
                href={`/books?childId=${encodeURIComponent(child.id)}`}
                variant="secondary"
              >
                <BookOpenText aria-hidden="true" className="size-5" />
                Chọn sách cho {child.alias}
              </ButtonLink>

              <Button
                onClick={() => {
                  setDeleteError(false);
                  setIsDeleteModalOpen(true);
                }}
                variant="quiet"
              >
                <Trash2 aria-hidden="true" className="size-5" />
                Xóa hồ sơ bé
              </Button>
            </>
          ) : null}
        </Card>
      </section>

      {child ? (
        <Modal
          isOpen={isDeleteModalOpen}
          onClose={() => {
            if (!isDeleting) {
              setIsDeleteModalOpen(false);
            }
          }}
          title="Xóa hồ sơ bé?"
        >
          <div className="flex flex-col gap-6">
            <p className="text-body text-ink">
              Bạn có chắc muốn xóa hồ sơ của <strong>{child.alias}</strong>?
              <br />
              Thao tác này không thể hoàn tác.
            </p>

            {deleteError ? (
              <StatusMessage tone="error">
                Chưa thể xóa hồ sơ. Ba mẹ vui lòng thử lại sau.
              </StatusMessage>
            ) : null}

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                disabled={isDeleting}
                onClick={() => setIsDeleteModalOpen(false)}
                variant="secondary"
              >
                Hủy
              </Button>

              <Button
                isLoading={isDeleting}
                onClick={() => void handleDelete()}
                variant="primary"
              >
                Xóa hồ sơ
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </>
  );
}
