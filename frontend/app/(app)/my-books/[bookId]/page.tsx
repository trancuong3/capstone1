import type { Metadata } from "next";

import { ParentPrivateBookManager } from "@/components/books/parent-private-book-manager";

export const metadata: Metadata = {
  title: "Quản lý sách riêng | ViRead",
  description:
    "Tải trang sách, theo dõi OCR, rà chính tả, kiểm tra an toàn và gửi Admin xem xét.",
};

export default async function MyBookDetailPage({
  params,
}: {
  params: Promise<{ bookId: string }>;
}) {
  const { bookId } = await params;
  return <ParentPrivateBookManager bookId={bookId} />;
}
