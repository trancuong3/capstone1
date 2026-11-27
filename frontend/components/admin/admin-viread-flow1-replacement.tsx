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
import { useI18n, useTranslations } from "@/hooks/use-i18n";
import type { TranslateFn } from "@/lib/i18n/types";
import type { VireadTrainingOverview } from "@/lib/api/viread-training-service";

function shortHash(value: string) {
  if (value.length <= 16) return value;
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function formatBytes(
  bytes: number,
  t: TranslateFn,
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string,
) {
  if (bytes < 1024) {
    return t("training.flow1.bytesUnitB", { value: formatNumber(bytes) });
  }
  if (bytes < 1024 * 1024) {
    return t("training.flow1.bytesUnitKB", {
      value: formatNumber(bytes / 1024, {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      }),
    });
  }
  return t("training.flow1.bytesUnitMB", {
    value: formatNumber(bytes / (1024 * 1024), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }),
  });
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
  const t = useTranslations("admin");
  const { formatDateTime, formatNumber } = useI18n();
  const summary = activeModel.comparison_summary as ComparisonSummary | null;
  if (!summary || !summary.datasets || summary.datasets.length === 0) {
    return null;
  }

  const models = summary.models || {};
  const diacritics = summary.vietnamese_diacritics_errors;
  const dash = t("common.emptyDash");

  return (
    <Card className="mb-6 border-primary/30 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-black text-emerald-800">
              <CheckCircle2 className="size-3.5" />{" "}
              {t("training.flow1.activeBadge")}
            </span>
            <span className="rounded-control bg-sky px-2 py-0.5 font-mono text-xs font-bold text-primary-hover">
              {activeModel.profile}
            </span>
          </div>
          <h2 className="mt-2 text-2xl font-black">
            {activeModel.version_label ||
              models.finetuned_full_pipeline ||
              models.finetuned_model_only ||
              t("training.flow1.modelTitleFallback")}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {t("training.flow1.weightsLine")}{" "}
            <span className="font-semibold text-ink">
              {activeModel.weights_filename ||
                t("training.flow1.manualWeightsFallback")}
            </span>{" "}
            · SHA-256:{" "}
            <span className="font-mono text-xs">
              {shortHash(activeModel.checkpoint_sha256)}
            </span>
          </p>
        </div>
        <div className="text-end text-xs text-muted">
          <p className="font-semibold text-ink">
            {activeModel.config_source === "custom_yaml"
              ? t("training.flow1.customYaml", {
                  filename:
                    activeModel.config_filename ||
                    t("training.flow1.configFallbackFilename"),
                })
              : t("training.flow1.defaultYaml")}
          </p>
          <p className="mt-1">
            {t("training.flow1.updatedAt", {
              time: formatDateTime(activeModel.updated_at),
            })}
          </p>
        </div>
      </div>

      <div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-black text-ink">
            {t("training.flow1.benchmarkPanelHeading")}
          </h3>
          <span className="text-xs font-bold text-emerald-700">
            {t("training.flow1.reliabilityPassed")}
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
                label: t("training.flow1.cerMobileRow"),
                baseline: bCer !== undefined ? `${bCer}%` : dash,
                modelOnly: mCer !== undefined ? `${mCer}%` : dash,
                fullPipeline: pCer !== undefined ? `${pCer}%` : dash,
                gain: cerGain ? `-${cerGain}%` : dash,
                highlightGain: true,
              },
              {
                label: t("training.flow1.werMobileRow"),
                baseline: bWer !== undefined ? `${bWer}%` : dash,
                modelOnly: mWer !== undefined ? `${mWer}%` : dash,
                fullPipeline: pWer !== undefined ? `${pWer}%` : dash,
                gain: werGain ? `-${werGain}%` : dash,
                highlightGain: true,
              },
            ];
            if (
              bExact !== undefined ||
              mExact !== undefined ||
              pExact !== undefined
            ) {
              mobileRows.push({
                label: t("training.flow1.exactMatchMobileRow"),
                baseline: bExact !== undefined ? `${bExact}%` : dash,
                modelOnly: mExact !== undefined ? `${mExact}%` : dash,
                fullPipeline: pExact !== undefined ? `${pExact}%` : dash,
                gain:
                  bExact !== undefined && (pExact ?? mExact) !== undefined
                    ? `+${((pExact ?? mExact)! - bExact).toFixed(2)}%`
                    : dash,
                highlightGain: true,
              });
            }
            if (bF1 !== undefined || mF1 !== undefined || pF1 !== undefined) {
              mobileRows.push({
                label: t("training.flow1.f1MobileRow"),
                baseline: bF1 !== undefined ? `${bF1}%` : dash,
                modelOnly: mF1 !== undefined ? `${mF1}%` : dash,
                fullPipeline: pF1 !== undefined ? `${pF1}%` : dash,
                gain:
                  bF1 !== undefined && (pF1 ?? mF1) !== undefined
                    ? `+${((pF1 ?? mF1)! - bF1).toFixed(2)}%`
                    : dash,
                highlightGain: true,
              });
            }
            if (
              bGpu !== undefined ||
              mGpu !== undefined ||
              pGpu !== undefined
            ) {
              mobileRows.push({
                label: t("training.flow1.gpuSpeedLabel"),
                baseline:
                  bGpu !== undefined
                    ? t("training.flow1.gpuSpeedValue", {
                        value: formatNumber(bGpu),
                      })
                    : dash,
                modelOnly:
                  mGpu !== undefined
                    ? t("training.flow1.gpuSpeedValue", {
                        value: formatNumber(mGpu),
                      })
                    : dash,
                fullPipeline:
                  pGpu !== undefined
                    ? t("training.flow1.gpuSpeedValue", {
                        value: formatNumber(pGpu),
                      })
                    : dash,
                gain: t("training.flow1.gpuSpeedPerLine", {
                  value: formatNumber((pGpu ?? mGpu ?? bGpu)!),
                }),
                highlightGain: false,
              });
            }

            return (
              <div key={dataset.key}>
                <div className="mb-2.5 rounded-control bg-sky/50 px-3.5 py-2 text-sm font-extrabold text-primary-hover md:mb-0 md:rounded-b-none md:px-4">
                  {dataset.label}
                </div>
                <div className="space-y-2.5 md:hidden">
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
                          <dt className="text-muted">
                            {t("training.flow1.baselineShort")}
                          </dt>
                          <dd className="mt-0.5 font-mono font-semibold text-muted">
                            {row.baseline}
                          </dd>
                        </div>
                        <div className="rounded-control bg-canvas px-2.5 py-2">
                          <dt className="text-muted">
                            {t("training.flow1.modelOnlyShort")}
                          </dt>
                          <dd className="mt-0.5 font-mono font-semibold text-ink">
                            {row.modelOnly}
                          </dd>
                        </div>
                        <div className="rounded-control bg-sky/30 px-2.5 py-2">
                          <dt className="text-muted">
                            {t("training.flow1.fullPipeShort")}
                          </dt>
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
                    ariaLabel={t("training.flow1.tableAria", {
                      label: dataset.label,
                    })}
                    className="rounded-b-control rounded-t-none border-t-0"
                  >
                    <table className="w-full min-w-[640px] text-start text-sm">
                      <thead className="border-b border-border bg-slate-50 text-xs font-bold text-muted">
                        <tr>
                          <th className="px-4 py-2.5">
                            {t("training.flow1.metricHeader")}
                          </th>
                          <th className="px-4 py-2.5">
                            {t("training.flow1.baselineHeader", {
                              name:
                                models.baseline ||
                                t("training.flow1.baselineFallback"),
                            })}
                          </th>
                          <th className="px-4 py-2.5">
                            {t("training.flow1.finetunedModelOnlyHeader")}
                          </th>
                          <th className="px-4 py-2.5">
                            {t("training.flow1.finetunedPipelineHeader")}
                          </th>
                          <th className="px-4 py-2.5 text-end">
                            {t("training.flow1.gainHeader")}
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        <tr className="hover:bg-sky/10">
                          <td className="px-4 py-2.5 font-bold text-ink">
                            {t("training.flow1.cerHeader")}{" "}
                            <span className="text-xs font-normal text-muted">
                              {t("training.flow1.lowerBetter")}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-muted">
                            {bCer !== undefined ? `${bCer}%` : dash}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                            {mCer !== undefined ? `${mCer}%` : dash}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                            {pCer !== undefined ? `${pCer}%` : dash}
                          </td>
                          <td className="px-4 py-2.5 text-end font-mono font-extrabold text-emerald-700">
                            {cerGain ? `-${cerGain}%` : dash}
                          </td>
                        </tr>
                        <tr className="hover:bg-sky/10">
                          <td className="px-4 py-2.5 font-bold text-ink">
                            {t("training.flow1.werHeader")}{" "}
                            <span className="text-xs font-normal text-muted">
                              {t("training.flow1.lowerBetter")}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 font-mono text-muted">
                            {bWer !== undefined ? `${bWer}%` : dash}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                            {mWer !== undefined ? `${mWer}%` : dash}
                          </td>
                          <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                            {pWer !== undefined ? `${pWer}%` : dash}
                          </td>
                          <td className="px-4 py-2.5 text-end font-mono font-extrabold text-emerald-700">
                            {werGain ? `-${werGain}%` : dash}
                          </td>
                        </tr>
                        {bExact !== undefined ||
                        mExact !== undefined ||
                        pExact !== undefined ? (
                          <tr className="hover:bg-sky/10">
                            <td className="px-4 py-2.5 font-bold text-ink">
                              {t("training.flow1.exactMatchMobileRow")}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-muted">
                              {bExact !== undefined ? `${bExact}%` : dash}
                            </td>
                            <td className="px-4 py-2.5 font-mono">
                              {mExact !== undefined ? `${mExact}%` : dash}
                            </td>
                            <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                              {pExact !== undefined ? `${pExact}%` : dash}
                            </td>
                            <td className="px-4 py-2.5 text-end font-mono font-bold text-emerald-700">
                              {bExact !== undefined &&
                              (pExact ?? mExact) !== undefined
                                ? `+${((pExact ?? mExact)! - bExact).toFixed(2)}%`
                                : dash}
                            </td>
                          </tr>
                        ) : null}
                        {bF1 !== undefined ||
                        mF1 !== undefined ||
                        pF1 !== undefined ? (
                          <tr className="hover:bg-sky/10">
                            <td className="px-4 py-2.5 font-bold text-ink">
                              {t("training.flow1.f1MobileRow")}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-muted">
                              {bF1 !== undefined ? `${bF1}%` : dash}
                            </td>
                            <td className="px-4 py-2.5 font-mono">
                              {mF1 !== undefined ? `${mF1}%` : dash}
                            </td>
                            <td className="px-4 py-2.5 font-mono font-semibold text-ink">
                              {pF1 !== undefined ? `${pF1}%` : dash}
                            </td>
                            <td className="px-4 py-2.5 text-end font-mono font-bold text-emerald-700">
                              {bF1 !== undefined && (pF1 ?? mF1) !== undefined
                                ? `+${((pF1 ?? mF1)! - bF1).toFixed(2)}%`
                                : dash}
                            </td>
                          </tr>
                        ) : null}
                        {bGpu !== undefined ||
                        mGpu !== undefined ||
                        pGpu !== undefined ? (
                          <tr className="hover:bg-sky/10">
                            <td className="px-4 py-2.5 font-bold text-ink">
                              {t("training.flow1.gpuSpeedLabel")}
                            </td>
                            <td className="px-4 py-2.5 font-mono text-muted">
                              {bGpu !== undefined
                                ? t("training.flow1.gpuSpeedValue", {
                                    value: formatNumber(bGpu),
                                  })
                                : dash}
                            </td>
                            <td className="px-4 py-2.5 font-mono">
                              {mGpu !== undefined
                                ? t("training.flow1.gpuSpeedValue", {
                                    value: formatNumber(mGpu),
                                  })
                                : dash}
                            </td>
                            <td className="px-4 py-2.5 font-mono">
                              {pGpu !== undefined
                                ? t("training.flow1.gpuSpeedValue", {
                                    value: formatNumber(pGpu),
                                  })
                                : dash}
                            </td>
                            <td className="px-4 py-2.5 text-end font-mono text-muted">
                              {t("training.flow1.gpuSpeedPerLine", {
                                value: formatNumber((pGpu ?? mGpu ?? bGpu)!),
                              })}
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
                {t("training.flow1.diacriticsHeading")}
              </h4>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {diacritics.tone_confusion_chars ? (
                  <div className="rounded-control border border-border bg-white p-3">
                    <p className="text-xs font-bold text-muted">
                      {t("training.flow1.toneConfusion")}
                    </p>
                    <p className="mt-1 font-mono text-sm">
                      <span className="text-muted line-through">
                        {t("training.flow1.charUnit", {
                          count:
                            diacritics.tone_confusion_chars.baseline !==
                            undefined
                              ? formatNumber(
                                  diacritics.tone_confusion_chars.baseline,
                                )
                              : dash,
                        })}
                      </span>{" "}
                      →{" "}
                      <span className="font-extrabold text-emerald-700">
                        {t("training.flow1.charUnit", {
                          count:
                            diacritics.tone_confusion_chars.finetuned !==
                            undefined
                              ? formatNumber(
                                  diacritics.tone_confusion_chars.finetuned,
                                )
                              : dash,
                        })}
                      </span>
                    </p>
                    {diacritics.tone_confusion_chars.reduction_pct ? (
                      <span className="mt-1 inline-block text-xs font-bold text-emerald-700">
                        {t("training.flow1.reductionTone", {
                          pct: formatNumber(
                            diacritics.tone_confusion_chars.reduction_pct,
                          ),
                        })}
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {diacritics.d_vs_d_stroke_chars ? (
                  <div className="rounded-control border border-border bg-white p-3">
                    <p className="text-xs font-bold text-muted">
                      {t("training.flow1.dStrokeConfusion")}
                    </p>
                    <p className="mt-1 font-mono text-sm">
                      <span className="text-muted line-through">
                        {t("training.flow1.charUnit", {
                          count:
                            diacritics.d_vs_d_stroke_chars.baseline !==
                            undefined
                              ? formatNumber(
                                  diacritics.d_vs_d_stroke_chars.baseline,
                                )
                              : dash,
                        })}
                      </span>{" "}
                      →{" "}
                      <span className="font-extrabold text-emerald-700">
                        {t("training.flow1.charUnit", {
                          count:
                            diacritics.d_vs_d_stroke_chars.finetuned !==
                            undefined
                              ? formatNumber(
                                  diacritics.d_vs_d_stroke_chars.finetuned,
                                )
                              : dash,
                        })}
                      </span>
                    </p>
                    {diacritics.d_vs_d_stroke_chars.reduction_pct ? (
                      <span className="mt-1 inline-block text-xs font-bold text-emerald-700">
                        {t("training.flow1.reductionDStroke", {
                          pct: formatNumber(
                            diacritics.d_vs_d_stroke_chars.reduction_pct,
                          ),
                        })}
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
  const t = useTranslations("admin");
  const { formatNumber } = useI18n();
  const [weightsFile, setWeightsFile] = useState<File | null>(null);
  const [configFile, setConfigFile] = useState<File | null>(null);
  const [comparisonFile, setComparisonFile] = useState<File | null>(null);
  const [modelVersion, setModelVersion] = useState("");
  const reason = t("training.flow1.defaultModelDescription");

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
      setFormError(t("training.flow1.errors.weightsExt"));
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
      setFormError(t("training.flow1.errors.yamlExt"));
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
      setFormError(t("training.flow1.errors.jsonExt"));
      setComparisonFile(null);
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      if (!parsed || typeof parsed !== "object") {
        setPreviewMetrics({
          isValid: false,
          errorMsg: t("training.flow1.errors.jsonNotObject"),
        });
        setComparisonFile(null);
        return;
      }

      if (!parsed.models || typeof parsed.models !== "object") {
        setPreviewMetrics({
          isValid: false,
          errorMsg: t("training.flow1.errors.jsonMissingModels"),
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
          errorMsg: t("training.flow1.errors.jsonMissingMetrics"),
        });
        setComparisonFile(null);
        return;
      }

      if (hasRegression) {
        setPreviewMetrics({
          isValid: false,
          errorMsg: t("training.flow1.errors.notBetterThanBaseline"),
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
        errorMsg: t("training.flow1.errors.jsonParseFailed"),
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
    setProgressStatus(t("training.flow1.progress.preparingChunks"));

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
          t("training.flow1.progress.uploadingChunk", {
            current: formatNumber(i + 1),
            total: formatNumber(totalChunks),
            size: formatBytes(chunkBlob.size, t, formatNumber),
          }),
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
      setProgressStatus(t("training.flow1.progress.verifyingSha"));

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
      setProgressStatus(t("training.flow1.progress.activated"));
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
          : t("training.flow1.errors.replaceFailed");
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
    t,
    formatNumber,
  ]);

  return (
    <div className="rounded-xl border border-primary/25 bg-white p-5 shadow-2xs">
      <div className="flex items-center justify-between gap-2 border-b border-border/80 pb-3">
        <div>
          <span className="inline-block rounded-full bg-sky px-2.5 py-0.5 text-xs font-extrabold text-primary-hover">
            {t("training.flow1.badgeEyebrow")}
          </span>
          <h3 className="mt-1.5 text-lg font-extrabold text-ink">
            {t("training.flow1.heading")}
          </h3>
        </div>
        <UploadCloud aria-hidden className="size-6 shrink-0 text-primary" />
      </div>

      <p className="mt-2.5 text-sm text-muted">
        {t("training.flow1.description")}
      </p>

      {successNotice ? (
        <div className="mt-4 rounded-control border border-emerald-200 bg-success-surface p-4">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-700" />
            <div>
              <p className="font-extrabold text-success-ink">
                {t("training.flow1.successTitle")}
              </p>
              <p className="mt-1 text-sm text-success-ink">
                {t("training.flow1.activeVersionLabel")}{" "}
                <span className="font-bold">{successNotice.versionLabel}</span>.
              </p>
              <p className="mt-1 text-xs text-emerald-700">
                {successNotice.previousModelExisted
                  ? t("training.flow1.cleanupDeletedOld", {
                      count: formatNumber(successNotice.deletedCount),
                    })
                  : t("training.flow1.cleanupKeptOriginal")}
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
            {t("training.flow1.step1Label")}{" "}
            <span className="text-danger">*</span>
          </label>
          <div className="mt-1.5 flex items-center gap-3">
            <input
              accept=".pth,.pt"
              className="block w-full cursor-pointer rounded-control border border-dashed border-border bg-surface-subtle/60 px-3 py-2 text-sm text-muted transition-colors hover:border-primary/50 hover:bg-sky/20 file:me-3 file:cursor-pointer file:rounded-control file:border file:border-border file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-ink hover:file:bg-sky/40 focus-visible:outline-2 focus-visible:outline-primary"
              disabled={uploading}
              id="viread-weights-file"
              onChange={handleWeightsChange}
              type="file"
            />
          </div>
          {weightsFile ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-emerald-700">
              <FileCheck2 className="size-3.5" />
              {t("training.flow1.selectedWithSize", {
                name: weightsFile.name,
                size: formatBytes(weightsFile.size, t, formatNumber),
              })}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted">
              {t("training.flow1.step1Hint")}
            </p>
          )}
        </div>

        {/* 2. Config file input */}
        <div>
          <label
            className="block text-sm font-bold text-ink"
            htmlFor="viread-config-file"
          >
            {t("training.flow1.step2Label")}{" "}
            <span className="text-xs font-normal text-muted">
              {t("training.flow1.optionalTag")}
            </span>
          </label>
          <div className="mt-1.5 flex items-center gap-3">
            <input
              accept=".yml,.yaml"
              className="block w-full cursor-pointer rounded-control border border-dashed border-border bg-surface-subtle/60 px-3 py-2 text-sm text-muted transition-colors hover:border-primary/50 hover:bg-sky/20 file:me-3 file:cursor-pointer file:rounded-control file:border file:border-border file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-ink hover:file:bg-sky/40 focus-visible:outline-2 focus-visible:outline-primary"
              disabled={uploading}
              id="viread-config-file"
              onChange={handleConfigChange}
              type="file"
            />
          </div>
          {configFile ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs font-semibold text-ink">
              <FileCode2 className="size-3.5" />
              {t("training.flow1.selectedWithSize", {
                name: configFile.name,
                size: formatBytes(configFile.size, t, formatNumber),
              })}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted">
              {t("training.flow1.step2HintPrefix")}
              <code className="font-mono text-ink">vgg_transformer</code>
              {t("training.flow1.step2HintSuffix")}
            </p>
          )}
        </div>

        {/* 3. Comparison JSON file input */}
        <div>
          <label
            className="block text-sm font-bold text-ink"
            htmlFor="viread-comparison-file"
          >
            {t("training.flow1.step3Label")}{" "}
            <span className="text-danger">*</span>
          </label>
          <div className="mt-1.5 flex items-center gap-3">
            <input
              accept=".json"
              className="block w-full cursor-pointer rounded-control border border-dashed border-border bg-surface-subtle/60 px-3 py-2 text-sm text-muted transition-colors hover:border-primary/50 hover:bg-sky/20 file:me-3 file:cursor-pointer file:rounded-control file:border file:border-border file:bg-white file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-ink hover:file:bg-sky/40 focus-visible:outline-2 focus-visible:outline-primary"
              disabled={uploading}
              id="viread-comparison-file"
              onChange={(e) => void handleComparisonChange(e)}
              type="file"
            />
          </div>
          {previewMetrics ? (
            <div className="mt-2">
              {previewMetrics.isValid ? (
                <div className="rounded-control border border-emerald-200 bg-success-surface p-2.5 text-xs text-success-ink">
                  <p className="flex items-center gap-1 font-bold">
                    <CheckCircle2 className="size-3.5 text-emerald-600" />
                    {t("training.flow1.verifiedReliabilityHeading")}
                  </p>
                  {previewMetrics.sgkCerImprovement ? (
                    <p className="mt-0.5">
                      {t("training.flow1.sgkCerLine", {
                        value: previewMetrics.sgkCerImprovement,
                      })}
                    </p>
                  ) : null}
                  {previewMetrics.sgkWerImprovement ? (
                    <p className="mt-0.5">
                      {t("training.flow1.sgkWerLine", {
                        value: previewMetrics.sgkWerImprovement,
                      })}
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-control border border-danger/25 bg-danger-surface p-2.5 text-xs text-danger">
                  <p className="flex items-center gap-1 font-bold">
                    <AlertCircle className="size-3.5 text-danger" />
                    {t("training.flow1.failedReliabilityHeading")}
                  </p>
                  <p className="mt-0.5">{previewMetrics.errorMsg}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted">
              {t("training.flow1.step3HintShort")}
            </p>
          )}
        </div>

        {/* 4. Model version name */}
        <div>
          <label
            className="block text-sm font-bold text-ink"
            htmlFor="viread-model-version"
          >
            {t("training.flow1.step4Label")}{" "}
            <span className="text-xs font-normal text-muted">
              {t("training.flow1.optionalShort")}
            </span>
          </label>
          <input
            className="mt-1.5 h-11 w-full rounded-control border border-border bg-white px-3 text-sm text-ink focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary"
            disabled={uploading}
            id="viread-model-version"
            maxLength={120}
            onChange={(e) => setModelVersion(e.target.value)}
            placeholder={t("training.flow1.versionPlaceholder")}
            value={modelVersion}
          />
        </div>

        {/* 5. Progress bar & Submit button */}
        {uploading ? (
          <div className="rounded-control border border-primary/25 bg-white p-4">
            <div className="flex justify-between text-xs font-bold text-primary-hover">
              <span>{progressStatus}</span>
              <span className="tabular-nums">{progressPercent}%</span>
            </div>
            <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-sky">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        ) : null}

        <div className="pt-1">
          <Button
            disabled={
              !weightsFile ||
              !comparisonFile ||
              uploading ||
              Boolean(previewMetrics && !previewMetrics.isValid)
            }
            fullWidth={false}
            onClick={() => void handleUploadAndReplace()}
            size="admin"
            variant="primary"
          >
            <ArrowUpRight className="size-4" />
            {uploading
              ? t("training.flow1.uploadingBtn")
              : t("training.flow1.submitBtn")}
          </Button>
        </div>
      </div>
    </div>
  );
}
