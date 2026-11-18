"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { useParams } from "next/navigation";

import {
  getSessionReports,
  deleteReadingReport,
  type SavedReadingReport,
} from "@/lib/api/comparison-service";

import { ReadingReport } from "@/components/reading/ReadingReport";
import { Button } from "@/components/common/button";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import type { ReadingAssessmentMetricsDTO } from "@/types/reading";

export default function ReadingReportPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [reports, setReports] = useState<SavedReadingReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [assessment, setAssessment] =
    useState<ReadingAssessmentMetricsDTO | null>(null);

  async function handleDeleteReport(reportId: string) {
    const confirmed = window.confirm(
      "Bạn có chắc chắn muốn xóa báo cáo này không?",
    );

    if (!confirmed) return;

    try {
      await deleteReadingReport(reportId);

      setReports((prev) =>
        prev.filter((report) => report.report_id !== reportId),
      );
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Không thể xóa báo cáo.",
      );
    }
  }

  useEffect(() => {
    let active = true;

    async function loadReports() {
      try {
        setLoading(true);
        setError(null);

        const data = await getSessionReports(sessionId);

        if (active) {
          setReports(data.reports);
          setAssessment(data.assessment ?? null);
        }
      } catch (err) {
        if (active) {
          setReports([]);
          setError(
            err instanceof Error ? err.message : "Không thể tải báo cáo đọc.",
          );
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    if (sessionId) {
      void loadReports();
    }

    return () => {
      active = false;
    };
  }, [reloadKey, sessionId]);

  const reportHeading = (
    <header className="border-b border-border pb-5">
      <Link href="/sessions" className="family-inline-link">
        <ArrowLeft aria-hidden="true" size={16} /> Lịch sử đọc
      </Link>
      <h1 className="book-title text-4xl text-ink">Báo cáo đọc</h1>
    </header>
  );

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        {reportHeading}
        <p>Đang tải báo cáo...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        {reportHeading}
        <p className="text-danger">{error}</p>
        <Button
          className="sm:w-auto"
          onClick={() => setReloadKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          Thử tải lại
        </Button>
      </main>
    );
  }

  if (reports.length === 0) {
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        {reportHeading}
        <p>
          Buổi đọc đã được lưu. Báo cáo đối chiếu sẽ có khi hệ thống ghi nhận
          được lời đọc của bé.
        </p>
        <Button
          className="sm:w-auto"
          onClick={() => setReloadKey((key) => key + 1)}
          variant="secondary"
        >
          <RefreshCw aria-hidden="true" className="size-4" />
          Kiểm tra lại
        </Button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        {reportHeading}
        <p className="mt-1 text-sm text-muted">
          Có {reports.length} báo cáo trong phiên đọc này.
        </p>
      </div>

      <ReadingAssessmentSummary assessment={assessment} />
      {reports.map((report, index) => (
        <section key={report.report_id} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">
              {report.summary.assessment_version === 1
                ? "Đánh giá lượt đầu đã lưu"
                : `Đối chiếu đã lưu ${reports.length - index}`}
            </h2>

            <div className="flex items-center gap-3">
              <p className="text-sm text-muted">
                {new Date(report.created_at).toLocaleString("vi-VN")}
              </p>

              {report.summary.assessment_version !== 1 ? (
                <button
                  type="button"
                  onClick={() => handleDeleteReport(report.report_id)}
                  className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-danger transition hover:bg-red-50"
                >
                  Xóa báo cáo
                </button>
              ) : (
                <span className="text-sm text-muted">
                  Kết quả lượt đầu được giữ nguyên
                </span>
              )}
            </div>
          </div>

          <ReadingReport result={report} sessionId={sessionId} />
        </section>
      ))}
    </main>
  );
}
