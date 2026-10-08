"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { AdminPageHeader } from "@/components/admin/admin-ui";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";

export function AdminNewBookScreen() {
  return (
    <>
      <AdminPageHeader
        eyebrow="Kho sách"
        title="Tạo sách mới"
        description="Tạo sách chưa sẵn sàng. Phase hiện tại chỉ hỗ trợ đọc dữ liệu thật từ API."
      />
      <Link
        className="mb-6 inline-flex min-h-11 items-center gap-2 rounded-md px-1 font-extrabold text-primary focus-visible:outline-3 focus-visible:outline-primary"
        href="/admin/books"
      >
        <ArrowLeft aria-hidden className="size-5" /> Hủy và quay lại
      </Link>
      <Card className="max-w-3xl bg-white">
        <StatusMessage tone="info">
          API tạo sách chưa được triển khai trong phạm vi này. Chưa thể tạo sách
          hoặc tải ảnh để chạy OCR.
        </StatusMessage>
      </Card>
    </>
  );
}
