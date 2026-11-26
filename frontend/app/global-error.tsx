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

export default function GlobalError({
  error,
  retry,
  reset,
}: {
  error: unknown;
  retry?: () => void;
  reset?: () => void;
}) {
  useEffect(() => {
    console.error("[ViReadGlobalError]", error);
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
    <html lang="vi">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px 16px",
          backgroundColor: "#fffaf0",
          color: "#233e40",
          fontFamily:
            '"Nunito Variable", "Nunito", ui-rounded, system-ui, -apple-system, sans-serif',
        }}
      >
        <title>Sự cố hệ thống | ViRead</title>
        <main
          role="alert"
          style={{
            width: "100%",
            maxWidth: "512px",
            backgroundColor: "#ffffff",
            border: "1px solid #ceded8",
            borderRadius: "12px",
            padding: "32px 24px",
            boxShadow: "0 1px 4px rgba(35, 62, 64, 0.08)",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "13px",
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: "#8f3039",
            }}
          >
            ViRead
          </p>
          <h1
            style={{
              margin: "8px 0 0",
              fontSize: "28px",
              lineHeight: 1.2,
              fontWeight: 800,
            }}
          >
            Ứng dụng đang gặp sự cố tạm thời
          </h1>
          <p
            style={{
              margin: "12px 0 0",
              fontSize: "16px",
              lineHeight: 1.5,
              color: "#52676b",
            }}
          >
            Đã có lỗi ngoài ý muốn khi hiển thị trang. Ba mẹ vui lòng bấm Thử
            lại hoặc tải lại trang chủ ViRead.
          </p>
          {digest ? (
            <p
              style={{
                margin: "12px 0 0",
                fontSize: "12px",
                fontWeight: 600,
                color: "#52676b",
              }}
            >
              Mã tham chiếu: {digest}
            </p>
          ) : null}
          <div
            style={{
              marginTop: "24px",
              display: "flex",
              flexWrap: "wrap",
              gap: "12px",
            }}
          >
            <button
              onClick={handleRetry}
              style={{
                minHeight: "48px",
                padding: "0 20px",
                borderRadius: "8px",
                border: "none",
                backgroundColor: "#087467",
                color: "#ffffff",
                fontSize: "16px",
                fontWeight: 700,
                cursor: "pointer",
              }}
              type="button"
            >
              Thử lại
            </button>
            <Link
              href="/"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minHeight: "48px",
                padding: "0 20px",
                borderRadius: "8px",
                border: "1px solid #ceded8",
                backgroundColor: "#ffffff",
                color: "#233e40",
                fontSize: "16px",
                fontWeight: 700,
                textDecoration: "none",
              }}
            >
              Về trang chủ
            </Link>
          </div>
        </main>
      </body>
    </html>
  );
}
