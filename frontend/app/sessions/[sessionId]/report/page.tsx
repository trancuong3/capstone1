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
import { Modal } from "@/components/common/modal";
import { PaginationBar } from "@/components/common/pagination-bar";
import { StatusMessage } from "@/components/common/status-message";
import { ReadingAssessmentSummary } from "@/components/reports/reading-assessment-summary";
import type { ReadingAssessmentMetricsDTO } from "@/types/reading";

const REPORTS_PER_PAGE = 5;

export default function ReadingReportPage() {
  const params = useParams<{ sessionId: string }>();
  const sessionId = params.sessionId;

  const [reports, setReports] = useState<SavedReadingReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [reportPage, setReportPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [assessment, setAssessment] =
    useState<ReadingAssessmentMetricsDTO | null>(null);

  async function confirmDeleteReport() {
    if (!pendingDeleteId || deletingId) return;
    const targetId = pendingDeleteId;
    setDeletingId(targetId);
    setDeleteError(null);

    try {
      await deleteReadingReport(targetId);
      setReports((prev) => {
        const next = prev.filter((report) => report.report_id !== targetId);
        const maxPage = Math.max(1, Math.ceil(next.length / REPORTS_PER_PAGE));
        setReportPage((current) => Math.min(current, maxPage));
        return next;
      });
      setPendingDeleteId(null);
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Không thể xóa báo cáo.",
      );
      setPendingDeleteId(null);
    } finally {
      setDeletingId(null);
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

  const startIdx = (reportPage - 1) * REPORTS_PER_PAGE;
  const visibleReports = reports.slice(startIdx, startIdx + REPORTS_PER_PAGE);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        {reportHeading}
        <p className="mt-1 text-sm text-muted">
          Có {reports.length} báo cáo trong phiên đọc này.
        </p>
      </div>

      {deleteError ? (
        <StatusMessage title="Không thể xóa báo cáo" tone="error">
          {deleteError}
        </StatusMessage>
      ) : null}

      <ReadingAssessmentSummary assessment={assessment} />
      {visibleReports.map((report, index) => (
        <section key={report.report_id} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">
              {report.summary.assessment_version === 1
                ? "Đánh giá lượt đầu đã lưu"
                : `Đối chiếu đã lưu ${reports.length - (startIdx + index)}`}
            </h2>

            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-muted">
                {new Date(report.created_at).toLocaleString("vi-VN")}
              </p>

              {report.summary.assessment_version !== 1 ? (
                <Button
                  className="min-h-11 px-3 py-2 text-sm"
                  disabled={deletingId !== null}
                  fullWidth={false}
                  isLoading={deletingId === report.report_id}
                  onClick={() => {
                    setDeleteError(null);
                    setPendingDeleteId(report.report_id);
                  }}
                  type="button"
                  variant="destructive"
                >
                  Xóa báo cáo
                </Button>
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

      <PaginationBar
        ariaLabel="Phân trang báo cáo phiên đọc"
        itemLabel="báo cáo"
        onPageChange={setReportPage}
        page={reportPage}
        pageSize={REPORTS_PER_PAGE}
        total={reports.length}
      />

      <Modal
        closeOnBackdropClick={deletingId === null}
        closeOnEscape={deletingId === null}
        footer={
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              disabled={deletingId !== null}
              fullWidth={false}
              onClick={() => setPendingDeleteId(null)}
              type="button"
              variant="secondary"
            >
              Hủy
            </Button>
            <Button
              disabled={deletingId !== null}
              fullWidth={false}
              isLoading={deletingId !== null}
              onClick={() => void confirmDeleteReport()}
              type="button"
              variant="destructive"
            >
              Xác nhận xóa
            </Button>
          </div>
        }
        isOpen={pendingDeleteId !== null}
        onClose={() => {
          if (deletingId === null) setPendingDeleteId(null);
        }}
        role="alertdialog"
        showCloseButton={deletingId === null}
        title="Xóa báo cáo đọc?"
        tone="paper"
      >
        <p className="text-body text-ink">
          Bạn có chắc chắn muốn xóa báo cáo đối chiếu này không? Kết quả đánh
          giá lượt đầu vẫn được giữ nguyên.
        </p>
      </Modal>
    </main>
  );
}
