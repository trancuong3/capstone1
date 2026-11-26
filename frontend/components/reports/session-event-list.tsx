import { ChevronDown } from "lucide-react";

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

function eventStatusBadgeClass(status: HistoryEventDTO["status"]): string {
  if (status === "CONFIRMED") {
    return "border border-success-ink/20 bg-success-surface text-success-ink";
  }
  if (status === "FAILED") {
    return "border border-warning/25 bg-warning-surface text-warning";
  }
  return "border border-border bg-canvas text-muted";
}

interface SessionEventListProps {
  readonly events: readonly HistoryEventDTO[];
}

export function SessionEventList({ events }: SessionEventListProps) {
  if (events.length === 0) {
    return (
      <p className="rounded-control border border-border bg-canvas px-4 py-4 text-sm text-muted">
        Buổi đọc này chưa có sự kiện để hiển thị.
      </p>
    );
  }

  const retryEvents = events.filter((event) => event.type === "WORD_RETRY");
  const readingEvents = events.filter((event) => event.type !== "WORD_RETRY");

  return (
    <div className="flex flex-col gap-5">
      {retryEvents.length > 0 ? (
        <section aria-label="Kết quả đọc lại" className="flex flex-col gap-2.5">
          <h3 className="text-base font-extrabold text-ink">Kết quả đọc lại</h3>
          <ol className="divide-y divide-border rounded-control border border-border bg-white">
            {retryEvents.map((event) => {
              const metadata = event.metadata;
              const attempt = metadata.retry_attempt;
              const originalStatus = metadata.original_status;
              const recognizedText = metadata.recognized_text;
              const targetWord = metadata.target_word;
              return (
                <li className="space-y-1.5 p-3.5 md:p-4" key={event.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-bold text-ink">
                      {event.status === "CONFIRMED"
                        ? "Đã đọc đúng ở lượt đọc lại"
                        : event.status === "FAILED"
                          ? "Chưa đọc đúng ở lượt đọc lại"
                          : "Kết quả đọc lại chưa chắc chắn"}
                    </p>
                    <span
                      className={`rounded-control px-2.5 py-0.5 text-xs font-bold ${eventStatusBadgeClass(event.status)}`}
                    >
                      {typeof attempt === "number" && Number.isInteger(attempt)
                        ? `Lần thử ${attempt}`
                        : statusLabels[event.status]}
                    </span>
                  </div>
                  <p className="break-words text-sm text-muted">
                    Từ cần luyện:{" "}
                    <strong className="font-bold text-ink">
                      {typeof targetWord === "string"
                        ? targetWord
                        : (event.page_revision_word_id ?? "Chưa ghi nhận")}
                    </strong>
                    {typeof originalStatus === "string"
                      ? ` · ${originalStatus === "OMISSION" ? "Bỏ sót" : "Phát âm chưa đúng"}`
                      : ""}
                  </p>
                  {typeof recognizedText === "string" && recognizedText ? (
                    <p className="break-words text-sm text-muted">
                      ViRead nhận diện: “{recognizedText}”
                    </p>
                  ) : null}
                  <p className="hidden text-xs text-muted md:block">
                    Mã trang {event.page_id} · phiên bản{" "}
                    <code className="break-all">{event.page_revision_id}</code>
                  </p>
                  <details className="group/meta md:hidden">
                    <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
                      <span>Mã đối chiếu kỹ thuật</span>
                      <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 shrink-0 transition-transform group-open/meta:rotate-180"
                      />
                    </summary>
                    <div className="mt-1 space-y-0.5 rounded-control bg-canvas px-2.5 py-2 text-xs text-muted">
                      <p>
                        Mã trang:{" "}
                        <code className="break-all">{event.page_id}</code>
                      </p>
                      <p>
                        Phiên bản:{" "}
                        <code className="break-all">
                          {event.page_revision_id}
                        </code>
                      </p>
                    </div>
                  </details>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      {readingEvents.length > 0 ? (
        <section
          aria-label="Sự kiện lượt đọc đầu"
          className="flex flex-col gap-2.5"
        >
          {retryEvents.length > 0 ? (
            <h3 className="text-base font-extrabold text-ink">
              Sự kiện lượt đọc đầu
            </h3>
          ) : null}
          <ol className="divide-y divide-border rounded-control border border-border bg-white">
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
                <li className="space-y-1.5 p-3.5 md:p-4" key={event.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-bold text-ink">
                      {eventLabels[event.type]}
                    </p>
                    <span
                      className={`rounded-control px-2.5 py-0.5 text-xs font-bold ${eventStatusBadgeClass(event.status)}`}
                    >
                      {statusLabels[event.status]}
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    Mốc{" "}
                    <span className="font-bold tabular-nums text-ink">
                      {Math.round(event.start_ms / 1000)} giây
                    </span>
                    <span className="hidden md:inline">
                      {" "}
                      · phiên bản{" "}
                      <code className="break-all">
                        {event.page_revision_id}
                      </code>
                    </span>
                  </p>
                  <p className="text-xs font-semibold text-muted">
                    {countsAsError
                      ? "Bằng chứng lỗi đã xác nhận."
                      : "Sự kiện hỗ trợ hoặc chưa chắc chắn, không tính là lỗi của bé."}
                  </p>
                  <details className="group/meta md:hidden">
                    <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-xs font-semibold text-muted hover:text-ink [&::-webkit-details-marker]:hidden">
                      <span>Mã đối chiếu kỹ thuật</span>
                      <ChevronDown
                        aria-hidden="true"
                        className="size-3.5 shrink-0 transition-transform group-open/meta:rotate-180"
                      />
                    </summary>
                    <p className="mt-1 rounded-control bg-canvas px-2.5 py-2 text-xs text-muted">
                      Phiên bản:{" "}
                      <code className="break-all">
                        {event.page_revision_id}
                      </code>
                    </p>
                  </details>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
