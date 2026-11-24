"use client";

import { CheckCircle2, ShieldCheck, Sparkles, XCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import {
  OCR_CONTRIBUTION_NOTICE_VERSION,
  type ParentOcrContributionStateDTO,
} from "@/types/parent-private-book";

interface ParentOcrContributionCardProps {
  bookTitle: string;
  state: ParentOcrContributionStateDTO;
  disabled?: boolean;
  onUpdate: (input: {
    enabled: boolean;
    rights_confirmed: boolean;
    notice_version: string;
    revoke_reason?: string | null;
  }) => Promise<void>;
}

export function ParentOcrContributionCard({
  bookTitle,
  state,
  disabled = false,
  onUpdate,
}: ParentOcrContributionCardProps) {
  const [rightsChecked, setRightsChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleEnable() {
    if (!rightsChecked) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await onUpdate({
        enabled: true,
        rights_confirmed: true,
        notice_version: OCR_CONTRIBUTION_NOTICE_VERSION,
      });
      setNotice(
        "Đã bật đóng góp mẫu OCR (Luồng 2) cho cuốn sách này. Các trang đủ điều kiện sẽ tự động được đưa vào hàng đợi Admin xác minh từng dòng chữ.",
      );
      setRightsChecked(false);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Không thể cập nhật tùy chọn đóng góp mẫu OCR.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await onUpdate({
        enabled: false,
        rights_confirmed: false,
        notice_version: state.notice_version || OCR_CONTRIBUTION_NOTICE_VERSION,
        revoke_reason: "PARENT_OPTED_OUT",
      });
      setNotice(
        "Đã ngừng đóng góp mẫu OCR cho cuốn sách này. Hệ thống sẽ dừng tuyển mẫu mới và loại mẫu của cuốn sách khỏi các đợt tạo dataset tiếp theo.",
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Không thể ngừng đóng góp mẫu OCR lúc này.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label={`Đóng góp mẫu để cải thiện OCR ViRead cho ${bookTitle}`}
      className="flex flex-col gap-3 rounded-card border border-border bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <Sparkles
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-primary"
          />
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-extrabold text-ink">
                Đóng góp mẫu để cải thiện OCR ViRead
              </h2>
              <span
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-bold ${
                  state.enabled
                    ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                    : "border-slate-300 bg-slate-100 text-slate-700"
                }`}
              >
                {state.enabled ? (
                  <>
                    <CheckCircle2 aria-hidden="true" className="size-3.5" />
                    Đang bật đóng góp (Luồng 2)
                  </>
                ) : (
                  <>
                    <XCircle aria-hidden="true" className="size-3.5" />
                    Đang tắt — không dùng để huấn luyện
                  </>
                )}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted">{state.status_notice}</p>
          </div>
        </div>
      </div>

      {error ? (
        <StatusMessage title="Chưa thể cập nhật" tone="error">
          {error}
        </StatusMessage>
      ) : null}

      {notice ? (
        <StatusMessage title="Đã cập nhật lựa chọn đóng góp" tone="success">
          {notice}
        </StatusMessage>
      ) : null}

      {!state.rights_eligible_for_training && state.rights_ineligible_reason ? (
        <div className="rounded-control border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
          <strong>Lưu ý về căn cứ quyền:</strong>{" "}
          {state.rights_ineligible_reason}
        </div>
      ) : null}

      {state.enabled ? (
        <div className="flex flex-col gap-3 rounded-control border border-emerald-200 bg-emerald-50/60 p-4 text-xs text-emerald-950">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>
              <strong>Phiên bản thông báo:</strong> {state.notice_version}
            </span>
            <span>
              <strong>Phiên bản đồng ý:</strong> #{state.consent_version}
            </span>
            {state.consented_at ? (
              <span>
                <strong>Thời điểm bật:</strong>{" "}
                {new Intl.DateTimeFormat("vi-VN", {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(state.consented_at))}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-3 font-semibold">
            <span>Chờ Admin xác minh: {state.pending_verification_count}</span>
            <span>·</span>
            <span>Chờ đồng bộ Drive: {state.sync_queued_count}</span>
            <span>·</span>
            <span>Đã đồng bộ Flow 2: {state.synced_count}</span>
            {state.rejected_count > 0 ? (
              <>
                <span>·</span>
                <span>Đã loại: {state.rejected_count}</span>
              </>
            ) : null}
          </div>
          <p className="text-emerald-900">
            Sách vẫn giữ nguyên trong danh mục riêng của gia đình bạn. Khi bạn
            bấm <strong>Ngừng đóng góp</strong>, hệ thống dừng tuyển mẫu mới và
            loại mẫu của cuốn sách khỏi các đợt tạo dataset tiếp theo (thao tác
            tắt không tự xóa ảnh hưởng khỏi các checkpoint mô hình đã huấn luyện
            trước đó).
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              className="min-h-10 w-auto px-4 text-xs"
              disabled={disabled || busy}
              onClick={() => void handleDisable()}
              type="button"
              variant="secondary"
            >
              {busy ? "Đang ngừng đóng góp..." : "Ngừng đóng góp"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 rounded-control border border-border bg-surface-subtle p-4 text-xs text-ink">
          <p>
            Khi bạn bật tùy chọn này, ViRead có thể sử dụng{" "}
            <strong>ảnh cắt từng dòng chữ và nhãn tương ứng</strong> từ các
            trang đã qua kiểm tra của cuốn sách này cho bộ huấn luyện{" "}
            <strong>OCR Luồng 2 (Admin Verified)</strong>. Hệ thống không sao
            chép toàn bộ PDF/cuốn sách sang kho huấn luyện và không chia sẻ sách
            của bạn cho gia đình khác.
          </p>
          <label className="flex cursor-pointer items-start gap-2.5 font-semibold text-ink">
            <input
              checked={rightsChecked}
              className="mt-0.5 size-4 rounded border-border accent-primary"
              disabled={disabled || busy}
              onChange={(event) => setRightsChecked(event.target.checked)}
              type="checkbox"
            />
            <span>
              Tôi xác nhận có quyền cho phép ViRead sử dụng ảnh cắt dòng chữ và
              nhãn tương ứng của cuốn sách này cho mục đích huấn luyện OCR Luồng
              2.
            </span>
          </label>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              className="min-h-10 w-auto px-4 text-xs"
              disabled={disabled || busy || !rightsChecked}
              onClick={() => void handleEnable()}
              type="button"
            >
              <ShieldCheck aria-hidden="true" className="size-4" />
              {busy ? "Đang bật đóng góp..." : "Bật đóng góp mẫu OCR"}
            </Button>
            <span className="text-[11px] text-muted">
              Việc không bật hoặc tắt không ảnh hưởng quyền đọc sách hay tiến độ
              của bé.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
