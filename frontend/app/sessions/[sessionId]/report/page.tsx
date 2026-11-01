
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

import {
  getSessionReports,
  deleteReadingReport,
  type SavedReadingReport,
} from "@/lib/api/comparison-service";

import { ReadingReport } from "@/components/reading/ReadingReport";

export default function ReadingReportPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [reports, setReports] = useState<SavedReadingReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
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
            err instanceof Error
                ? err.message
                : "Không thể xóa báo cáo.",
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
        console.log("Saved reports:", data.reports);
        console.log("Saved alignment:", data.reports[0]?.alignment);

        if (active) {
          setReports(data.reports);
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : "Không thể tải báo cáo đọc.",
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
  }, [sessionId]);

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-2xl font-bold">Báo cáo đọc</h1>
        <p>Đang tải báo cáo...</p>
      </main>
    );
  }

  if (error) {
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-2xl font-bold">Báo cáo đọc</h1>
        <p className="text-red-600">{error}</p>
      </main>
    );
  }

  if (reports.length === 0) {
    return (
      <main className="mx-auto max-w-4xl space-y-4 p-6">
        <h1 className="text-2xl font-bold">Báo cáo đọc</h1>
        <p>Session này chưa có báo cáo đọc.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Báo cáo đọc</h1>
        <p className="mt-1 text-sm text-gray-500">
          Có {reports.length} báo cáo trong phiên đọc này.
        </p>
      </div>

      {reports.map((report, index) => (
        <section key={report.report_id} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">
                Lần đọc {reports.length - index}
            </h2>

            <div className="flex items-center gap-3">
                <p className="text-sm text-gray-500">
                {new Date(report.created_at).toLocaleString("vi-VN")}
                </p>

                <button
                type="button"
                onClick={() => handleDeleteReport(report.report_id)}
                className="rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50"
                >
                Xóa báo cáo
                </button>
            </div>
            </div>

            <ReadingReport
            result={report}
            sessionId={sessionId}
            />
        </section>
        ))}
    </main>
  );
}
