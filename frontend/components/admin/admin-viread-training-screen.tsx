"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AdminLoading, AdminPageHeader } from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import type { VireadTrainingOverview } from "@/lib/api/viread-training-service";

function hash(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function trainingProfileName(profile: string) {
  if (profile === "FLOW1_EXTERNAL_TRDG" || profile === "FLOW2_EXTERNAL_TRDG") {
    return "Luồng 1 · ảnh thực tế + TRDG";
  }
  if (profile === "FLOW2_ADMIN_VERIFIED" || profile === "FLOW1_VERIFIED") {
    return "Luồng 2 · Admin xác nhận";
  }
  return profile;
}

export function AdminVireadTrainingScreen() {
  const { vireadTraining } = useAdminServices();
  const [data, setData] = useState<VireadTrainingOverview | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reason, setReason] = useState(
    "Đã rà soát báo cáo Locked Test và chấp thuận bản VietOCR V2.",
  );

  const load = useCallback(async () => {
    setError(false);
    if (!vireadTraining) {
      setError(true);
      return;
    }
    try {
      setData(await vireadTraining.overview());
    } catch {
      setError(true);
    }
  }, [vireadTraining]);

  useEffect(() => {
    const timeout = globalThis.setTimeout(() => void load(), 0);
    const interval = globalThis.setInterval(() => void load(), 30_000);
    return () => {
      globalThis.clearTimeout(timeout);
      globalThis.clearInterval(interval);
    };
  }, [load]);

  const latestPassing = useMemo(() => {
    if (!data) return [];
    return data.runs.flatMap((run) => {
      const benchmark = data.benchmarks.find(
        (item) =>
          item.run_id === run.run_id &&
          item.candidate_checkpoint_sha256 === run.checkpoint_sha256 &&
          item.gate_status === "V2_WIN",
      );
      return benchmark ? [{ run, benchmark }] : [];
    });
  }, [data]);

  async function decide(input: {
    action: "APPROVE" | "ROLLBACK";
    run_id?: string;
    benchmark_id?: string;
  }) {
    if (!vireadTraining || busy || reason.trim().length < 8) return;
    setBusy(true);
    setMessage(null);
    try {
      await vireadTraining.decide({ ...input, reason: reason.trim() });
      setMessage(
        input.action === "APPROVE"
          ? "Đã ghi quyết định phê duyệt. Backend sẽ tải model đã kiểm tra."
          : "Đã ghi quyết định rollback về model trước đó.",
      );
      await load();
    } catch {
      setMessage(
        "Không thể lưu quyết định. Hãy kiểm tra trạng thái và thử lại.",
      );
    } finally {
      setBusy(false);
    }
  }

  const totalSamples =
    data?.samples.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const outboxPending =
    data?.outbox
      .filter((item) => item.status === "PENDING" || item.status === "RETRY")
      .reduce((sum, item) => sum + item.count, 0) ?? 0;
  const sourceCount = (flows: string[], split?: string) =>
    data?.samples
      .filter(
        (item) =>
          flows.includes(item.source_flow) && (!split || item.split === split),
      )
      .reduce((sum, item) => sum + item.count, 0) ?? 0;
  const flow1External = sourceCount(["FLOW2_EXTERNAL"]);
  const flow1Trdg = sourceCount(["FLOW2_TRDG"]);
  const flow1Train = sourceCount(["FLOW2_EXTERNAL", "FLOW2_TRDG"], "train");
  const flow1Validation = sourceCount(
    ["FLOW2_EXTERNAL", "FLOW2_TRDG"],
    "validation",
  );
  const flow2Train = sourceCount(["FLOW1_VERIFIED"], "train");
  const flow2Validation = sourceCount(["FLOW1_VERIFIED"], "validation");

  return (
    <>
      <AdminPageHeader
        eyebrow="OCR model lifecycle"
        title="Huấn luyện VietOCR V2"
        description="Theo dõi hai luồng dữ liệu, checkpoint, benchmark ghép cặp và quyết định model."
        actions={
          <Button
            className="sm:w-auto"
            disabled={!data || busy}
            onClick={() => void load()}
            variant="secondary"
          >
            <RefreshCw aria-hidden className="size-5" /> Làm mới
          </Button>
        }
      />

      {!data && !error ? <AdminLoading /> : null}
      {error ? (
        <StatusMessage tone="error">
          Chưa thể tải trạng thái huấn luyện. Kiểm tra quyền Admin và migration
          VietOCR V2.
        </StatusMessage>
      ) : null}
      {message ? (
        <p
          aria-live="polite"
          className="mb-4 rounded-control bg-sky p-4 font-bold text-primary-hover"
        >
          {message}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="mb-6 grid gap-4 md:grid-cols-3">
            <Card className="bg-white">
              <p className="font-bold text-muted">Model đang hoạt động</p>
              <h2 className="mt-2 text-xl font-black">
                {data.active_model
                  ? trainingProfileName(data.active_model.profile)
                  : "Chưa khởi tạo"}
              </h2>
              <p className="mt-2 break-all font-mono text-xs text-muted">
                {data.active_model
                  ? hash(data.active_model.checkpoint_sha256)
                  : "—"}
              </p>
            </Card>
            <Card className="bg-white">
              <p className="font-bold text-muted">Mẫu dữ liệu đã đăng ký</p>
              <h2 className="mt-2 text-3xl font-black">
                {totalSamples.toLocaleString("vi-VN")}
              </h2>
              <p className="mt-2 text-sm text-muted">
                Các luồng được lưu tách riêng.
              </p>
            </Card>
            <Card className="bg-white">
              <p className="font-bold text-muted">Outbox VERIFIED đang chờ</p>
              <h2 className="mt-2 text-3xl font-black">
                {outboxPending.toLocaleString("vi-VN")}
              </h2>
              <p className="mt-2 text-sm text-muted">
                Tác vụ bền vững, tự retry khi lỗi.
              </p>
            </Card>
          </div>

          <Card className="mb-6 bg-white">
            <h2 className="text-xl font-black">Nguồn dữ liệu</h2>
            <p className="mt-2 text-sm text-muted">
              Hai luồng dùng dataset và run riêng, cùng fine-tune VietOCR V2.
            </p>
            <ul className="mt-4 grid gap-3 md:grid-cols-2">
              <li className="rounded-control border border-border p-4">
                <p className="font-extrabold">
                  Luồng 1 · ảnh thực tế + DBNet + TRDG
                </p>
                <p className="mt-2 text-sm">
                  Ảnh thực tế: {flow1External.toLocaleString("vi-VN")} · TRDG:{" "}
                  {flow1Trdg.toLocaleString("vi-VN")}
                </p>
                <p className="mt-1 text-sm text-muted">
                  Train {flow1Train.toLocaleString("vi-VN")} · Validation{" "}
                  {flow1Validation.toLocaleString("vi-VN")} · Holdout{" "}
                  {sourceCount(
                    ["FLOW2_EXTERNAL", "FLOW2_TRDG"],
                    "holdout",
                  ).toLocaleString("vi-VN")}
                </p>
                <p className="mt-2 text-sm font-bold text-muted">
                  {flow1External > 1_000 || flow1Trdg > 50_000
                    ? "Vượt khoảng dữ liệu cho phép: 500–1.000 mẫu thật và 20.000–50.000 mẫu TRDG"
                    : flow1External < 500 ||
                        flow1Trdg < 20_000 ||
                        !flow1Train ||
                        !flow1Validation
                      ? "Chưa sẵn sàng: cần 500–1.000 mẫu thật, 20.000–50.000 mẫu TRDG, train và validation"
                      : "Đủ dữ liệu; hệ thống tự đăng ký job Flow 1 riêng sau khi snapshot hợp lệ"}
                </p>
              </li>
              <li className="rounded-control border border-border p-4">
                <p className="font-extrabold">
                  Luồng 2 · văn bản Admin xác nhận
                </p>
                <p className="mt-2 text-sm">
                  Crop dòng từ revision VERIFIED:{" "}
                  {sourceCount(["FLOW1_VERIFIED"]).toLocaleString("vi-VN")} mẫu
                </p>
                <p className="mt-1 text-sm text-muted">
                  Train {flow2Train.toLocaleString("vi-VN")} · Validation{" "}
                  {flow2Validation.toLocaleString("vi-VN")} · Holdout{" "}
                  {sourceCount(["FLOW1_VERIFIED"], "holdout").toLocaleString(
                    "vi-VN",
                  )}
                </p>
                <p className="mt-1 text-xs text-muted">
                  Mỗi mẫu là một ảnh dòng chữ; nhiều từ trong cùng dòng được
                  ghép thành một nhãn.
                </p>
                <p className="mt-2 text-sm font-bold text-muted">
                  {flow2Train > 0 && flow2Validation > 0
                    ? "Đủ Train và Validation; hệ thống tự tạo job Flow 2 riêng"
                    : "Chưa sẵn sàng: cần trang VERIFIED thuộc train và validation; các dòng cùng trang luôn nằm chung một tập"}
                </p>
              </li>
            </ul>
          </Card>

          <Card className="mb-6 bg-white">
            <h2 className="text-xl font-black">Hàng đợi huấn luyện tự động</h2>
            <p className="mt-2 text-sm text-muted">
              Mỗi job giữ riêng dataset, profile và lineage. Colab Enterprise tự
              chạy job theo thứ tự; model chỉ đổi sau quality gate và Admin
              duyệt.
            </p>
            <div className="mt-4 space-y-3">
              {data.jobs.map((job) => {
                const stage = job.progress.stage;
                const waitingReason = job.metadata.waiting_reason;
                const localUnavailable = job.metadata.local_unavailable;
                const workerStatusValue = job.metadata.colab_worker_status;
                const workerStatus =
                  typeof workerStatusValue === "object" &&
                  workerStatusValue !== null &&
                  !Array.isArray(workerStatusValue)
                    ? (workerStatusValue as Record<string, unknown>)
                    : null;
                return (
                  <article
                    className="rounded-control border border-border p-4"
                    key={job.job_id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-extrabold">
                        {trainingProfileName(job.profile)} · {job.status}
                      </h3>
                      <span className="text-sm text-muted">
                        {job.target} · lần thử {job.attempts}
                      </span>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-muted">
                      Job {job.job_id} · manifest {hash(job.manifest_sha256)}
                    </p>
                    <p className="mt-1 text-sm">
                      Giai đoạn:{" "}
                      {typeof stage === "string" ? stage : "đang chờ"}
                      {typeof job.progress.completed_steps === "number" &&
                      typeof job.progress.total_steps === "number"
                        ? ` · ${job.progress.completed_steps}/${job.progress.total_steps} bước`
                        : ""}
                    </p>
                    {job.status === "WAITING_FOR_COLAB_WORKER" ||
                    job.status === "FALLBACK_QUEUED_COLAB" ? (
                      <p className="mt-1 text-sm text-muted">
                        {workerStatus?.status === "READY"
                          ? `Colab worker báo READY lần gần nhất${typeof workerStatus.reported_at === "string" ? ` lúc ${new Date(workerStatus.reported_at).toLocaleString("vi-VN")}` : ""}.`
                          : workerStatus?.status === "WAITING_FOR_GPU"
                            ? `Colab worker đang chờ GPU phù hợp (${typeof workerStatus.reason_code === "string" ? workerStatus.reason_code : "thiếu GPU/CUDA/VRAM"}). Job vẫn được giữ trong hàng đợi.`
                            : workerStatus?.status === "WAITING_FOR_RESOURCES"
                              ? `Colab worker đang chờ đủ RAM hoặc dung lượng đĩa (${typeof workerStatus.reason_code === "string" ? workerStatus.reason_code : "thiếu tài nguyên"}). Job vẫn được giữ trong hàng đợi.`
                              : "Chưa có Colab worker sẵn sàng. Khi worker đã cấu hình và kết nối, job sẽ tự được nhận."}
                      </p>
                    ) : null}
                    {job.status === "COLAB_SUBMITTED" ||
                    job.status === "COLAB_EXECUTING" ? (
                      <p className="mt-1 text-sm text-muted">
                        {job.status === "COLAB_SUBMITTED"
                          ? "Colab Enterprise đã nhận execution; chờ runtime GPU bắt đầu."
                          : "Colab Enterprise đang chạy notebook cho job này."}
                      </p>
                    ) : null}
                    {job.status === "BLOCKED_CONFIGURATION" ? (
                      <p className="mt-1 text-sm text-danger">
                        Job chưa được gửi lên Google Cloud. Mã cấu hình:{" "}
                        {job.last_error_code ?? "chưa cấu hình"}. Hãy hoàn tất
                        checklist trong docs/viread-colab-enterprise-setup.md
                        rồi thử lại.
                      </p>
                    ) : null}
                    {job.colab_execution_resource_name ? (
                      <p className="mt-1 break-all font-mono text-xs text-muted">
                        Execution {job.colab_execution_resource_name}
                      </p>
                    ) : null}
                    {job.status === "QUALITY_GATE_REJECTED" ? (
                      <p className="mt-1 text-sm text-muted">
                        Candidate không đạt quality gate và chưa được kích hoạt.
                      </p>
                    ) : null}
                    {job.target === "COLAB" &&
                    typeof localUnavailable === "string" ? (
                      <p className="mt-1 text-sm text-muted">
                        Máy local chuyển job sang Colab vì: {localUnavailable}.
                      </p>
                    ) : null}
                    {typeof waitingReason === "string" ? (
                      <p className="mt-1 text-sm text-muted">
                        Đang chờ dữ liệu: cần cả Train và Validation.
                      </p>
                    ) : null}
                    {job.last_error_code ? (
                      <p className="mt-1 text-sm text-danger">
                        Mã lỗi: {job.last_error_code}
                      </p>
                    ) : null}
                    {job.run_id ? (
                      <p className="mt-1 break-all font-mono text-xs text-muted">
                        Run {job.run_id}
                      </p>
                    ) : null}
                  </article>
                );
              })}
              {data.jobs.length === 0 ? (
                <p className="text-sm text-muted">
                  Chưa có dataset nào đủ điều kiện tạo job.
                </p>
              ) : null}
            </div>
          </Card>

          <Card className="mb-6 bg-white">
            <h2 className="text-xl font-black">Các lần huấn luyện</h2>
            <p className="mt-2 text-sm text-muted">
              {latestPassing.length} checkpoint đạt quality gate và đủ điều kiện
              xét duyệt.
            </p>
            <div className="mt-4 space-y-3">
              {data.runs.map((run) => {
                const benchmark = data.benchmarks.find(
                  (item) => item.run_id === run.run_id,
                );
                return (
                  <article
                    className="rounded-control border border-border p-4"
                    key={run.run_id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-extrabold">
                        {trainingProfileName(run.profile)} · {run.status}
                      </h3>
                      <span className="text-sm text-muted">
                        Bước {run.step.toLocaleString("vi-VN")}
                      </span>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-muted">
                      Run {run.run_id}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-muted">
                      Checkpoint{" "}
                      {run.checkpoint_sha256
                        ? hash(run.checkpoint_sha256)
                        : "chưa hoàn tất"}
                    </p>
                    <p className="mt-2 text-sm">
                      Benchmark:{" "}
                      {benchmark
                        ? `${benchmark.gate_status} · ${benchmark.sample_count} cặp / ${benchmark.group_count} nhóm`
                        : "chưa có"}
                    </p>
                    {benchmark?.gate_status === "V2_WIN" ? (
                      <Button
                        className="mt-3 h-12 w-auto"
                        disabled={
                          busy ||
                          !run.checkpoint_sha256 ||
                          data.active_model?.checkpoint_sha256 ===
                            run.checkpoint_sha256
                        }
                        onClick={() =>
                          void decide({
                            action: "APPROVE",
                            run_id: run.run_id,
                            benchmark_id: benchmark.benchmark_id,
                          })
                        }
                      >
                        Phê duyệt model
                      </Button>
                    ) : null}
                  </article>
                );
              })}
              {data.runs.length === 0 ? (
                <p className="text-muted">Chưa có lần huấn luyện nào.</p>
              ) : null}
            </div>
          </Card>

          <Card className="bg-white">
            <h2 className="text-xl font-black">Quản lý quyết định</h2>
            <label
              className="mt-4 block font-bold"
              htmlFor="viread-decision-reason"
            >
              Lý do phê duyệt hoặc rollback
            </label>
            <textarea
              className="mt-2 min-h-24 w-full rounded-control border border-border p-3 focus-visible:outline-3 focus-visible:outline-primary"
              id="viread-decision-reason"
              maxLength={1000}
              minLength={8}
              onChange={(event) => setReason(event.target.value)}
              value={reason}
            />
            <p className="mt-2 text-sm text-muted">
              Quyết định chỉ đổi con trỏ model sau benchmark thắng trên Locked
              Test; Original vẫn được giữ làm baseline và phương án rollback.
            </p>
            {data.active_model && data.active_model.profile !== "ORIGINAL" ? (
              <Button
                className="mt-4 h-12 w-auto"
                disabled={busy || reason.trim().length < 8}
                onClick={() => void decide({ action: "ROLLBACK" })}
                variant="secondary"
              >
                Rollback về model trước
              </Button>
            ) : null}
          </Card>
        </>
      ) : null}
    </>
  );
}
