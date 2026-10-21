"use client";

import type { ComparisonResult } from "@/lib/api/comparison-service";

type Props = {
  result: ComparisonResult;
};

export function ReadingReport({ result }: Props) {
  const correctCount = result.alignment.filter(
    (item) => item.status === "MATCH"
  ).length;

  const missingCount = result.summary.missing_words.length;
  const extraCount = result.summary.extra_words.length;
  const wrongCount = result.summary.substitutions.length;

  return (
    <div className="rounded-xl border p-4 space-y-4">
      <h2 className="text-xl font-bold">Báo cáo đọc</h2>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p>Từ đọc đúng</p>
          <p className="text-2xl font-bold">{correctCount}</p>
        </div>

        <div>
          <p>Từ chưa đọc</p>
          <p className="text-2xl font-bold">{missingCount}</p>
        </div>

        <div>
          <p>Từ đọc thêm</p>
          <p className="text-2xl font-bold">{extraCount}</p>
        </div>

        <div>
          <p>Từ đọc nhầm</p>
          <p className="text-2xl font-bold">{wrongCount}</p>
        </div>
      </div>

      <p>
        {missingCount === 0 && wrongCount === 0
          ? "Bé đã đọc đúng nội dung bài."
          : "Bé đã đọc một phần bài. Hãy tiếp tục luyện đọc những từ còn thiếu nhé."}
      </p>
    </div>
  );
}