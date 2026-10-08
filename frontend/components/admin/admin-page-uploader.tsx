"use client";

import { UploadCloud } from "lucide-react";
import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";

interface AdminPageUploaderProps {
  bookId: string;
  nextPageNumber: number;
  onUploaded: () => void;
}

/** Compatibility view only; there is no upload/OCR implementation in this scope. */
export function AdminPageUploader({ bookId }: AdminPageUploaderProps) {
  return (
    <section
      aria-labelledby="upload-title"
      className="rounded-card bg-sky p-4 sm:p-6"
    >
      <h2 className="mb-4 text-2xl font-black" id="upload-title">
        Tải trang sách
      </h2>
      <StatusMessage className="mb-4" tone="info">
        Tải ảnh và chạy OCR chưa sẵn sàng. Chưa có API ghi trong phạm vi hiện
        tại.
      </StatusMessage>
      <p className="mb-4 break-all text-sm text-muted">ID sách: {bookId}</p>
      <label className="flex min-h-36 cursor-not-allowed flex-col items-center justify-center rounded-control border-2 border-dashed border-border bg-white p-5 text-center text-muted">
        <UploadCloud aria-hidden className="mb-2 size-8" />
        <span className="font-extrabold">
          Chọn ảnh trang sách — chưa sẵn sàng
        </span>
        <input disabled className="sr-only" type="file" />
      </label>
      <Button className="mt-4 sm:w-auto" disabled>
        Tải trang lên
      </Button>
    </section>
  );
}
