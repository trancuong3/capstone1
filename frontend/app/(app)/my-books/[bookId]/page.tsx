import type { Metadata } from "next";

import { ParentPrivateBookManager } from "@/components/books/parent-private-book-manager";

export const metadata: Metadata = {
  title: "Quản lý sách riêng | ViRead",
  description:
    "Tải trang sách, theo dõi OCR, rà chính tả, kiểm tra an toàn và gửi Admin xem xét.",
};

function parsePositivePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export default async function MyBookDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ bookId: string }>;
  searchParams?: Promise<{ fromPage?: string | string[] }>;
}) {
  const [{ bookId }, query] = await Promise.all([
    params,
    searchParams ?? Promise.resolve(undefined),
  ]);
  return (
    <ParentPrivateBookManager
      bookId={bookId}
      returnPage={parsePositivePage(query?.fromPage)}
    />
  );
}
