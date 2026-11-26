import type { ProgressReportDTO } from "@/types/reports";

interface ProgressChartProps {
  readonly report: ProgressReportDTO;
}

export function ProgressChart({ report }: ProgressChartProps) {
  const rows = [
    { label: "Bỏ sót", value: report.omission_count, color: "bg-primary" },
    { label: "Lặp từ", value: report.repetition_count, color: "bg-primary" },
    {
      label: "Dừng lâu",
      value: report.long_pause_count,
      color: "bg-primary",
    },
  ] as const;
  const maxValue = Math.max(...rows.map((row) => row.value ?? 0), 1);

  return (
    <section
      aria-labelledby="reading-evidence-title"
      className="rounded-card border border-border bg-white p-5 sm:p-6"
    >
      <h2
        className="text-xl font-semibold text-ink"
        id="reading-evidence-title"
      >
        Thống kê trong báo cáo đã lưu
      </h2>
      <p className="mt-2 text-label text-muted">
        Giữ nguyên số đếm đã lưu. Chỉ số chưa có dữ liệu không được thay bằng 0.
      </p>
      <div
        aria-hidden="true"
        className="mt-8 flex min-h-52 items-end gap-3 sm:gap-8"
      >
        {rows.map((row) => (
          <div
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
            key={row.label}
          >
            <span
              className={
                row.value === null
                  ? "mb-2 break-words text-center text-xs font-semibold leading-tight text-muted sm:text-sm"
                  : "mb-2 text-center text-lg font-semibold tabular-nums text-ink"
              }
            >
              {row.value ?? "Chưa có dữ liệu"}
            </span>
            <div
              className={`mx-auto w-full max-w-24 rounded-t-control ${row.color}`}
              style={{
                height: `${((row.value ?? 0) / maxValue) * 132}px`,
              }}
            />
            <span className="mt-3 text-center text-xs font-semibold text-muted sm:text-label">
              {row.label}
            </span>
          </div>
        ))}
      </div>
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
