import type { ReadingEventDTO } from "@/types/reading";

const eventLabels: Record<ReadingEventDTO["type"], string> = {
  OMISSION: "Bỏ sót",
  REPETITION: "Lặp từ",
  LONG_PAUSE: "Dừng lâu",
  SUBSTITUTION: "Thay từ",
  SELF_CORRECTION: "Tự sửa",
  READ_EXAMPLE: "Nghe đọc mẫu",
};

const statusLabels: Record<ReadingEventDTO["status"], string> = {
  CANDIDATE: "Đang xem xét",
  CONFIRMED: "Đã xác nhận",
  UNCERTAIN: "Chưa chắc chắn",
  DISMISSED: "Đã loại",
};

interface SessionEventListProps {
  readonly events: readonly ReadingEventDTO[];
}

export function SessionEventList({ events }: SessionEventListProps) {
  if (events.length === 0) {
    return (
      <p className="rounded-control bg-sky p-5 text-body text-muted">
        Buổi đọc này chưa có sự kiện để hiển thị.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-3">
      {events.map((event) => {
        const countsAsError =
          event.status === "CONFIRMED" &&
          ["OMISSION", "REPETITION", "LONG_PAUSE", "SUBSTITUTION"].includes(
            event.type,
          );

        return (
          <li
            className="rounded-control border border-border bg-white p-4"
            key={event.id}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-extrabold text-ink">
                {eventLabels[event.type]}
              </p>
              <span className="rounded-full bg-sky px-3 py-1 text-label font-bold text-primary-hover">
                {statusLabels[event.status]}
              </span>
            </div>
            <p className="mt-2 text-label text-muted">
              Mốc {Math.round(event.start_ms / 1000)} giây · revision lịch sử{" "}
              <code className="break-all">{event.page_revision_id}</code>
            </p>
            <p className="mt-2 text-label font-bold text-muted">
              {countsAsError
                ? "Bằng chứng lỗi đã xác nhận."
                : "Sự kiện hỗ trợ/không chắc chắn, không tính là lỗi của bé."}
            </p>
          </li>
        );
      })}
    </ol>
  );
}
