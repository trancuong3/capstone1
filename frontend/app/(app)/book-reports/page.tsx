import type { Metadata } from "next";

import { ParentBookReportsScreen } from "@/components/books/parent-book-reports-screen";

export const metadata: Metadata = {
  title: "Báo cáo chất lượng sách",
};

export default function BookReportsPage() {
  return <ParentBookReportsScreen />;
}
