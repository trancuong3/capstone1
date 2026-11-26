import type { ProgressReportDTO } from "@/types/reports";

interface ProgressChartProps {
  readonly report: ProgressReportDTO;
}

export function ProgressChart({ report }: ProgressChartProps) {
  const rows = [
    {
      label: "Bỏ sót",
      value: report.omission_count,
      rate: report.omission_rate,
      barClass: "bg-primary",
    },
    {
      label: "Lặp từ",
      value: report.repetition_count,
      rate: report.repetition_rate,
      barClass: "bg-primary/80",
    },
    {
      label: "Dừng lâu",
      value: report.long_pause_count,
      rate: report.long_pause_rate,
      barClass: "bg-primary/60",
    },
  ] as const;

  const numericValues = rows
    .map((row) => row.value)
    .filter((value): value is number => typeof value === "number");
  const maxValue = Math.max(...numericValues, 1);
  const allMissing = numericValues.length === 0;

  return (
    <section
      aria-labelledby="reading-evidence-title"
      className="rounded-card border border-border bg-white p-4 md:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          className="text-lg font-extrabold text-ink md:text-xl"
          id="reading-evidence-title"
        >
          Các dấu hiệu khi đọc
        </h2>
        <span className="text-xs font-semibold text-muted">Đơn vị: lần</span>
      </div>
      <p className="mt-1 text-xs text-muted md:text-sm">
        Số lần ghi nhận trong kỳ đang xem. Chỉ số chưa có dữ liệu không được quy
        thành 0.
      </p>

      {allMissing ? (
        <p className="mt-5 rounded-control border border-dashed border-border bg-canvas px-4 py-5 text-sm font-semibold text-muted">
          Chưa có số liệu chi tiết về bỏ sót, lặp từ hoặc dừng lâu trong kỳ này.
        </p>
      ) : (
        <ul
          aria-hidden="true"
          className="mt-4 space-y-3.5 md:mt-5 md:space-y-4"
        >
          {rows.map((row) => {
            const hasValue = row.value !== null;
            const widthPercent =
              hasValue && row.value > 0
                ? Math.max(6, Math.round((row.value / maxValue) * 100))
                : 0;
            return (
              <li className="space-y-1.5" key={row.label}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="text-sm font-bold text-ink">
                    {row.label}
                  </span>
                  <span
                    className={
                      hasValue
                        ? "text-right text-sm font-extrabold tabular-nums text-ink"
                        : "text-right text-xs font-semibold text-muted"
                    }
                  >
                    {hasValue ? `${row.value} lần` : "Chưa có dữ liệu"}
                    {hasValue && row.rate !== null ? (
                      <span className="ml-1.5 font-semibold text-muted">
                        ({row.rate.toFixed(1)}%)
                      </span>
                    ) : null}
                  </span>
                </div>
                <div
                  className={
                    hasValue
                      ? "h-2.5 w-full overflow-hidden rounded-full bg-canvas ring-1 ring-inset ring-border/70"
                      : "h-2.5 w-full rounded-full border border-dashed border-border bg-canvas/60"
                  }
                >
                  {widthPercent > 0 ? (
                    <div
                      className={`h-full rounded-full ${row.barClass}`}
                      style={{ width: `${widthPercent}%` }}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="sr-only">
        <table>
          <caption>Tóm tắt dạng bảng của biểu đồ bằng chứng đọc</caption>
          <thead>
            <tr>
              <th scope="col">Loại</th>
              <th scope="col">Số lần đã lưu</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{row.value ?? "Chưa có dữ liệu"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
