import type { Metadata } from "next";

import { ParentMyBooksScreen } from "@/components/books/parent-my-books-screen";
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
      "books.myBooks.pageTitle",
    ),
    description: translateMessage(
      messages,
      viMessages,
      locale,
      "books.myBooks.pageDescription",
    ),
  };
}

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
