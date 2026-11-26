"use client";

import { ArrowLeft, ImagePlus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { AdminBookForm } from "@/components/admin/admin-book-form";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import {
  createBookAssetsService,
  type BookAssetsService,
} from "@/lib/api/book-assets-service";
import { emitStudioTasksChanged } from "@/lib/api/global-tasks-service";
import type { AdminBookCreateDTO } from "@/types/admin";

const ACCEPTED_COVER_TYPES =
  "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

interface AdminNewBookScreenProps {
  readonly assetsService?: BookAssetsService;
}

export function AdminNewBookScreen({
  assetsService,
}: AdminNewBookScreenProps = {}) {
  const { books } = useAdminServices();
  const t = useTranslations("admin");
  const router = useRouter();
  const resolvedAssetsService = useMemo(
    () => assetsService ?? createBookAssetsService(),
    [assetsService],
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stagedCoverFile, setStagedCoverFile] = useState<File | null>(null);
  const [stagedCoverPreviewUrl, setStagedCoverPreviewUrl] = useState<
    string | null
  >(null);
  const [coverNotice, setCoverNotice] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (stagedCoverPreviewUrl && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(stagedCoverPreviewUrl);
      }
    };
  }, [stagedCoverPreviewUrl]);

  const clearStagedCover = useCallback(() => {
    setStagedCoverFile(null);
    setCoverNotice(null);
    setStagedCoverPreviewUrl((prev) => {
      if (prev && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(prev);
      }
      return null;
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, []);

  const handleSelectCoverFile = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0] ?? null;
      event.target.value = "";
      if (!file) return;
      setCoverNotice(null);
      const nextPreviewUrl =
        typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : null;
      setStagedCoverPreviewUrl((prev) => {
        if (prev && typeof URL.revokeObjectURL === "function") {
          URL.revokeObjectURL(prev);
        }
        return nextPreviewUrl;
      });
      setStagedCoverFile(file);
    },
    [],
  );

  async function handleCreateBook(value: AdminBookCreateDTO) {
    setCoverNotice(null);
    const created = await books.create({
      name: value.name.trim(),
      title: value.title.trim(),
      author: value.author?.trim() || null,
      min_grade: value.min_grade,
      max_grade: value.max_grade,
    });

    if (stagedCoverFile) {
      try {
        await resolvedAssetsService.uploadCover(created.id, stagedCoverFile);
        emitStudioTasksChanged();
      } catch {
        // Book creation already succeeded; let Admin refine cover in Cover Studio without creating duplicate books.
        setCoverNotice(
          "Đã tạo sách nhưng chưa tải lên được ảnh bìa đã chọn. Bạn có thể tải lại trong Cover Studio.",
        );
      }
    }

    router.push(`/admin/books/${created.id}`);
  }

  const coverStudioSlot = (
    <div
      className="flex flex-col gap-2.5 rounded-control border border-border bg-white p-3"
      data-testid="admin-new-book-cover-picker"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-bold text-ink">Ảnh bìa tùy chọn</p>
          <p className="text-xs text-muted">
            {stagedCoverFile
              ? `Đã chọn: ${stagedCoverFile.name} — sẽ tự động tải lên ngay sau khi tạo sách.`
              : "Chọn sẵn ảnh bìa JPG, PNG hoặc WEBP (≤ 10 MB) hoặc để trống dùng bìa chữ tự động."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileInputRef}
            accept={ACCEPTED_COVER_TYPES}
            aria-label="Chọn ảnh bìa tùy chọn"
            className="hidden"
            data-testid="new-book-cover-input"
            onChange={handleSelectCoverFile}
            type="file"
          />
          <Button
            className="min-h-11 w-auto px-3.5 text-xs"
            fullWidth={false}
            onClick={() => fileInputRef.current?.click()}
            size="compact"
            type="button"
            variant="secondary"
          >
            <ImagePlus aria-hidden="true" className="size-4" />
            {stagedCoverFile ? "Đổi ảnh bìa" : "Chọn ảnh bìa"}
          </Button>
          {stagedCoverFile ? (
            <Button
              className="min-h-11 w-auto px-3 text-xs"
              fullWidth={false}
              onClick={clearStagedCover}
              size="compact"
              type="button"
              variant="quiet"
            >
              <X aria-hidden="true" className="size-4" />
              Bỏ ảnh bìa
            </Button>
          ) : null}
        </div>
      </div>
      {coverNotice ? (
        <StatusMessage tone="warning">{coverNotice}</StatusMessage>
      ) : null}
    </div>
  );

  return (
    <section className="figma-form-page mx-auto flex w-full max-w-[960px] flex-col gap-4">
      <AdminPageHeader
        title={t("books.new.title")}
        description={t("books.new.description")}
      />
      <Link
        className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href="/admin/books"
      >
        <ArrowLeft aria-hidden className="size-5 rtl:rotate-180" />{" "}
        {t("books.new.cancelAndBack")}
      </Link>
      <Card className="max-w-3xl bg-white sm:px-8 sm:py-8">
        <StatusMessage
          className="mb-5"
          tone="info"
          title={t("books.new.notPublishedTitle")}
        >
          {t("books.new.notPublishedDesc")}
        </StatusMessage>
        <h2 className="mb-4 text-2xl font-extrabold text-ink">
          {t("books.new.infoHeading")}
        </h2>
        <AdminBookForm
          cancelHref="/admin/books"
          coverSourceType={stagedCoverFile ? "USER_UPLOAD" : null}
          coverStudioSlot={coverStudioSlot}
          coverUrl={stagedCoverPreviewUrl}
          initial={{ min_grade: 1, max_grade: 5 }}
          onSubmit={handleCreateBook}
          showLiveCoverPreview
          submitErrorFallback={t("books.new.errors.createFailed")}
          submitLabel={t("books.new.submit")}
        />
      </Card>
    </section>
  );
}
