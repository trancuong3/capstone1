import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminVireadTrainingScreen } from "@/components/admin/admin-viread-training-screen";
import {
  AdminServicesContext,
  type AdminServices,
} from "@/components/providers/admin-services-provider";
import type { VireadTrainingService } from "@/lib/api/viread-training-service";

const activeModelWithSummary = {
  model_family: "vgg_transformer",
  checkpoint_sha256:
    "a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890a1b2c3d4e5f67890",
  storage_path:
    "ocr-training/checkpoints/flow1-manual/test/checkpoint.manifest.json",
  profile: "FLOW1_EXTERNAL_TRDG",
  decision_id: "11111111-1111-4111-8111-111111111111",
  version_label: "VietOCR-SGK-2026",
  weights_filename: "vietocr_sgk_best.pth",
  config_source: "custom_yaml",
  config_filename: "custom_vgg.yml",
  source: "flow1_manual_upload",
  comparison_summary: {
    models: {
      baseline: "vgg_transformer (Default)",
      finetuned_model_only: "vgg_transformer-v2",
      finetuned_full_pipeline: "DBNet + VietOCR V2 Full Pipeline",
    },
    datasets: [
      {
        key: "real_sgk_test_set",
        label: "Tập sách giáo khoa thực tế (Real SGK Test Set)",
        cer_pct: {
          baseline: 12.4,
          finetuned_model_only: 4.1,
          finetuned_full_pipeline: 3.2,
        },
        wer_pct: {
          baseline: 24.8,
          finetuned_model_only: 9.2,
          finetuned_full_pipeline: 7.5,
        },
        exact_match_pct: {
          baseline: 65.0,
          finetuned_model_only: 88.5,
          finetuned_full_pipeline: 91.2,
        },
        f1_score_pct: {
          baseline: 85.3,
          finetuned_model_only: 96.1,
          finetuned_full_pipeline: 97.4,
        },
        gpu_infer_ms_per_line: {
          baseline: 42.1,
          finetuned_model_only: 41.8,
          finetuned_full_pipeline: 58.6,
        },
      },
    ],
    vietnamese_diacritics_errors: {
      tone_confusion_chars: {
        baseline: 142,
        finetuned: 18,
        reduction_pct: 87.3,
      },
      d_vs_d_stroke_chars: {
        baseline: 56,
        finetuned: 4,
        reduction_pct: 92.8,
      },
    },
    verdict: "IMPROVED",
  },
  updated_at: "2026-11-19T08:00:00.000Z",
};

