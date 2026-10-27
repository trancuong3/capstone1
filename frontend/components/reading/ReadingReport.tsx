"use client";

import type { ComparisonResult } from "@/lib/api/comparison-service";

type BookWord = {
  text: string;
  word_index?: number;
  word_id?: string;
};

type Props = {
  result: ComparisonResult;
  bookWords?: readonly BookWord[];
};

type Hesitation = {
  after_word: string;
  before_word: string;
  pause: number;
};

const COLORS = {
  correct: "border-green-500 bg-green-100",
  missing: "border-red-500 bg-red-100",
  wrong: "border-orange-500 bg-orange-100",
  hesitation: "border-blue-500 bg-blue-100",
  repeated: "border-purple-500 bg-purple-100",
};

function getWordColor(
  status: string,
  isRepeated: boolean,
  isHesitation: boolean,
) {
  if (status === "DELETE") return COLORS.missing;
  if (status === "SUBSTITUTE") return COLORS.wrong;
  if (isRepeated) return COLORS.repeated;
  if (isHesitation) return COLORS.hesitation;
  if (status === "MATCH") return COLORS.correct;

  return "";
}

function isHesitation(value: unknown): value is Hesitation {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.after_word === "string" &&
    typeof item.before_word === "string" &&
    typeof item.pause === "number"
  );
}

export function ReadingReport({ result, bookWords = [] }: Props) {
  const correctCount = result.alignment.filter(
    (item) => item.status === "MATCH",
  ).length;

  const missingCount = result.summary.missing_words.length;
  const extraCount = result.summary.extra_words.length;
  const wrongCount = result.summary.substitutions.length;

  const repeatedWordCounts = result.summary.repeated_words.reduce<
    Record<string, number>
  >((counts, word) => {
    counts[word] = (counts[word] ?? 0) + 1;
    return counts;
  }, {});

  const repeatedWords = Object.entries(repeatedWordCounts);
  const repeatedCount = result.summary.repeated_words.length;

  const hesitations = result.summary.hesitations.filter(isHesitation);
  const hesitationSeconds = result.summary.hesitation_seconds;

  // Xác định các vị trí từ bị lặp trong đoạn căn chỉnh.
  const repeatedBookIndexes = new Set<number>();

  for (const item of result.alignment) {
    if (
      item.status !== "INSERT" ||
      item.spoken_word === null ||
      !result.summary.repeated_words.includes(item.spoken_word)
    ) {
      continue;
    }

    const neighbor = result.alignment.find(
      (candidate) =>
        candidate.status === "MATCH" &&
        candidate.book_word === item.spoken_word &&
        candidate.spoken_index !== null &&
        Math.abs(candidate.spoken_index - (item.spoken_index ?? -100)) === 1,
    );

    if (neighbor?.book_index !== null && neighbor?.book_index !== undefined) {
      repeatedBookIndexes.add(neighbor.book_index);
    }
  }

  // Tô xanh dương từ đứng trước khoảng ngập ngừng.
  const hesitationWords = new Set(
    hesitations.map((item) => item.after_word.toLocaleLowerCase("vi")),
  );

  // Lấy trạng thái căn chỉnh theo vị trí từ trong sách.
  const alignmentByIndex = new Map(
    result.alignment
      .filter((item) => item.book_index !== null)
      .map((item) => [item.book_index as number, item]),
  );

  return (
    <div className="space-y-5 rounded-xl border p-4">
      <h2 className="text-xl font-bold">Báo cáo đọc</h2>

      {/* Thống kê */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-green-700">Từ đọc đúng</p>
          <p className="text-2xl font-bold">{correctCount}</p>
        </div>

        <div>
          <p className="text-red-600">Từ bỏ</p>
          <p className="text-2xl font-bold">{missingCount}</p>
        </div>

        <div>
          <p className="text-orange-600">Từ đọc nhầm</p>
          <p className="text-2xl font-bold">{wrongCount}</p>
        </div>

        <div>
          <p className="text-purple-700">Từ đọc thêm</p>
          <p className="text-2xl font-bold">{extraCount}</p>
        </div>

        <div>
          <p className="text-purple-700">Lặp từ</p>
          <p className="text-2xl font-bold">{repeatedCount}</p>
        </div>

        <div>
          <p className="text-blue-700">Khoảng ngập ngừng</p>
          <p className="text-2xl font-bold">{hesitations.length}</p>
        </div>
      </div>

      {/* Chú giải màu */}
      <div className="flex flex-wrap gap-2 border-t pt-3 text-sm">
        {[
          ["Đọc đúng", COLORS.correct],
          ["Bỏ từ", COLORS.missing],
          ["Đọc nhầm", COLORS.wrong],
          ["Ngập ngừng", COLORS.hesitation],
          ["Lặp từ", COLORS.repeated],
        ].map(([label, color]) => (
          <span
            key={label}
            className={`rounded border px-2 py-1 ${color}`}
          >
            {label}
          </span>
        ))}
      </div>

      {/* Chi tiết lặp từ */}
      <div className="space-y-2 border-t pt-3">
        <h3 className="font-semibold">Tình trạng lặp từ</h3>

        <p>
          Tổng số lần lặp từ: <strong>{repeatedCount}</strong>
        </p>

        {repeatedWords.length > 0 ? (
          <ul className="list-disc pl-5">
            {repeatedWords.map(([word, count]) => (
              <li key={word}>
                <span className="rounded border border-purple-500 bg-purple-100 px-1">
                  {word}
                </span>
                {" "}được ghi nhận {count} lần trong danh sách lặp.
              </li>
            ))}
          </ul>
        ) : (
          <p>Không phát hiện từ bị lặp.</p>
        )}
      </div>

      {/* Chi tiết ngập ngừng */}
      <div className="space-y-2 border-t pt-3">
        <h3 className="font-semibold">Tình trạng ngập ngừng</h3>

        <p>
          Tổng thời gian ngập ngừng:{" "}
          <strong>
            {hesitationSeconds == null
              ? "Chưa có dữ liệu"
              : `${hesitationSeconds.toFixed(2)} giây`}
          </strong>
        </p>

        {hesitations.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5">
            {hesitations.map((item, index) => (
              <li key={`${item.after_word}-${item.before_word}-${index}`}>
                <span className="rounded border border-blue-500 bg-blue-100 px-1">
                  {item.after_word}
                </span>
                {" → "}
                {item.before_word}: dừng {item.pause.toFixed(2)} giây
              </li>
            ))}
          </ul>
        ) : (
          <p>Chưa phát hiện khoảng ngập ngừng.</p>
        )}
      </div>

      <p>
        {missingCount === 0 && wrongCount === 0
          ? "Bé đã đọc đúng nội dung bài."
          : "Bé đã đọc một phần bài. Hãy tiếp tục luyện đọc những từ còn thiếu nhé."}
      </p>
    </div>
  );
}