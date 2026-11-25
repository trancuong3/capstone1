import type { Metadata } from "next";

import { BookLibraryScreen } from "@/components/books/book-library-screen";

export const metadata: Metadata = {
  title: "Thư viện sách",
};

export default function BooksPage() {
  return <BookLibraryScreen />;
}
