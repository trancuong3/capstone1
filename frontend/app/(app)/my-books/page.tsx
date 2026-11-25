import type { Metadata } from "next";

import { ParentMyBooksScreen } from "@/components/books/parent-my-books-screen";

export const metadata: Metadata = {
  title: "Sách của tôi | ViRead",
  description:
    "Tạo và quản lý sách riêng của gia đình với kiểm tra OCR, chính tả và an toàn cho trẻ.",
};

interface MyBooksPageProps {
  searchParams?: Promise<{ page?: string | string[] }>;
}

function parsePositivePage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export default async function MyBooksPage({ searchParams }: MyBooksPageProps) {
  const query = searchParams ? await searchParams : undefined;
  return <ParentMyBooksScreen initialPage={parsePositivePage(query?.page)} />;
}
