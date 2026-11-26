import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Không tìm thấy trang",
  description: "Trang bạn đang tìm kiếm không tồn tại trên ViRead.",
};

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <section
        aria-labelledby="not-found-title"
        className="w-full max-w-lg rounded-card border border-border bg-white p-6 shadow-sm sm:p-8"
      >
        <p className="text-sm font-bold uppercase tracking-wide text-primary">
          404 · Không tìm thấy
        </p>
        <h1
          className="book-title mt-2 text-2xl text-ink sm:text-3xl"
          id="not-found-title"
        >
          Không tìm thấy trang này
        </h1>
        <p className="mt-3 text-body text-muted">
          Đường dẫn có thể đã thay đổi hoặc không còn tồn tại. Ba mẹ hãy quay về
          trang chủ hoặc góc đọc gia đình để tiếp tục cùng bé nhé.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            className="inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-5 text-button font-bold text-white transition-colors hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            href="/dashboard"
          >
            Về góc đọc gia đình
          </Link>
          <Link
            className="inline-flex min-h-12 items-center justify-center rounded-control border border-border bg-white px-5 text-button font-bold text-ink transition-colors hover:bg-canvas focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            href="/"
          >
            Về trang chủ
          </Link>
        </div>
      </section>
    </main>
  );
}
