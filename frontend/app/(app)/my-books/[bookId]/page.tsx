import type { Metadata } from "next";

import { ParentPrivateBookManager } from "@/components/books/parent-private-book-manager";
import { translateMessage } from "@/lib/i18n/formatter";
import { getServerI18n } from "@/lib/i18n/server";
import { viMessages } from "@/messages/vi";

export async function generateMetadata(): Promise<Metadata> {
  const { locale, messages } = await getServerI18n();
  return {
    title: translateMessage(
      messages,
      viMessages,
      locale,
      "books.myBooks.detailPageTitle",
    ),
    description: translateMessage(
      messages,
      viMessages,
      locale,
      "books.myBooks.detailPageDescription",
    ),
  };
}

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
