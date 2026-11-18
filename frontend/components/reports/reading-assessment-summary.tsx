import type { ReadingAssessmentMetricsDTO } from "@/types/reading";

export function ReadingAssessmentSummary({
  assessment,
}: {
  readonly assessment?: ReadingAssessmentMetricsDTO | null;
}) {
  if (!assessment) return null;
  const groups = [
    {
      title: "Đánh giá lượt đầu",
      metrics: [
        ["Đúng lượt đầu", assessment.first_pass_correct],
        ["Cần luyện ở lượt đầu", assessment.first_pass_incorrect],
      ],
    },
    {
      title: "Luyện thêm",
      metrics: [
        ["Bé đã tự sửa đúng", assessment.self_corrected_words],
        ["Còn cần luyện", assessment.unresolved_words],
        ["Lượt luyện đã nhận diện", assessment.retry_attempts],
        ["Đã luyện đủ ba lần", assessment.skipped_after_retry_limit],
        ["Chưa nghe rõ", assessment.recognition_uncertain],
      ],
    },
  ] as const;
  return (
    <section
      aria-label="Kết quả lượt đầu và luyện lại"
      className="rounded-control bg-cream p-4"
    >
      <h3 className="font-bold text-ink">Lượt đọc đầu và phần luyện thêm</h3>
      <p className="mt-1 text-sm text-muted">
        Tự sửa đúng được ghi nhận riêng và không thay đổi kết quả lượt đầu.
      </p>
      <div className="mt-4 grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]">
        {groups.map(({ title, metrics }) => (
          <div
            key={title}
            className="rounded-control border border-border bg-white p-3"
          >
            <h4 className="text-sm font-extrabold text-primary">{title}</h4>
            <dl className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(min(100%,88px),1fr))] gap-x-3 gap-y-2">
              {metrics.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-sm leading-snug text-muted">{label}</dt>
                  <dd className="mt-1 text-xl font-extrabold text-ink">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
