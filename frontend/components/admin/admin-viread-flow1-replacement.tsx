"use client";

import {
  AlertCircle,
  ArrowUpRight,
  CheckCircle2,
  FileCheck2,
  FileCode2,
  UploadCloud,
} from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { ResponsiveTable } from "@/components/common/responsive-table";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import type { VireadTrainingOverview } from "@/lib/api/viread-training-service";

function shortHash(value: string) {
  if (value.length <= 16) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface DatasetComparison {
  key: string;
  label: string;
  cer_pct: {
    baseline?: number;
    finetuned_model_only?: number;
    finetuned_full_pipeline?: number;
    finetuned?: number;
  };
  wer_pct: {
    baseline?: number;
    finetuned_model_only?: number;
    finetuned_full_pipeline?: number;
    finetuned?: number;
  };
  exact_match_pct?: {
    baseline?: number;
    finetuned_model_only?: number;
    finetuned_full_pipeline?: number;
    finetuned?: number;
  };
  f1_score_pct?: {
    baseline?: number;
    finetuned_model_only?: number;
    finetuned_full_pipeline?: number;
    finetuned?: number;
  };
  gpu_infer_ms_per_line?: {
    baseline?: number;
    finetuned_model_only?: number;
    finetuned_full_pipeline?: number;
    finetuned?: number;
  };
}

interface DiacriticsErrorItem {
  baseline?: number;
  finetuned?: number;
  reduction_pct?: number;
}

interface DiacriticsErrors {
  tone_confusion_chars?: DiacriticsErrorItem;
  d_vs_d_stroke_chars?: DiacriticsErrorItem;
}

interface ComparisonSummary {
  models?: {
    baseline?: string;
    finetuned_model_only?: string;
    finetuned_full_pipeline?: string;
  };
  datasets?: DatasetComparison[];
  vietnamese_diacritics_errors?: DiacriticsErrors;
  verdict?: string;
}

export function AdminVireadReliabilityPanel({
  activeModel,
}: {
  activeModel: NonNullable<VireadTrainingOverview["active_model"]>;
}) {
  const summary = activeModel.comparison_summary as ComparisonSummary | null;
  if (!summary || !summary.datasets || summary.datasets.length === 0) {
    return null;
  }

  const models = summary.models || {};
  const diacritics = summary.vietnamese_diacritics_errors;

  return (
    <Card className="mb-6 border-primary/30 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-black text-emerald-800">
              <CheckCircle2 className="size-3.5" /> Model Fine-Tuned Đang Hoạt
              Động
            </span>
            <span className="rounded-control bg-sky px-2 py-0.5 font-mono text-xs font-bold text-primary-hover">
              {activeModel.profile}
            </span>
          </div>
          <h2 className="mt-2 text-2xl font-black">
            {activeModel.version_label ||
              models.finetuned_full_pipeline ||
              models.finetuned_model_only ||
              "VietOCR V2 Fine-Tuned"}
          </h2>
          <p className="mt-1 text-sm text-muted">
            Trọng số:{" "}
            <span className="font-semibold text-ink">
              {activeModel.weights_filename || "Trọng số tải lên thủ công"}
            </span>{" "}
            · SHA-256:{" "}
            <span className="font-mono text-xs">
              {shortHash(activeModel.checkpoint_sha256)}
            </span>
          </p>
        </div>
        <div className="text-right text-xs text-muted">
          <p className="font-semibold text-ink">
            {activeModel.config_source === "custom_yaml"
              ? `Config YAML tùy chỉnh: ${activeModel.config_filename || "config.yml"}`
              : "Config mặc định: vgg_transformer"}
          </p>
          <p className="mt-1">
            Cập nhật: {new Date(activeModel.updated_at).toLocaleString("vi-VN")}
          </p>
        </div>
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-lg font-black text-ink">
            Bảng kết quả tin cậy so sánh 2 model (Baseline vs Fine-tuned)
          </h3>
          <span className="text-xs font-bold text-emerald-700">
            ✓ Đạt chuẩn cải thiện độc lập (Reliability Gate Passed)
          </span>
        </div>

        <div className="space-y-6">
          {summary.datasets.map((dataset) => {
            const bCer = dataset.cer_pct?.baseline;
            const mCer =
              dataset.cer_pct?.finetuned_model_only ??
              dataset.cer_pct?.finetuned;
            const pCer = dataset.cer_pct?.finetuned_full_pipeline;
            const bestCer = pCer ?? mCer;
            const cerGain =
              bCer !== undefined && bestCer !== undefined
                ? (bCer - bestCer).toFixed(2)
                : null;

            const bWer = dataset.wer_pct?.baseline;
            const mWer =
              dataset.wer_pct?.finetuned_model_only ??
              dataset.wer_pct?.finetuned;
            const pWer = dataset.wer_pct?.finetuned_full_pipeline;
            const bestWer = pWer ?? mWer;
            const werGain =
              bWer !== undefined && bestWer !== undefined
                ? (bWer - bestWer).toFixed(2)
                : null;

            const bExact = dataset.exact_match_pct?.baseline;
            const mExact =
              dataset.exact_match_pct?.finetuned_model_only ??
              dataset.exact_match_pct?.finetuned;
            const pExact = dataset.exact_match_pct?.finetuned_full_pipeline;

            const bF1 = dataset.f1_score_pct?.baseline;
            const mF1 =
              dataset.f1_score_pct?.finetuned_model_only ??
              dataset.f1_score_pct?.finetuned;
            const pF1 = dataset.f1_score_pct?.finetuned_full_pipeline;

            const bGpu = dataset.gpu_infer_ms_per_line?.baseline;
            const mGpu =
              dataset.gpu_infer_ms_per_line?.finetuned_model_only ??
              dataset.gpu_infer_ms_per_line?.finetuned;
            const pGpu = dataset.gpu_infer_ms_per_line?.finetuned_full_pipeline;

            const mobileRows: Array<{
              label: string;
              baseline: string;
              modelOnly: string;
              fullPipeline: string;
              gain: string;
              highlightGain?: boolean;
            }> = [
              {
                label: "CER (%) · càng thấp càng tốt",
                baseline: bCer !== undefined ? `${bCer}%` : "—",
                modelOnly: mCer !== undefined ? `${mCer}%` : "—",
                fullPipeline: pCer !== undefined ? `${pCer}%` : "—",
                gain: cerGain ? `-${cerGain}%` : "—",
                highlightGain: true,
              },
              {
                label: "WER (%) · càng thấp càng tốt",
                baseline: bWer !== undefined ? `${bWer}%` : "—",
                modelOnly: mWer !== undefined ? `${mWer}%` : "—",
                fullPipeline: pWer !== undefined ? `${pWer}%` : "—",
                gain: werGain ? `-${werGain}%` : "—",
                highlightGain: true,
              },
            ];
            if (
              bExact !== undefined ||
              mExact !== undefined ||
              pExact !== undefined
            ) {
              mobileRows.push({
                label: "Exact Match (%)",
                baseline: bExact !== undefined ? `${bExact}%` : "—",
                modelOnly: mExact !== undefined ? `${mExact}%` : "—",
                fullPipeline: pExact !== undefined ? `${pExact}%` : "—",
                gain:
                  bExact !== undefined && (pExact ?? mExact) !== undefined
                    ? `+${((pExact ?? mExact)! - bExact).toFixed(2)}%`
                    : "—",
                highlightGain: true,
              });
            }
            if (bF1 !== undefined || mF1 !== undefined || pF1 !== undefined) {
              mobileRows.push({
                label: "F1-Score (%)",
                baseline: bF1 !== undefined ? `${bF1}%` : "—",
                modelOnly: mF1 !== undefined ? `${mF1}%` : "—",
                fullPipeline: pF1 !== undefined ? `${pF1}%` : "—",
                gain:
                  bF1 !== undefined && (pF1 ?? mF1) !== undefined
                    ? `+${((pF1 ?? mF1)! - bF1).toFixed(2)}%`
                    : "—",
                highlightGain: true,
              });
            }
            if (
              bGpu !== undefined ||
              mGpu !== undefined ||
              pGpu !== undefined
            ) {
              mobileRows.push({
                label: "Tốc độ GPU (ms/dòng)",
                baseline: bGpu !== undefined ? `${bGpu} ms` : "—",
                modelOnly: mGpu !== undefined ? `${mGpu} ms` : "—",
                fullPipeline: pGpu !== undefined ? `${pGpu} ms` : "—",
                gain: `${pGpu ?? mGpu ?? bGpu} ms/dòng`,
                highlightGain: false,
              });
            }

            return (
              <div key={dataset.key}>
                <div className="space-y-2.5 md:hidden">
                  <div className="rounded-control bg-sky/50 px-3.5 py-2 text-sm font-extrabold text-primary-hover">
                    {dataset.label}
                  </div>
                  {mobileRows.map((row) => (
                    <article
                      className="rounded-card border border-border bg-white p-3.5"
                      key={row.label}
                    >
                      <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
                        <p className="text-sm font-bold text-ink">
                          {row.label}
                        </p>
                        <span
                          className={
                            row.highlightGain
                              ? "font-mono text-sm font-extrabold text-emerald-700"
                              : "font-mono text-xs text-muted"
                          }
                        >
                          {row.gain}
                        </span>
                      </div>
                      <dl className="mt-2.5 grid grid-cols-3 gap-2 text-xs">
                        <div className="rounded-control bg-canvas px-2.5 py-2">
                          <dt className="text-muted">Baseline</dt>
                          <dd className="mt-0.5 font-mono font-semibold text-muted">
                            {row.baseline}
                          </dd>
                        </div>
                        <div className="rounded-control bg-canvas px-2.5 py-2">
                          <dt className="text-muted">Model Only</dt>
                          <dd className="mt-0.5 font-mono font-semibold text-ink">
                            {row.modelOnly}
                          </dd>
                        </div>
                        <div className="rounded-control bg-sky/30 px-2.5 py-2">
                          <dt className="text-muted">Full Pipe</dt>
                          <dd className="mt-0.5 font-mono font-bold text-ink">
                            {row.fullPipeline}
                          </dd>
                        </div>
                      </dl>
                    </article>
                  ))}
                </div>

                <div className="hidden md:block">
                  <ResponsiveTable
                    ariaLabel={`Bảng kết quả tin cậy ${dataset.label}`}
                    className="rounded-control"
                  >
                    <div className="bg-sky/50 px-4 py-2 font-extrabold text-primary-hover">
                      {dataset.label}
                    </div>
                    <table className="w-full min-w-[640px] text-left text-sm">
                      <thead className="border-b border-border bg-slate-50 text-xs font-bold text-muted">
                        <tr>
                          <th className="px-4 py-2.5">Chỉ số đánh giá</th>
                          <th className="px-4 py-2.5">
                            Baseline ({models.baseline || "Gốc"})
                          </th>
                          <th className="px-4 py-2.5">
                            Fine-tuned (Model Only)
                          </th>
                          <th className="px-4 py-2.5">
                            Fine-tuned (Full Pipeline)
                          </th>
                          <th className="px-4 py-2.5 text-right">
                            Mức cải thiện (Gain)
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        <tr className="hover:bg-sky/10">
                          <td className="px-4 py-2.5 font-bold text-ink">
                            CER (%){" "}
                            <span className="text-xs font-normal text-muted">
                              (Càng thấp càng tốt)
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-muted">
                            {bCer !== undefined ? `${bCer}%` : "—"}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                            {mCer !== undefined ? `${mCer}%` : "—"}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                            {pCer !== undefined ? `${pCer}%` : "—"}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono font-extrabold text-emerald-700">
                            {cerGain ? `-${cerGain}%` : "—"}
                          </td>
                        </tr>
                        <tr className="hover:bg-sky/10">
                          <td className="px-4 py-2.5 font-bold text-ink">
                            WER (%){" "}
                            <span className="text-xs font-normal text-muted">
                              (Càng thấp càng tốt)
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-muted">
                            {bWer !== undefined ? `${bWer}%` : "—"}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                            {mWer !== undefined ? `${mWer}%` : "—"}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                            {pWer !== undefined ? `${pWer}%` : "—"}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono font-extrabold text-emerald-700">
                            {werGain ? `-${werGain}%` : "—"}
                          </td>
                        </tr>
                        {bExact !== undefined ||
                        mExact !== undefined ||
                        pExact !== undefined ? (
                          <tr className="hover:bg-sky/10">
                            <td className="px-4 py-2.5 font-bold text-ink">
                              Exact Match (%)
                            </td>
                            <td className="px-4 py-2.5 font-mono text-muted">
                              {bExact !== undefined ? `${bExact}%` : "—"}
                            </td>
                            <td className="px-4 py-2.5 font-mono">
                              {mExact !== undefined ? `${mExact}%` : "—"}
                            </td>
                            <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                              {pExact !== undefined ? `${pExact}%` : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono font-bold text-emerald-700">
                              {bExact !== undefined &&
                              (pExact ?? mExact) !== undefined
                                ? `+${((pExact ?? mExact)! - bExact).toFixed(2)}%`
                                : "—"}
                            </td>
                          </tr>
                        ) : null}
                        {bF1 !== undefined ||
                        mF1 !== undefined ||
                        pF1 !== undefined ? (
                          <tr className="hover:bg-sky/10">
                            <td className="px-4 py-2.5 font-bold text-ink">
                              F1-Score (%)
                            </td>
                            <td className="px-4 py-2.5 font-mono text-muted">
                              {bF1 !== undefined ? `${bF1}%` : "—"}
                            </td>
                            <td className="px-4 py-2.5 font-mono">
                              {mF1 !== undefined ? `${mF1}%` : "—"}
                            </td>
                            <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                              {pF1 !== undefined ? `${pF1}%` : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono font-bold text-emerald-700">
                              {bF1 !== undefined &&
                              (pF1 ?? mF1) !== undefined
                                ? `+${((pF1 ?? mF1)! - bF1).toFixed(2)}%`
                                : "—"}
                            </td>
                          </tr>
                        ) : null}
                        {bGpu !== undefined ||
                        mGpu !== undefined ||
                        pGpu !== undefined ? (
                          <tr className="hover:bg-sky/10">
                            <td className="px-4 py-2.5 font-bold text-ink">
                              Tốc độ GPU (ms/dòng)
                            </td>
                            <td className="px-4 py-2.5 font-mono text-muted">
                              {bGpu !== undefined ? `${bGpu} ms` : "—"}
                            </td>
                            <td className="px-4 py-2.5 font-mono">
                              {mGpu !== undefined ? `${mGpu} ms` : "—"}
                            </td>
                            <td className="px-4 py-2.5 font-mono">
                              {pGpu !== undefined ? `${pGpu} ms` : "—"}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono text-muted">
                              {pGpu ?? mGpu ?? bGpu} ms/dòng
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </ResponsiveTable>
                </div>
              </div>
            );
          })}

          {diacritics ? (
            <div className="rounded-control border border-border bg-amber-50/40 p-4">
              <h4 className="font-extrabold text-ink">
                Lỗi dấu tiếng Việt (Vietnamese Diacritics Reliability)
              </h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {diacritics.tone_confusion_chars ? (
                  <div className="rounded-control bg-white p-3 border border-border">
                    <p className="text-xs font-bold text-muted">
                      Nhầm thanh điệu
                    </p>
                    <p className="mt-1 font-mono text-sm">
                      <span className="text-muted line-through">
                        {diacritics.tone_confusion_chars.baseline ?? "—"} ký tự
                      </span>{" "}
                      →{" "}
                      <span className="font-extrabold text-emerald-700">
                        {diacritics.tone_confusion_chars.finetuned ?? "—"} ký tự
                      </span>
                    </p>
                    {diacritics.tone_confusion_chars.reduction_pct ? (
                      <span className="mt-1 inline-block text-xs font-bold text-emerald-700">
                        ↓ Giảm {diacritics.tone_confusion_chars.reduction_pct}%
                        lỗi dấu
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {diacritics.d_vs_d_stroke_chars ? (
                  <div className="rounded-control bg-white p-3 border border-border">
                    <p className="text-xs font-bold text-muted">
                      Nhầm chữ d / đ
                    </p>
                    <p className="mt-1 font-mono text-sm">
                      <span className="text-muted line-through">
                        {diacritics.d_vs_d_stroke_chars.baseline ?? "—"} ký tự
                      </span>{" "}
                      →{" "}
                      <span className="font-extrabold text-emerald-700">
                        {diacritics.d_vs_d_stroke_chars.finetuned ?? "—"} ký tự
                      </span>
                    </p>
                    {diacritics.d_vs_d_stroke_chars.reduction_pct ? (
                      <span className="mt-1 inline-block text-xs font-bold text-emerald-700">
                        ↓ Giảm {diacritics.d_vs_d_stroke_chars.reduction_pct}%
                        lỗi d/đ
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function AdminVireadFlow1Replacement({
  onSuccess,
}: {
  onSuccess: () => Promise<void> | void;
}) {
  const { vireadTraining } = useAdminServices();
  const [weightsFile, setWeightsFile] = useState<File | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);
  const [comparisonFile, setComparisonFile] = useState<File | null>(null);
  const [modelVersion, setModelVersion] = useState("");
  const reason =
    "Trực tiếp thay thế model VietOCR V2 fine-tuned đạt độ tin cậy vượt trội.";

  const [uploading, setUploading] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressStatus, setProgressStatus] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const [previewMetrics, setPreviewMetrics] = useState<{
    isValid: boolean;
    errorMsg?: string;
    sgkCerImprovement?: string;
    sgkWerImprovement?: string;
  } | null>(null);

  const [successNotice, setSuccessNotice] = useState<{
    versionLabel: string;
    previousModelExisted: boolean;
    deletedCount: number;
  } | null>(null);

  // Validate weights file extension
  const handleWeightsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setFormError(null);
    if (!file) {
      setWeightsFile(null);
      return;
    }
    const name = file.name.toLowerCase();
    if (!name.endsWith(".pth") && !name.endsWith(".pt")) {
      setFormError("Tệp trọng số bắt buộc phải có đuôi .pth hoặc .pt.");
      setWeightsFile(null);
      return;
    }
    setWeightsFile(file);
    if (!modelVersion) {
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      setModelVersion(baseName);
    }
  };

  // Validate YAML config file extension
  const handleConfigChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setFormError(null);
    if (!file) {
      setConfigFile(null);
      return;
    }
    const name = file.name.toLowerCase();
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) {
      setFormError(
        "Tệp cấu hình tùy chọn bắt buộc phải có đuôi .yml hoặc .yaml.",
      );
      setConfigFile(null);
      return;
    }
    setConfigFile(file);
  };

  // Client-side preview and verification of comparison JSON
  const handleComparisonChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0] || null;
    setFormError(null);
    setPreviewMetrics(null);
    if (!file) {
      setComparisonFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith(".json")) {
      setFormError("Tệp kết quả so sánh bắt buộc phải có đuôi .json.");
      setComparisonFile(null);
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      if (!parsed || typeof parsed !== "object") {
        setPreviewMetrics({
          isValid: false,
          errorMsg: "Tệp JSON không đúng định dạng đối tượng.",
        });
        setComparisonFile(null);
        return;
      }

      if (!parsed.models || typeof parsed.models !== "object") {
        setPreviewMetrics({
          isValid: false,
          errorMsg: "Tệp JSON thiếu mục khai báo 'models'.",
        });
        setComparisonFile(null);
        return;
      }

      // Check datasets
      let foundValidDataset = false;
      let hasRegression = false;
      let sgkCerGain = "";
      let sgkWerGain = "";

      for (const [key, val] of Object.entries(parsed)) {
        if (
          [
            "models",
            "vietnamese_diacritics_errors",
            "metadata",
            "summary",
          ].includes(key)
        ) {
          continue;
        }
        if (
          val &&
          typeof val === "object" &&
          "cer_pct" in val &&
          "wer_pct" in val
        ) {
          foundValidDataset = true;
          const block = val as {
            cer_pct: Record<string, number>;
            wer_pct: Record<string, number>;
          };
          const bCer = block.cer_pct?.baseline;
          const bWer = block.wer_pct?.baseline;
          const candCer =
            block.cer_pct?.finetuned_full_pipeline ??
            block.cer_pct?.finetuned_model_only ??
            block.cer_pct?.finetuned;
          const candWer =
            block.wer_pct?.finetuned_full_pipeline ??
            block.wer_pct?.finetuned_model_only ??
            block.wer_pct?.finetuned;

          if (bCer !== undefined && candCer !== undefined && candCer >= bCer) {
            hasRegression = true;
          }
          if (bWer !== undefined && candWer !== undefined && candWer >= bWer) {
            hasRegression = true;
          }

          if (key.includes("sgk") || key.includes("real")) {
            if (bCer !== undefined && candCer !== undefined) {
              sgkCerGain = `${bCer}% → ${candCer}% (↓ ${(bCer - candCer).toFixed(1)}%)`;
            }
            if (bWer !== undefined && candWer !== undefined) {
              sgkWerGain = `${bWer}% → ${candWer}% (↓ ${(bWer - candWer).toFixed(1)}%)`;
            }
          }
        }
      }

      if (!foundValidDataset) {
        setPreviewMetrics({
          isValid: false,
          errorMsg: "Tệp JSON thiếu dữ liệu tập kiểm thử (cer_pct / wer_pct).",
        });
        setComparisonFile(null);
        return;
      }

      if (hasRegression) {
        setPreviewMetrics({
          isValid: false,
          errorMsg:
            "Model fine-tuned không vượt trội hơn baseline (chỉ số CER hoặc WER bị giảm sút trên tập kiểm thử).",
        });
        setComparisonFile(null);
        return;
      }

      setComparisonFile(file);
      setPreviewMetrics({
        isValid: true,
        sgkCerImprovement: sgkCerGain,
        sgkWerImprovement: sgkWerGain,
      });

      if (parsed.models.finetuned_full_pipeline) {
        setModelVersion(parsed.models.finetuned_full_pipeline);
      } else if (parsed.models.finetuned_model_only) {
        setModelVersion(parsed.models.finetuned_model_only);
      }
    } catch {
      setPreviewMetrics({
        isValid: false,
        errorMsg: "Không thể đọc hoặc parse tệp JSON kết quả so sánh.",
      });
      setComparisonFile(null);
    }
  };

  const handleUploadAndReplace = useCallback(async () => {
    if (!vireadTraining || !weightsFile || !comparisonFile || uploading) {
      return;
    }
    setUploading(true);
    setFormError(null);
    setSuccessNotice(null);
    setProgressPercent(0);
    setProgressStatus("Đang chuẩn bị các mảnh trọng số (20 MiB/mảnh)...");

    const CHUNK_SIZE = 20 * 1024 * 1024;
    const totalChunks = Math.max(1, Math.ceil(weightsFile.size / CHUNK_SIZE));
    const uploadId = crypto.randomUUID();
    const uploadedChunks: Array<{
      index: number;
      path: string;
      sha256: string;
      bytes: number;
    }> = [];

    try {
      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(weightsFile.size, start + CHUNK_SIZE);
        const chunkBlob = weightsFile.slice(start, end);

        const uploadPct = Math.round(((i + 1) / totalChunks) * 85);
        setProgressPercent(uploadPct);
        setProgressStatus(
          `Đang tải mảnh ${i + 1}/${totalChunks} (${formatBytes(chunkBlob.size)})...`,
        );

        const res = await vireadTraining.uploadFlow1ModelChunk(
          uploadId,
          i,
          chunkBlob,
        );
        uploadedChunks.push({
          index: i,
          path: res.storage_path,
          sha256: res.sha256,
          bytes: res.bytes,
        });
      }

      setProgressPercent(90);
      setProgressStatus("Đang kiểm tra toàn vẹn SHA-256 & kích hoạt model...");

      const activationRes = await vireadTraining.activateFlow1Model({
        uploadId,
        weightsFilename: weightsFile.name,
        chunks: uploadedChunks,
        comparisonFile,
        configFile,
        modelVersion: modelVersion.trim() || undefined,
        reason: reason.trim() || undefined,
      });

      setProgressPercent(100);
      setProgressStatus("Kích hoạt thành công!");
      setSuccessNotice({
        versionLabel:
          activationRes.active_model.version_label || weightsFile.name,
        previousModelExisted: activationRes.cleanup.previous_model_existed,
        deletedCount: activationRes.cleanup.deleted_object_count,
      });

      // Clear file inputs
      setWeightsFile(null);
      setConfigFile(null);
      setComparisonFile(null);
      setPreviewMetrics(null);

      await onSuccess();
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Có lỗi xảy ra khi thay thế model.";
      setFormError(msg);
    } finally {
      setUploading(false);
    }
  }, [
    vireadTraining,
    weightsFile,
    comparisonFile,
    configFile,
    modelVersion,
    reason,
    uploading,
    onSuccess,
  ]);

  return (
    <div className="rounded-control border-2 border-primary/20 bg-gradient-to-b from-sky/20 to-white p-5">
      <div className="flex items-center justify-between gap-2 border-b border-border/80 pb-3">
        <div>
          <span className="inline-block rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-black text-primary-hover">
            Luồng 1 Mới · Direct Model Replacement
          </span>
          <h3 className="mt-1 text-lg font-black text-ink">
            Thay thế trực tiếp Model VietOCR V2 Fine-Tuned
          </h3>
        </div>
        <UploadCloud className="size-6 text-primary" />
      </div>

      <p className="mt-2 text-sm text-muted">
        Tải lên trọng số PyTorch fine-tuned, file cấu hình YAML (tùy chọn) và
        kết quả so sánh JSON để kích hoạt trực tiếp model nhận diện sách giáo
        khoa.
      </p>

      {successNotice ? (
        <div className="mt-4 rounded-control bg-emerald-50 border border-emerald-200 p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="size-5 text-emerald-700 shrink-0 mt-0.5" />
            <div>
              <p className="font-extrabold text-emerald-900">
                Kích hoạt model mới thành công!
              </p>
              <p className="mt-1 text-sm text-emerald-800">
                Phiên bản đang hoạt động:{" "}
                <span className="font-bold">{successNotice.versionLabel}</span>.
              </p>
              <p className="mt-1 text-xs text-emerald-700">
                {successNotice.previousModelExisted
                  ? `Đã xóa an toàn ${successNotice.deletedCount} tệp trọng số/cấu hình của model cũ trong Storage để tối ưu dung lượng.`
                  : "Model gốc (Original baseline) được lưu giữ an toàn làm phương án rollback."}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {formError ? (
        <div className="mt-4">
          <StatusMessage tone="error">{formError}</StatusMessage>
        </div>
      ) : null}

      <div className="mt-4 space-y-4">
        {/* 1. Weights file input */}
        <div>
          <label
            className="block text-sm font-bold text-ink"
            htmlFor="viread-weights-file"
          >
            1. Tệp trọng số PyTorch (.pth, .pt){" "}
            <span className="text-danger">*</span>
          </label>
          <div className="mt-1.5 flex items-center gap-3">
            <input
              accept=".pth,.pt"
              className="block w-full text-sm text-muted file:mr-4 file:rounded-control file:border-0 file:bg-sky file:px-4 file:py-2.5 file:text-sm file:font-bold file:text-primary-hover hover:file:bg-border focus-visible:outline-none"
              disabled={uploading}
              id="viread-weights-file"
              onChange={handleWeightsChange}
              type="file"
            />
          </div>
          {weightsFile ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
              <FileCheck2 className="size-3.5" />
              Đã chọn: {weightsFile.name} ({formatBytes(weightsFile.size)})
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted">
              Hệ thống tự động cắt nhỏ 20 MiB/mảnh để tải lên ổn định không
              nghẽn mạng.
            </p>
          )}
        </div>

        {/* 2. Config file input */}
        <div>
          <label
            className="block text-sm font-bold text-ink"
            htmlFor="viread-config-file"
          >
            2. Tệp cấu hình YAML (.yml, .yaml){" "}
            <span className="text-xs font-normal text-muted">
              (Không bắt buộc)
            </span>
          </label>
          <div className="mt-1.5 flex items-center gap-3">
            <input
              accept=".yml,.yaml"
              className="block w-full text-sm text-muted file:mr-4 file:rounded-control file:border-0 file:bg-slate-100 file:px-4 file:py-2.5 file:text-sm file:font-bold file:text-ink hover:file:bg-slate-200 focus-visible:outline-none"
              disabled={uploading}
              id="viread-config-file"
              onChange={handleConfigChange}
              type="file"
            />
          </div>
          {configFile ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-ink">
              <FileCode2 className="size-3.5" />
              Đã chọn: {configFile.name} ({formatBytes(configFile.size)})
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted">
              Không bắt buộc — hệ thống sẽ dùng cấu hình chuẩn{" "}
              <code className="font-mono text-ink">vgg_transformer</code> nếu để
              trống.
            </p>
          )}
        </div>

        {/* 3. Comparison JSON file input */}
        <div>
          <label
            className="block text-sm font-bold text-ink"
            htmlFor="viread-comparison-file"
          >
            3. Tệp JSON kết quả so sánh đối chứng (.json){" "}
            <span className="text-danger">*</span>
          </label>
          <div className="mt-1.5 flex items-center gap-3">
            <input
              accept=".json"
              className="block w-full text-sm text-muted file:mr-4 file:rounded-control file:border-0 file:bg-sky file:px-4 file:py-2.5 file:text-sm file:font-bold file:text-primary-hover hover:file:bg-border focus-visible:outline-none"
              disabled={uploading}
              id="viread-comparison-file"
              onChange={(e) => void handleComparisonChange(e)}
              type="file"
            />
          </div>
          {previewMetrics ? (
            <div className="mt-2">
              {previewMetrics.isValid ? (
                <div className="rounded-control bg-emerald-50 border border-emerald-200 p-2.5 text-xs text-emerald-800">
                  <p className="font-bold flex items-center gap-1">
                    <CheckCircle2 className="size-3.5 text-emerald-600" />
                    Độ tin cậy được chứng thực:
                  </p>
                  {previewMetrics.sgkCerImprovement ? (
                    <p className="mt-0.5">
                      • CER SGK: {previewMetrics.sgkCerImprovement}
                    </p>
                  ) : null}
                  {previewMetrics.sgkWerImprovement ? (
                    <p className="mt-0.5">
                      • WER SGK: {previewMetrics.sgkWerImprovement}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-control bg-rose-50 border border-rose-200 p-2.5 text-xs text-rose-800">
                  <p className="font-bold flex items-center gap-1">
                    <AlertCircle className="size-3.5 text-rose-600" />
                    Không đạt tiêu chuẩn tin cậy:
                  </p>
                  <p className="mt-0.5">{previewMetrics.errorMsg}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted">
              File JSON chứa số liệu so sánh Baseline vs Fine-tuned (CER, WER,
              F1...).
            </p>
          )}
        </div>

        {/* 4. Model version name */}
        <div>
          <label
            className="block text-sm font-bold text-ink"
            htmlFor="viread-model-version"
          >
            4. Tên phiên bản model{" "}
            <span className="text-xs font-normal text-muted">(Tùy chọn)</span>
          </label>
          <input
            className="mt-1.5 w-full rounded-control border border-border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-primary"
            disabled={uploading}
            id="viread-model-version"
            maxLength={120}
            onChange={(e) => setModelVersion(e.target.value)}
            placeholder="vd: VietOCR V2 - SGK Fine-Tuned 2026"
            value={modelVersion}
          />
        </div>

        {/* 5. Progress bar & Submit button */}
        {uploading ? (
          <div className="rounded-control border border-primary/30 bg-white p-4">
            <div className="flex justify-between text-xs font-bold text-primary-hover">
              <span>{progressStatus}</span>
              <span>{progressPercent}%</span>
            </div>
            <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-sky">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        ) : null}

        <Button
          className="mt-2"
          disabled={
            !weightsFile ||
            !comparisonFile ||
            uploading ||
            Boolean(previewMetrics && !previewMetrics.isValid)
          }
          onClick={() => void handleUploadAndReplace()}
          variant="primary"
        >
          <ArrowUpRight className="size-5" />
          {uploading ? "Đang xử lý..." : "Tải lên & Thay thế Model"}
        </Button>
      </div>
    </div>
  );
}
