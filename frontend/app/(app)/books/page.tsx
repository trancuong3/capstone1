import type { Metadata } from "next";

import { BookLibraryScreen } from "@/components/books/book-library-screen";
import { AppServicesProvider } from "@/components/providers/app-services-provider";

export const metadata: Metadata = {
  title: "Thư viện sách",
};

export default function BooksPage() {
  return (
    <AppServicesProvider>
      <BookLibraryScreen />
    </AppServicesProvider>
  );
}
