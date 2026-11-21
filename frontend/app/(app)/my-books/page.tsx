import type { Metadata } from "next";

import { ParentMyBooksScreen } from "@/components/books/parent-my-books-screen";

export const metadata: Metadata = {
  title: "Sách của tôi | ViRead",
  description:
    "Tạo và quản lý sách riêng của gia đình với kiểm tra OCR, chính tả và an toàn cho trẻ.",
};

export default function MyBooksPage() {
  return <ParentMyBooksScreen />;
}
