import type { ReadingAssessmentMetricsDTO } from "@/types/reading";

export function ReadingAssessmentSummary({
  assessment,
}: {
  readonly assessment?: ReadingAssessmentMetricsDTO | null;
}) {
  if (!assessment) return null;
  const metrics = [
    ["Đúng lượt đầu", assessment.first_pass_correct],
    ["Cần luyện ở lượt đầu", assessment.first_pass_incorrect],
    ["Bé đã tự sửa đúng", assessment.self_corrected_words],
    ["Còn cần luyện", assessment.unresolved_words],
    ["Lượt luyện đã nhận diện", assessment.retry_attempts],
    ["Đã luyện đủ ba lần", assessment.skipped_after_retry_limit],
    ["Chưa nghe rõ", assessment.recognition_uncertain],
  ] as const;
  return (
    <section
      aria-label="Kết quả lượt đầu và luyện lại"
      className="rounded-card border border-border bg-white p-4"
    >
      <h3 className="font-extrabold text-ink">
        Lượt đọc đầu và phần luyện thêm
      </h3>
      <p className="mt-1 text-sm text-muted">
        Tự sửa đúng được ghi nhận riêng và không thay đổi kết quả lượt đầu.
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        {metrics.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="text-xl font-extrabold text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
