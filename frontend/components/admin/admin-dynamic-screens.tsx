"use client";

import dynamic from "next/dynamic";

import { AdminLoading } from "@/components/admin/admin-ui";
import { useTranslations } from "@/hooks/use-i18n";

function DynamicAdminLoading({ labelKey }: { labelKey: string }) {
  const t = useTranslations("admin");
  return <AdminLoading label={t(labelKey)} />;
}

export const DynamicAdminOcrReviewScreen = dynamic(
  () =>
    import("@/components/admin/admin-ocr-review-screen").then(
      (mod) => mod.AdminOcrReviewScreen,
    ),
  {
    ssr: false,
    loading: () => <DynamicAdminLoading labelKey="dynamicLoading.ocrReview" />,
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
      <DynamicAdminLoading labelKey="dynamicLoading.contentQuality" />
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
    loading: () => (
      <DynamicAdminLoading labelKey="dynamicLoading.vireadTraining" />
    ),
  },
);
