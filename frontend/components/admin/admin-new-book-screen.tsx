"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AdminBookForm } from "@/components/admin/admin-book-form";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { Card } from "@/components/common/card";
import { useAdminServices } from "@/hooks/use-admin-services";

export function AdminNewBookScreen() {
  const { books } = useAdminServices();
  const router = useRouter();
  return (
    <>
      <AdminPageHeader
        eyebrow="Kho sách"
        title="Tạo sách mới"
        description="Tạo metadata trước, sau đó tải ảnh trang để bắt đầu OCR."
      />
      <Link
        className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href="/admin/books"
      >
        <ArrowLeft aria-hidden className="size-5" /> Hủy và quay lại
      </Link>
      <Card className="max-w-3xl bg-white">
        <AdminBookForm
          submitLabel="Tạo sách"
          onSubmit={async (value) => {
            const book = await books.create(value);
            router.push(`/admin/books/${book.id}`);
          }}
        />
      </Card>
    </>
  );
}
