"use client";

import { ArrowLeft, BookOpenText, RefreshCw, UserRoundX } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { ChildProfileForm } from "@/components/children/child-profile-form";
import { Button, ButtonLink } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { EmptyState } from "@/components/common/empty-state";
import { Skeleton } from "@/components/common/skeleton";
import { StatusMessage } from "@/components/common/status-message";
import { useChildService } from "@/hooks/use-child-service";
import { ServiceError } from "@/lib/api/service-error";
import type { ChildProfileCreateDTO, ChildProfileDTO } from "@/types/child";

type ChildLoadState =
  | { status: "create-ready" }
  | { status: "loading" }
  | { status: "ready"; child: ChildProfileDTO }
  | { status: "not-found" }
  | { status: "error" };

interface ChildProfileScreenProps {
  childId?: string;
  fromRegistration?: boolean;
  hasCreatedNotice?: boolean;
  mode: "create" | "edit";
}

export function ChildProfileScreen({
  childId,
  fromRegistration = false,
  hasCreatedNotice = false,
  mode,
}: ChildProfileScreenProps) {
  const childService = useChildService();
  const router = useRouter();
  const [requestKey, setRequestKey] = useState(0);
  const [loadState, setLoadState] = useState<ChildLoadState>(() =>
    mode === "create" ? { status: "create-ready" } : { status: "loading" },
  );
  const [saveNotice, setSaveNotice] = useState<
    "created" | "updated" | "error" | null
  >(hasCreatedNotice ? "created" : null);

  useEffect(() => {
    if (mode === "create" || !childId) {
      return;
    }

    let isActive = true;
    const requestedChildId = childId;

    async function loadChild() {
      setLoadState({ status: "loading" });

      try {
        const child = await childService.get(requestedChildId);
        if (isActive) {
          setLoadState({ status: "ready", child });
        }
      } catch (error) {
        if (!isActive) {
          return;
        }

        if (
          error instanceof ServiceError &&
          error.code === "RESOURCE_NOT_FOUND"
        ) {
          setLoadState({ status: "not-found" });
          return;
        }

        setLoadState({ status: "error" });
      }
    }

    void loadChild();
    return () => {
      isActive = false;
    };
  }, [childId, childService, mode, requestKey]);

  async function handleSubmit(values: ChildProfileCreateDTO) {
    setSaveNotice(null);

    try {
      if (mode === "create") {
        const child = await childService.create(values);
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

      const child = await childService.update(childId, values);
      setLoadState({ status: "ready", child });
      setSaveNotice("updated");
    } catch (error) {
      if (
        error instanceof ServiceError &&
        error.code === "RESOURCE_NOT_FOUND"
      ) {
        setLoadState({ status: "not-found" });
        return;
      }

      setSaveNotice("error");
    }
  }

  if (loadState.status === "loading") {
    return (
      <section className="mx-auto w-full max-w-[640px]">
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
      <section className="mx-auto w-full max-w-[720px]">
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
      <section className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
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
      ? "Thêm một bạn nhỏ vào tài khoản của ba mẹ."
      : "Ba mẹ có thể sửa tên gọi và lớp của bé.";

  return (
    <section className="mx-auto w-full max-w-[640px]">
      <Card>
        <div>
          <h1 className="text-heading font-extrabold text-ink">{title}</h1>
          <p className="mt-4 text-body text-muted sm:mt-6">{description}</p>
        </div>
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
        <ChildProfileForm
          defaultValues={
            mode === "edit" && child
              ? {
                  alias: child.alias,
                  grade: child.grade,
                }
              : undefined
          }
          mode={mode}
          onSubmit={handleSubmit}
          submitLabel={fromRegistration ? "Lưu và chọn sách" : undefined}
        />
        {mode === "edit" && child ? (
          <ButtonLink
            href={`/books?childId=${encodeURIComponent(child.id)}`}
            variant="secondary"
          >
            <BookOpenText aria-hidden="true" className="size-5" />
            Chọn sách cho {child.alias}
          </ButtonLink>
        ) : null}
        {!fromRegistration ? (
          <ButtonLink href="/children" variant="quiet">
            <ArrowLeft aria-hidden="true" className="size-5" />
            Về danh sách hồ sơ
          </ButtonLink>
        ) : null}
      </Card>
    </section>
  );
}
