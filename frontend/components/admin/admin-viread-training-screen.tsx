"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  AdminLoading,
  AdminPageHeader,
} from "@/components/admin/admin-ui";
import { Button } from "@/components/common/button";
import { Card } from "@/components/common/card";
import { StatusMessage } from "@/components/common/status-message";
import { useAdminServices } from "@/hooks/use-admin-services";
import type { VireadTrainingOverview } from "@/lib/api/viread-training-service";

function hash(value: string) {
  return `${value.slice(0, 12)}…${value.slice(-8)}`;
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
    return () => globalThis.clearTimeout(timeout);
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
      setMessage("Không thể lưu quyết định. Hãy kiểm tra trạng thái và thử lại.");
    } finally {
      setBusy(false);
    }
  }

  const totalSamples = data?.samples.reduce((sum, item) => sum + item.count, 0) ?? 0;
  const outboxPending =
    data?.outbox
      .filter((item) => item.status === "PENDING" || item.status === "RETRY")
      .reduce((sum, item) => sum + item.count, 0) ?? 0;

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
          Chưa thể tải trạng thái huấn luyện. Kiểm tra quyền Admin và migration VietOCR V2.
        </StatusMessage>
      ) : null}
      {message ? (
        <p aria-live="polite" className="mb-4 rounded-control bg-sky p-4 font-bold text-primary-hover">
          {message}
        </p>
      ) : null}

      {data ? (
        <>
          <div className="mb-6 grid gap-4 md:grid-cols-3">
            <Card className="bg-white">
              <p className="font-bold text-muted">Model đang hoạt động</p>
              <h2 className="mt-2 text-xl font-black">{data.active_model?.profile ?? "Chưa khởi tạo"}</h2>
              <p className="mt-2 break-all font-mono text-xs text-muted">
                {data.active_model ? hash(data.active_model.checkpoint_sha256) : "—"}
              </p>
            </Card>
            <Card className="bg-white">
              <p className="font-bold text-muted">Mẫu dữ liệu đã đăng ký</p>
              <h2 className="mt-2 text-3xl font-black">{totalSamples.toLocaleString("vi-VN")}</h2>
              <p className="mt-2 text-sm text-muted">Các luồng được lưu tách riêng.</p>
            </Card>
            <Card className="bg-white">
              <p className="font-bold text-muted">Outbox VERIFIED đang chờ</p>
              <h2 className="mt-2 text-3xl font-black">{outboxPending.toLocaleString("vi-VN")}</h2>
              <p className="mt-2 text-sm text-muted">Tác vụ bền vững, tự retry khi lỗi.</p>
            </Card>
          </div>

          <Card className="mb-6 bg-white">
            <h2 className="text-xl font-black">Nguồn dữ liệu</h2>
            <ul className="mt-4 grid gap-3 md:grid-cols-3">
              {data.samples.map((item) => (
                <li className="rounded-control border border-border p-4" key={`${item.source_flow}-${item.split}`}>
                  <p className="font-extrabold">{item.source_flow}</p>
                  <p className="mt-1 text-sm text-muted">{item.split}: {item.count.toLocaleString("vi-VN")}</p>
                </li>
              ))}
              {data.samples.length === 0 ? (
                <li className="text-muted">Chưa có mẫu nào được đưa vào pipeline.</li>
              ) : null}
            </ul>
          </Card>

          <Card className="mb-6 bg-white">
            <h2 className="text-xl font-black">Các lần huấn luyện</h2>
            <p className="mt-2 text-sm text-muted">
              {latestPassing.length} checkpoint đạt quality gate và đủ điều kiện xét duyệt.
            </p>
            <div className="mt-4 space-y-3">
              {data.runs.map((run) => {
                const benchmark = data.benchmarks.find((item) => item.run_id === run.run_id);
                return (
                  <article className="rounded-control border border-border p-4" key={run.run_id}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="font-extrabold">{run.profile} · {run.status}</h3>
                      <span className="text-sm text-muted">Bước {run.step.toLocaleString("vi-VN")}</span>
                    </div>
                    <p className="mt-2 break-all font-mono text-xs text-muted">Run {run.run_id}</p>
                    <p className="mt-1 break-all font-mono text-xs text-muted">
                      Checkpoint {run.checkpoint_sha256 ? hash(run.checkpoint_sha256) : "chưa hoàn tất"}
                    </p>
                    <p className="mt-2 text-sm">
                      Benchmark: {benchmark ? `${benchmark.gate_status} · ${benchmark.sample_count} cặp / ${benchmark.group_count} nhóm` : "chưa có"}
                    </p>
                    {benchmark?.gate_status === "V2_WIN" ? (
                      <Button
                        className="mt-3 h-12 w-auto"
                        disabled={busy || !run.checkpoint_sha256 || data.active_model?.checkpoint_sha256 === run.checkpoint_sha256}
                        onClick={() => void decide({ action: "APPROVE", run_id: run.run_id, benchmark_id: benchmark.benchmark_id })}
                      >
                        Phê duyệt model
                      </Button>
                    ) : null}
                  </article>
                );
              })}
              {data.runs.length === 0 ? <p className="text-muted">Chưa có lần huấn luyện nào.</p> : null}
            </div>
          </Card>

          <Card className="bg-white">
            <h2 className="text-xl font-black">Quản lý quyết định</h2>
            <label className="mt-4 block font-bold" htmlFor="viread-decision-reason">
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
              Quyết định chỉ đổi con trỏ model sau benchmark thắng trên Locked Test; Original vẫn được giữ làm baseline và phương án rollback.
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
