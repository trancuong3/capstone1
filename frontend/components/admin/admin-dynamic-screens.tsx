"use client";

import dynamic from "next/dynamic";

import { AdminLoading } from "@/components/admin/admin-ui";

export const DynamicAdminOcrReviewScreen = dynamic(
  () =>
    import("@/components/admin/admin-ocr-review-screen").then(
      (mod) => mod.AdminOcrReviewScreen,
    ),
  {
    ssr: false,
    loading: () => <AdminLoading label="Đang mở trang OCR Review…" />,
  },
);

export const DynamicAdminBookContentQualityScreen = dynamic(
  () =>
    import("@/components/admin/admin-book-content-quality-screen").then(
      (mod) => mod.AdminBookContentQualityScreen,
    ),
  {
    ssr: false,
    loading: () => (
      <AdminLoading label="Đang tải bảng đánh giá chất lượng nội dung…" />
    ),
  },
);

export const DynamicAdminVireadTrainingScreen = dynamic(
  () =>
    import("@/components/admin/admin-viread-training-screen").then(
      (mod) => mod.AdminVireadTrainingScreen,
    ),
  {
    ssr: false,
    loading: () => <AdminLoading label="Đang tải bảng điều khiển VietOCR V2…" />,
  },
);