describe("AdminVireadTrainingScreen - Flow 1 Model Replacement & Reliability Proof", () => {
  let mockVireadTraining: Partial<VireadTrainingService>;

  beforeEach(() => {
    mockVireadTraining = {
      overview: vi.fn().mockResolvedValue({
        outbox: [],
        samples: [],
        jobs: [],
        runs: [],
        benchmarks: [],
        active_model: activeModelWithSummary,
        locked_test: undefined,
      }),
      uploadFlow1ModelChunk: vi.fn().mockResolvedValue({
        upload_id: "test-upload-id",
        chunk_index: 0,
        storage_path: "ocr-training/checkpoints/flow1-manual/test/0000.part",
        sha256: "chunksha256",
        bytes: 1024,
      }),
      activateFlow1Model: vi.fn().mockResolvedValue({
        decision_id: "22222222-2222-4222-8222-222222222222",
        active_model: {
          checkpoint_sha256:
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          storage_path:
            "ocr-training/checkpoints/flow1-manual/new/checkpoint.manifest.json",
          profile: "FLOW1_EXTERNAL_TRDG",
          version_label: "VietOCR-V2-Production-SGK",
          updated_at: "2026-11-19T09:00:00.000Z",
        },
        cleanup: {
          previous_model_existed: true,
          previous_storage_deleted: true,
          deleted_object_count: 3,
          local_cache_deleted: true,
          warning: null,
        },
      }),
      deleteJob: vi.fn(),
      requestEvaluation: vi.fn(),
      retry: vi.fn(),
      discardMismatchedCandidate: vi.fn(),
      closeUnbenchmarkedCandidate: vi.fn(),
      decide: vi.fn(),
    };
  });

  function renderScreen() {
    return render(
      <AdminServicesContext.Provider
        value={
          {
            vireadTraining: mockVireadTraining as VireadTrainingService,
          } as unknown as AdminServices
        }
      >
        <AdminVireadTrainingScreen />
      </AdminServicesContext.Provider>,
    );
  }

  it("renders active model reliability proof table with CER, WER, Exact Match, F1, GPU latency, and diacritics reduction", async () => {
    renderScreen();

    await waitFor(() => {
      expect(screen.getByText("VietOCR-SGK-2026")).toBeInTheDocument();
    });

    // Verification of Reliability Table components
    expect(
      screen.getByText(/Bảng kết quả tin cậy so sánh 2 model/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Tập sách giáo khoa thực tế (Real SGK Test Set)"),
    ).toBeInTheDocument();
    const table = within(screen.getByRole("table"));
    expect(table.getByText(/CER \(%\)/)).toBeInTheDocument();
    expect(table.getByText(/WER \(%\)/)).toBeInTheDocument();
    expect(table.getByText("Exact Match (%)")).toBeInTheDocument();
    expect(table.getByText("F1-Score (%)")).toBeInTheDocument();
    expect(table.getByText("Tốc độ GPU (ms/dòng)")).toBeInTheDocument();

    // Diacritics errors
    expect(screen.getByText(/Lỗi dấu tiếng Việt/i)).toBeInTheDocument();
    expect(screen.getByText("Nhầm thanh điệu")).toBeInTheDocument();
    expect(screen.getByText("Nhầm chữ d / đ")).toBeInTheDocument();
    expect(screen.getByText(/87.3% lỗi dấu/)).toBeInTheDocument();
    expect(screen.getByText(/92.8% lỗi d\/đ/)).toBeInTheDocument();
  });

  it("validates file inputs and executes chunked upload + model activation", async () => {
    renderScreen();

    await waitFor(() => {
      expect(
        screen.getByText(/Thay thế trực tiếp Model VietOCR V2 Fine-Tuned/i),
      ).toBeInTheDocument();
    });

    const user = userEvent.setup();

    // 1. Prepare dummy files
    const validWeights = new File(
      [new Uint8Array([80, 75, 3, 4, 1, 2, 3, 4])],
      "vietocr_weights.pth",
      {
        type: "application/octet-stream",
      },
    );

    const validComparisonJson = JSON.stringify({
      models: {
        baseline: "vgg_transformer",
        finetuned_full_pipeline: "VietOCR-V2-Production-SGK",
      },
      real_sgk_test_set: {
        cer_pct: { baseline: 12.0, finetuned_full_pipeline: 3.5 },
        wer_pct: { baseline: 25.0, finetuned_full_pipeline: 8.0 },
      },
    });
    const comparisonFile = new File([validComparisonJson], "comparison.json", {
      type: "application/json",
    });

    // 2. Select weights file
    const weightsInput = document.getElementById(
      "viread-weights-file",
    ) as HTMLInputElement;
    expect(weightsInput).toBeInTheDocument();
    fireEvent.change(weightsInput, { target: { files: [validWeights] } });

    // 3. Select comparison file
    const comparisonInput = document.getElementById(
      "viread-comparison-file",
    ) as HTMLInputElement;
    expect(comparisonInput).toBeInTheDocument();
    fireEvent.change(comparisonInput, { target: { files: [comparisonFile] } });

    // 4. Check client-side preview indicator
    await waitFor(() => {
      expect(
        screen.getByText(/Độ tin cậy được chứng thực/i),
      ).toBeInTheDocument();
    });

    // 5. Submit model replacement
    const submitBtn = screen.getByRole("button", {
      name: /Tải lên & Thay thế Model/i,
    });
    expect(submitBtn).not.toBeDisabled();
    await user.click(submitBtn);

    // 6. Verify service calls
    await waitFor(() => {
      expect(mockVireadTraining.uploadFlow1ModelChunk).toHaveBeenCalled();
      expect(mockVireadTraining.activateFlow1Model).toHaveBeenCalled();
    });

    // 7. Verify success notice
    await waitFor(() => {
      expect(
        screen.getByText(/Kích hoạt model mới thành công!/i),
      ).toBeInTheDocument();
      expect(screen.getByText("VietOCR-V2-Production-SGK")).toBeInTheDocument();
      expect(
        screen.getByText(
          /Đã xóa an toàn 3 tệp trọng số\/cấu hình của model cũ/i,
        ),
      ).toBeInTheDocument();
    });
  });

  it("rejects invalid weights file extension with clear error", async () => {
    renderScreen();

    await waitFor(() => {
      expect(
        screen.getByText(/Thay thế trực tiếp Model VietOCR V2 Fine-Tuned/i),
      ).toBeInTheDocument();
    });

    const invalidFile = new File(
      [new Uint8Array([1, 2, 3])],
      "malicious_script.exe",
      {
        type: "application/x-msdownload",
      },
    );
    const weightsInput = document.getElementById(
      "viread-weights-file",
    ) as HTMLInputElement;
    fireEvent.change(weightsInput, { target: { files: [invalidFile] } });

    await waitFor(() => {
      expect(
        screen.getByText(
          /Tệp trọng số bắt buộc phải có đuôi \.pth hoặc \.pt\./i,
        ),
      ).toBeInTheDocument();
    });
  });

  it("detects model regression in comparison JSON and warns user immediately", async () => {
    renderScreen();

    await waitFor(() => {
      expect(
        screen.getByText(/Thay thế trực tiếp Model VietOCR V2 Fine-Tuned/i),
      ).toBeInTheDocument();
    });

    // CER of fine-tuned model (15.0) is worse than baseline (12.0)
    const regressedJson = JSON.stringify({
      models: {
        baseline: "vgg_transformer",
        finetuned_model_only: "worse_model",
      },
      real_sgk_test_set: {
        cer_pct: { baseline: 12.0, finetuned_model_only: 15.0 },
        wer_pct: { baseline: 20.0, finetuned_model_only: 6.0 },
      },
    });

    const regressedFile = new File([regressedJson], "bad_comparison.json", {
      type: "application/json",
    });
    const comparisonInput = document.getElementById(
      "viread-comparison-file",
    ) as HTMLInputElement;
    fireEvent.change(comparisonInput, { target: { files: [regressedFile] } });

    await waitFor(() => {
      expect(
        screen.getByText(/Model fine-tuned không vượt trội hơn baseline/i),
      ).toBeInTheDocument();
    });

    const submitBtn = screen.getByRole("button", {
      name: /Tải lên & Thay thế Model/i,
    });
    expect(submitBtn).toBeDisabled();
  });
});
