"use client";

import Link from "next/link";
import { useEffect } from "react";

function readErrorDigest(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof error.digest === "string" &&
    error.digest.trim().length > 0
  ) {
    return error.digest.trim();
  }
  return null;
}

export default function AppErrorBoundary({
  error,
  retry,
  reset,
}: {
  error: unknown;
  retry?: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    console.error("[ViReadErrorBoundary]", error);
  }, [error]);

  const digest = readErrorDigest(error);
  const handleRetry = () => {
    if (typeof retry === "function") {
      retry();
      return;
    }
    if (typeof reset === "function") {
      reset();
      return;
    }
    window.location.reload();
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-10">
      <section
        aria-labelledby="app-error-title"
        className="w-full max-w-lg rounded-card border border-border bg-white p-6 shadow-sm sm:p-8"
        role="alert"
      >
        <p className="text-sm font-bold uppercase tracking-wide text-danger">
          Sự cố tạm thời
        </p>
        <h1
          className="book-title mt-2 text-2xl text-ink sm:text-3xl"
          id="app-error-title"
        >
          Đã có sự cố xảy ra
        </h1>
        <p className="mt-3 text-body text-muted">
          Trang này gặp lỗi ngoài ý muốn trong quá trình tải. Ba mẹ hãy thử tải
          lại hoặc quay về trang chủ ViRead nhé.
        </p>
        {digest ? (
          <p className="mt-3 text-xs font-semibold text-muted tabular-nums">
            Mã tham chiếu: {digest}
          </p>
        ) : null}
        <div className="mt-6 flex flex-wrap gap-3">
          <button
            className="inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-5 text-button font-bold text-white transition-colors hover:bg-primary-hover focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            onClick={handleRetry}
            type="button"
          >
            Thử lại
          </button>
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
