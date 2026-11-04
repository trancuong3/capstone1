
"use client";

import { useEffect, useState } from "react";

import {
  getReadingPage,
  type ReadingPage,
  type ComparisonResult,
} from "@/lib/api/comparison-service";

import { BookPageContent } from "@/components/reading/book-page-content";
import {
  normalizeRealtimeForAmbiguity,
  normalizeRealtimeWord,
} from "@/lib/reading/realtime-alignment";

type Props = {
  result: Pick<
    ComparisonResult,
    "alignment" | "summary" | "page_id" | "page_revision_id"
  >;
  sessionId: string;
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
  ambiguous: "border-slate-500 bg-slate-100",
};

function isHesitation(value: unknown): value is Hesitation {
  if (typeof value !== "object" || value === null) return false;

  const item = value as Record<string, unknown>;

  return (
    typeof item.after_word === "string" &&
    typeof item.before_word === "string" &&
    typeof item.pause === "number"
  );
}



export function ReadingReport({ result, sessionId }: Props) {
  const [page, setPage] = useState<ReadingPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  

  useEffect(() => {
    let cancelled = false;

    async function loadPage() {
      try {
        setPageError(null);

        const data = await getReadingPage(
          result.page_id,
          sessionId,
          result.page_revision_id,
        );

        if (!cancelled) {
          setPage(data);
        }
      } catch (error) {
        if (!cancelled) {
          setPageError(
            error instanceof Error
              ? error.message
              : "Không thể tải nội dung trang sách.",
          );
        }
      }
    }

    loadPage();

    return () => {
      cancelled = true;
    };
  }, [result.page_id, result.page_revision_id, sessionId]);

  // Thống kê kết quả đọc
  const correctCount = result.alignment.filter(
    (item) => item.status === "MATCH",
  ).length;

  const missingCount = result.summary.missing_words.length;
  const extraCount = result.summary.extra_words.length;

  // Older saved reports may still store orthographic-only differences as
  // SUBSTITUTE. Reinterpret only these narrow Vietnamese STT ambiguities;
  // keep every other substitution as a candidate reading error.
  const isOrthographicAmbiguity = (item: (typeof result.alignment)[number]) =>
    item.status === "AMBIGUOUS" ||
    (item.status === "SUBSTITUTE" &&
      typeof item.book_word === "string" &&
      typeof item.spoken_word === "string" &&
      normalizeRealtimeWord(item.book_word) !==
        normalizeRealtimeWord(item.spoken_word) &&
      normalizeRealtimeForAmbiguity(item.book_word) ===
        normalizeRealtimeForAmbiguity(item.spoken_word));

  const ambiguousAlignment = result.alignment.filter(isOrthographicAmbiguity);
  const ambiguousPairs = new Set(
    ambiguousAlignment.map((item) =>
      JSON.stringify([
        item.book_index,
        item.book_word ?? "",
        item.spoken_word ?? "",
      ]),
    ),
  );
  const wrongCount = result.summary.substitutions.filter(
    (item) =>
      !ambiguousPairs.has(
        JSON.stringify([
          item.book_index ?? null,
          item.book_word,
          item.spoken_word,
        ]),
      ),
  ).length;
  const ambiguousCount = ambiguousAlignment.length;

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

  return (
    <div className="space-y-5 rounded-xl border p-4">
      <h2 className="text-xl font-bold">Báo cáo đọc</h2>

      {/* Nội dung bài đọc */}
      <div className="space-y-3 border-t pt-3">
        <h3 className="font-semibold">Nội dung bài đọc</h3>

        {pageError ? (
          <p className="text-sm text-red-600">{pageError}</p>
        ) : !page ? (
          <p className="text-sm text-muted">
            Đang tải nội dung bài đọc...
          </p>
        ) : (
          <article
            className="relative min-h-[552px] w-full overflow-hidden rounded-[8px] bg-cream p-4 shadow-[0_8px_24px_rgba(33,61,66,0.06)] sm:aspect-[3/2] sm:min-h-0 sm:max-w-[1008px] sm:p-8"
            data-page-id={page.page_id}
            data-page-revision-id={page.page_revision_id}
          >
            <div className="relative z-10 flex h-full flex-col">
              <header className="mb-2 flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-800">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  Nội dung OCR đã xác minh
                </span>

                <span className="text-label text-muted">
                  Trang {page.page_number}
                </span>
              </header>

              <BookPageContent
                page={page}
                comparisonResult={result}
                readOnly
              />

              <p className="mt-2 text-right text-label text-muted">
                {page.page_number}
              </p>
            </div>
          </article>
        )}
      </div>

      {/* Thống kê */}
      <div
        aria-label="Thống kê kết quả đọc"
        className="grid grid-cols-2 gap-4"
        role="group"
      >
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
          <p className="text-slate-700">Chưa đủ bằng chứng</p>
          <p className="text-2xl font-bold">{ambiguousCount}</p>
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
          ["Chưa đủ bằng chứng", COLORS.ambiguous],
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
        {ambiguousCount > 0 && missingCount === 0 && wrongCount === 0
          ? "Một số từ chưa đủ bằng chứng do khác biệt nhận dạng tiếng Việt. Hệ thống không tự kết luận bé đọc sai."
          : missingCount === 0 && wrongCount === 0 && ambiguousCount === 0
            ? "Bé đã đọc đúng nội dung bài."
            : "Bé đã đọc một phần bài. Hãy tiếp tục luyện đọc những từ còn thiếu nhé."}
      </p>
    </div>
  );
}
