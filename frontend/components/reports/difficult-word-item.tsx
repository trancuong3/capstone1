"use client";

import { Volume2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useReportServices } from "@/hooks/use-report-services";
import type { DifficultWordDTO } from "@/types/reports";

interface DifficultWordItemProps {
  readonly childId: string;
  readonly word: DifficultWordDTO;
}

export function DifficultWordItem({ childId, word }: DifficultWordItemProps) {
  const { difficultWordService } = useReportServices();
  const [isPracticing, setIsPracticing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function practice(): Promise<void> {
    if (isPracticing) return;
    setIsPracticing(true);
    setMessage(null);
    try {
      const result = await difficultWordService.practice(
        childId,
        word.normalized_word,
      );
      setMessage(result.message);
    } catch {
      setMessage("Chưa thể mở phần luyện từ. Ba mẹ vui lòng thử lại.");
    } finally {
      setIsPracticing(false);
    }
  }

  return (
    <article className="rounded-card bg-white p-5 shadow-[0_12px_32px_rgba(33,65,86,0.06)] sm:p-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-[30px] font-extrabold leading-tight text-ink">
              {word.display_text}
            </h2>
            <span className="rounded-full bg-warning-surface px-3 py-1 text-label font-bold text-warning">
              Điểm bằng chứng {word.difficulty_score}
            </span>
          </div>
          <p className="mt-2 text-label text-muted">
            {word.session_count} buổi · bỏ sót {word.omission_count} · lặp{" "}
            {word.repetition_count} · dừng lâu {word.long_pause_count} · đọc mẫu{" "}
            {word.read_example_count}
          </p>
          <p className="mt-1 text-label text-muted">
            {word.evidence_word_ids.length} bằng chứng gắn với từ trong
            revision.
          </p>
        </div>
        <Button
          className="sm:w-auto sm:min-w-44"
          isLoading={isPracticing}
          onClick={() => void practice()}
          variant="secondary"
        >
          <Volume2 aria-hidden="true" className="size-5" />
          Luyện từ
        </Button>
      </div>
      {message ? (
        <StatusMessage className="mt-5" title="Gợi ý luyện tập">
          {message} Đây là mô phỏng chữ, không phát TTS thật và không thêm bằng
          chứng.
        </StatusMessage>
      ) : null}
    </article>
  );
}
