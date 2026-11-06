import type { HistoryEventDTO } from "@/types/reading";

const eventLabels: Record<HistoryEventDTO["type"], string> = {
  MISPRONUNCIATION: "Ghi nhận phát âm",
  OMISSION: "Bỏ sót",
  REPETITION: "Lặp từ",
  LONG_PAUSE: "Dừng lâu",
  SUBSTITUTION: "Thay từ",
  SELF_CORRECTION: "Tự sửa",
  READ_EXAMPLE: "Nghe đọc mẫu",
  WORD_RETRY: "Lượt đọc lại",
};

const statusLabels: Record<HistoryEventDTO["status"], string> = {
  DETECTED: "Đã phát hiện, chưa xác nhận",
  FEEDBACK_GIVEN: "Đã đưa phản hồi",
  IGNORED_BY_GATE: "Không qua điều kiện xác nhận",
  CANDIDATE: "Đang xem xét",
  CONFIRMED: "Đã xác nhận",
  FAILED: "Chưa đọc đúng ở lượt này",
  UNCERTAIN: "Chưa chắc chắn",
  DISMISSED: "Đã loại",
};

interface SessionEventListProps {
  readonly events: readonly HistoryEventDTO[];
}

export function SessionEventList({ events }: SessionEventListProps) {
  if (events.length === 0) {
    return (
      <p className="rounded-control bg-sky p-5 text-body text-muted">
        Buổi đọc này chưa có sự kiện để hiển thị.
      </p>
    );
  }

  const retryEvents = events.filter((event) => event.type === "WORD_RETRY");
  const readingEvents = events.filter((event) => event.type !== "WORD_RETRY");

  return (
    <div className="flex flex-col gap-5">
      {retryEvents.length > 0 ? (
        <section aria-label="Kết quả đọc lại" className="flex flex-col gap-3">
          <h3 className="text-lg font-extrabold text-ink">Kết quả đọc lại</h3>
          <ol className="flex flex-col gap-3">
            {retryEvents.map((event) => {
              const metadata = event.metadata;
              const attempt = metadata.retry_attempt;
              const originalStatus = metadata.original_status;
              const recognizedText = metadata.recognized_text;
              const targetWord = metadata.target_word;
              return (
                <li
                  className="rounded-control border border-border bg-white p-4"
                  key={event.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-extrabold text-ink">
                      {event.status === "CONFIRMED"
                        ? "Đã đọc đúng ở lượt đọc lại"
                        : event.status === "FAILED"
                          ? "Chưa đọc đúng ở lượt đọc lại"
                          : "Kết quả đọc lại chưa chắc chắn"}
                    </p>
                    <span className="rounded-full bg-sky px-3 py-1 text-label font-bold text-primary-hover">
                      {typeof attempt === "number" && Number.isInteger(attempt)
                        ? `Lần thử ${attempt}`
                        : statusLabels[event.status]}
                    </span>
                  </div>
                  <p className="mt-2 text-label text-muted">
                    Từ cần luyện:{" "}
                    {typeof targetWord === "string"
                      ? targetWord
                      : (event.page_revision_word_id ?? "Chưa ghi nhận")}
                    {typeof originalStatus === "string"
                      ? ` · ${originalStatus === "OMISSION" ? "Bỏ sót" : "Phát âm chưa đúng"}`
                      : ""}
                  </p>
                  {typeof recognizedText === "string" && recognizedText ? (
                    <p className="mt-2 text-label text-muted">
                      ViRead nhận diện: “{recognizedText}”
                    </p>
                  ) : null}
                  <p className="mt-2 text-label text-muted">
                    Trang {event.page_id} · revision đã đọc{" "}
                    <code className="break-all">{event.page_revision_id}</code>
                  </p>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {readingEvents.length > 0 ? (
        <section
          aria-label="Sự kiện lượt đọc đầu"
          className="flex flex-col gap-3"
        >
          {retryEvents.length > 0 ? (
            <h3 className="text-lg font-extrabold text-ink">
              Sự kiện lượt đọc đầu
            </h3>
          ) : null}
          <ol className="flex flex-col gap-3">
            {readingEvents.map((event) => {
              const countsAsError =
                event.status === "CONFIRMED" &&
                [
                  "OMISSION",
                  "REPETITION",
                  "LONG_PAUSE",
                  "SUBSTITUTION",
                ].includes(event.type);

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
                    Mốc {Math.round(event.start_ms / 1000)} giây · revision lịch
                    sử{" "}
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
        </section>
      ) : null}
    </div>
  );
}
