import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KaraokeProcessingStatus } from "@/components/admin/karaoke/karaoke-processing-status";
import { SongMetadataForm } from "@/components/admin/karaoke/song-metadata-form";
import { processingJob } from "@/test/karaoke-processing-fixtures";
import { lineId, songDetail } from "@/test/karaoke-fixtures";
describe("karaoke processing status presentation", () => {
  it("shows a real stage, safe navigation message, progress percentage and no worker-dead claim", () => {
    render(
      <KaraokeProcessingStatus
        job={processingJob({ status: "RUNNING", stage: "ALIGNING_LYRICS" })}
        nowMs={Date.now()}
        queueWarningAfterSeconds={120}
      />,
    );
    expect(
      screen.getByText("Đang căn lời theo giọng hát."),
    ).toBeInTheDocument();
    expect(screen.getByText(/có thể rời trang/)).toBeInTheDocument();
    const progressBar = screen.getByRole("progressbar");
    expect(progressBar).toHaveAttribute("aria-valuemin", "0");
    expect(progressBar).toHaveAttribute("aria-valuemax", "100");
    expect(progressBar).toHaveAttribute("aria-valuenow", "75");
    expect(
      screen.getByTestId("karaoke-processing-progress-pct"),
    ).toHaveTextContent("75%");
    expect(screen.queryByText(/worker đã chết/)).not.toBeInTheDocument();
  });
  it("only warns about queue delay at the capabilities threshold, without automatic actions", () => {
    const job = processingJob();
    const onRetry = vi.fn();
    const base = Date.parse(job.created_at);
    const { rerender } = render(
      <KaraokeProcessingStatus
        job={job}
        nowMs={base + 149000}
        queueWarningAfterSeconds={150}
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByText(/lâu hơn dự kiến/)).not.toBeInTheDocument();
    rerender(
      <KaraokeProcessingStatus
        job={job}
        nowMs={base + 150000}
        queueWarningAfterSeconds={150}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/lâu hơn dự kiến/)).toBeInTheDocument();
    expect(onRetry).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Thử xử lý lại" }),
    ).not.toBeInTheDocument();
  });
  it("keeps staging preview/apply/discard distinct, with explicit actions", () => {
    const onApply = vi.fn();
    const onPreview = vi.fn();
    const onCancel = vi.fn();
    render(
      <KaraokeProcessingStatus
        job={processingJob({ status: "NEEDS_REVIEW", can_apply: true })}
        nowMs={Date.now()}
        queueWarningAfterSeconds={120}
        onApply={onApply}
        onPreview={onPreview}
        onCancel={onCancel}
      />,
    );
    expect(onApply).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Xuất bản" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Nghe kết quả chưa áp dụng" }),
    );
    expect(onPreview).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dùng kết quả" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Bỏ kết quả này" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
  it("requires fresh explicit possible-charge consent, including cancelled jobs", () => {
    const onRetry = vi.fn();
    const job = processingJob({
      status: "CANCELLED",
      retry_policy: "EXPLICIT_COST_ACK",
    });
    const { rerender } = render(
      <KaraokeProcessingStatus
        job={job}
        nowMs={Date.now()}
        queueWarningAfterSeconds={120}
        onRetry={onRetry}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Thử xử lý lại" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /có thể phát sinh thêm phí/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Thử xử lý lại" }));
    expect(onRetry).toHaveBeenCalledWith(true);
    rerender(
      <KaraokeProcessingStatus
        job={{ ...job, id: lineId }}
        nowMs={Date.now()}
        queueWarningAfterSeconds={120}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Thử xử lý lại" }),
    ).toBeDisabled();
  });
  it("suggests fixing mismatched vocals instead of showing a retry loop", () => {
    render(
      <KaraokeProcessingStatus
        job={processingJob({
          status: "FAILED",
          safe_error_code: "NO_USABLE_VOCALS",
          retry_policy: "NEEDS_INPUT_CHANGE",
        })}
        nowMs={Date.now()}
        queueWarningAfterSeconds={120}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("bản có giọng");
    expect(
      screen.queryByRole("button", { name: "Thử xử lý lại" }),
    ).not.toBeInTheDocument();
  });
});
describe("compact metadata form", () => {
  it("keeps the original full form as default and never invents source/rights", () => {
    const value = { ...songDetail().draft!, source_note: "", usage_note: "" };
    const onChange = vi.fn();
    const { container } = render(
      <SongMetadataForm value={value} onChange={onChange} />,
    );
    expect(container.querySelector("details")).toBeNull();
    expect(screen.getByLabelText("Nguồn nhạc và lời")).toHaveValue("");
    expect(screen.getByLabelText("Quyền sử dụng nội dung")).toHaveValue("");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows title first and opens/focuses missing source rather than losing the current values", () => {
    const value = songDetail().draft!;
    const onChange = vi.fn();
    const { container, rerender } = render(
      <SongMetadataForm variant="compact" value={value} onChange={onChange} />,
    );
    expect(container.querySelector("details")).not.toHaveAttribute("open");
    rerender(
      <SongMetadataForm
        variant="compact"
        value={value}
        onChange={onChange}
        errors={{ source_note: "Hãy ghi nguồn trước khi xuất bản" }}
      />,
    );
    const field = screen.getByLabelText(/Nguồn nhạc và lời/);
    expect(container.querySelector("details")).toHaveAttribute("open");
    expect(field).toHaveFocus();
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveValue(value.source_note);
    expect(onChange).not.toHaveBeenCalled();
  });
  it("only changes the chosen metadata field, leaving lyrics and other data with the owner", () => {
    const value = songDetail().draft!;
    const onChange = vi.fn();
    render(
      <SongMetadataForm variant="compact" value={value} onChange={onChange} />,
    );
    fireEvent.change(screen.getByLabelText("Tên bài hát"), {
      target: { value: "Bài mới" },
    });
    expect(onChange).toHaveBeenCalledWith({ ...value, title: "Bài mới" });
  });
});
