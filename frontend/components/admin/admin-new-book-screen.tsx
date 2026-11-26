"use client";

import { useRouter } from "next/navigation";

import { AdminBookForm } from "@/components/admin/admin-book-form";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import { useTranslations } from "@/hooks/use-i18n";
import type { AdminBookCreateDTO } from "@/types/admin";

export function AdminNewBookScreen() {
  const { books } = useAdminServices();
  const t = useTranslations("admin");
  const router = useRouter();

  async function handleCreate(value: AdminBookCreateDTO) {
    const created = await books.create({
      name: value.name.trim(),
      title: value.title.trim(),
      author: value.author?.trim() || null,
      min_grade: value.min_grade,
      max_grade: value.max_grade,
    });
    router.push(`/admin/books/${created.id}`);
  }

  return (
    <section className="space-y-4">
      <AdminPageHeader
        breadcrumbs={[
          { label: t("books.detail.backToBooks"), href: "/admin/books" },
          { label: t("books.new.title") },
        ]}
        description={t("books.new.description")}
        eyebrow={t("books.eyebrow")}
        title={t("books.new.title")}
      />

      <AdminBookForm
        bookId="new-book-preview"
        cancelHref="/admin/books"
        errorFallbackMessage={t("books.new.errors.createFailed")}
        formBanner={
          <StatusMessage title={t("books.new.notPublishedTitle")} tone="info">
            {t("books.new.notPublishedDesc")}
          </StatusMessage>
        }
        formHeading={t("books.new.infoHeading")}
        initial={{ min_grade: 1, max_grade: 5 }}
        onSubmit={handleCreate}
        showLiveCoverPreview
        submitLabel={t("books.new.submit")}
      />
    </section>
  );
}
