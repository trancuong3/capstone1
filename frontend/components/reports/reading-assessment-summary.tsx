import { cn } from "@/lib/utils/cn";
import type { ReadingAssessmentMetricsDTO } from "@/types/reading";

export function ReadingAssessmentSummary({
  assessment,
  scopeLabel,
  embedded = false,
}: {
  readonly assessment?: ReadingAssessmentMetricsDTO | null;
  readonly scopeLabel?: string;
  readonly embedded?: boolean;
}) {
  if (!assessment) return null;

  const firstPassTotal =
    assessment.first_pass_correct + assessment.first_pass_incorrect;
  const firstPassCorrectPct =
    firstPassTotal > 0
      ? Math.round((assessment.first_pass_correct / firstPassTotal) * 100)
      : null;

  const retryMetrics = [
    {
      label: "Bé đã tự sửa đúng",
      value: assessment.self_corrected_words,
      valueClass: "text-success-ink",
    },
    {
      label: "Còn cần luyện",
      value: assessment.unresolved_words,
      valueClass: assessment.unresolved_words > 0 ? "text-danger" : "text-ink",
    },
    {
      label: "Lượt luyện đã nhận diện",
      value: assessment.retry_attempts,
      valueClass: "text-ink",
    },
    {
      label: "Đã luyện đủ ba lần",
      value: assessment.skipped_after_retry_limit,
      valueClass: "text-ink",
    },
  ] as const;

  return (
    <section
      aria-label="Kết quả lượt đầu và luyện lại"
      className={cn(
        "border border-border",
        embedded ? "rounded-control bg-canvas/55" : "rounded-card bg-white",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3.5 sm:px-6">
        <div>
          <h3 className="text-lg font-extrabold text-ink">
            Lượt đọc đầu và phần luyện thêm
          </h3>
          <p className="mt-0.5 text-sm text-muted">
            Tự sửa đúng được ghi nhận riêng và không thay đổi kết quả lượt đầu.
          </p>
        </div>
        {scopeLabel ? (
          <span className="rounded-control bg-canvas px-2.5 py-1 text-xs font-bold text-muted ring-1 ring-inset ring-border">
            {scopeLabel}
          </span>
        ) : null}
      </div>

      <div className="grid divide-y divide-border lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:divide-x lg:divide-y-0">
        <div className="flex flex-col justify-between gap-4 p-4 sm:p-5">
          <div>
            <h4 className="text-xs font-extrabold tracking-wide text-primary">
              Đánh giá lượt đầu
            </h4>
            <dl className="mt-3 grid grid-cols-2 gap-4">
              <div>
                <dt className="text-sm text-muted">Đúng lượt đầu</dt>
                <dd className="mt-1 text-2xl font-extrabold tabular-nums text-success-ink">
                  {assessment.first_pass_correct}
                </dd>
              </div>
              <div>
                <dt className="text-sm text-muted">Cần luyện ở lượt đầu</dt>
                <dd className="mt-1 text-2xl font-extrabold tabular-nums text-ink">
                  {assessment.first_pass_incorrect}
                </dd>
              </div>
            </dl>
          </div>
          {firstPassCorrectPct !== null ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-semibold text-muted">
                <span>Tỷ lệ đúng lượt đầu</span>
                <span className="tabular-nums text-ink">
                  {firstPassCorrectPct}% ({assessment.first_pass_correct}/
                  {firstPassTotal} từ)
                </span>
              </div>
              <div
                aria-hidden="true"
                className="flex h-2 w-full overflow-hidden rounded-full bg-danger-surface"
              >
                <div
                  className="h-full bg-primary"
                  style={{ width: `${firstPassCorrectPct}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col justify-between gap-4 p-4 sm:p-5">
          <div>
            <h4 className="text-xs font-extrabold tracking-wide text-primary">
              Luyện thêm
            </h4>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              {retryMetrics.map(({ label, value, valueClass }) => (
                <div key={label}>
                  <dt className="text-xs leading-snug text-muted">{label}</dt>
                  <dd
                    className={`mt-1 text-xl font-extrabold tabular-nums ${valueClass}`}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-control bg-canvas px-3.5 py-2.5 text-sm ring-1 ring-inset ring-border/80">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold text-muted">Chưa nghe rõ</span>
              <span className="text-base font-extrabold tabular-nums text-ink">
                {assessment.recognition_uncertain}
              </span>
            </div>
            <span className="text-xs text-muted">
              Ghi nhận riêng, không tính là lỗi phát âm đã xác nhận.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
