import type { ProgressReportDTO } from "@/types/reports";

interface ProgressChartProps {
  readonly report: ProgressReportDTO;
}

export function ProgressChart({ report }: ProgressChartProps) {
  const rows = [
    { label: "Bỏ sót", value: report.omission_count, color: "bg-[#ffad7a]" },
    { label: "Lặp từ", value: report.repetition_count, color: "bg-primary" },
    {
      label: "Dừng lâu",
      value: report.long_pause_count,
      color: "bg-[#86c8bc]",
    },
  ] as const;
  const maxValue = Math.max(...rows.map((row) => row.value), 1);

  return (
    <section
      aria-labelledby="reading-evidence-title"
      className="rounded-card bg-white p-5 shadow-[0_12px_32px_rgba(33,65,86,0.06)] sm:p-8"
    >
      <h2
        className="text-2xl font-extrabold text-ink"
        id="reading-evidence-title"
      >
        Bằng chứng đọc đã xác nhận
      </h2>
      <p className="mt-2 text-label text-muted">
        Chỉ gồm sự kiện CONFIRMED; UNCERTAIN và DISMISSED không được tính.
      </p>
      <div
        aria-hidden="true"
        className="mt-8 flex h-52 items-end gap-5 sm:gap-8"
      >
        {rows.map((row) => (
          <div
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
            key={row.label}
          >
            <span className="mb-2 text-center text-lg font-extrabold text-ink">
              {row.value}
            </span>
            <div
              className={`mx-auto w-full max-w-24 rounded-t-control ${row.color}`}
              style={{
                height: `${Math.max((row.value / maxValue) * 132, 8)}px`,
              }}
            />
            <span className="mt-3 text-center text-label font-bold text-muted">
              {row.label}
            </span>
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>Tóm tắt dạng bảng của biểu đồ bằng chứng đọc</caption>
        <thead>
          <tr>
            <th scope="col">Loại</th>
            <th scope="col">Số lần đã xác nhận</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>{row.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
