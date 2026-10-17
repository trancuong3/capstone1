"use client";

import { BookOpen, RefreshCw, Sparkles, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/common/button";
import { Modal } from "@/components/common/modal";
import { StatusMessage } from "@/components/common/status-message";
import { useAiTutor } from "@/hooks/use-ai-tutor";
import { useSpeechPlayer } from "@/hooks/use-speech-player";
import type { TutorService } from "@/lib/api/tutor-service";
import type { TutorWordSelection } from "@/types/tutor";

interface AiTutorPanelProps {
  disabled?: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  onContinue: () => void;
  selection: TutorWordSelection | null;
  service: TutorService;
  sessionId: string;
}

export function AiTutorPanel({
  disabled = false,
  onOpen,
  onDismiss,
  onContinue,
  selection,
  service,
  sessionId,
}: AiTutorPanelProps) {
  const tutor = useAiTutor(service, sessionId, selection);
  const player = useSpeechPlayer();
  const [isPreparingAudio, setIsPreparingAudio] = useState(false);
  const [audioFailed, setAudioFailed] = useState(false);
  const playbackRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(
    () => () => {
      generationRef.current += 1;
      onDismiss();
    },
    [onDismiss],
  );

  function close(resume: boolean) {
    generationRef.current += 1;
    playbackRef.current = false;
    player.stop();
    tutor.close();
    setIsPreparingAudio(false);
    setAudioFailed(false);
    if (resume) onContinue();
    else onDismiss();
  }

  async function listen() {
    if (tutor.state.status !== "ready" || playbackRef.current) return;
    if (player.isPlaying) {
      player.stop();
      return;
    }
    const generation = generationRef.current;
    playbackRef.current = true;
    setIsPreparingAudio(true);
    setAudioFailed(false);
    try {
      await player.play(
        `${tutor.state.result.explanation} ${tutor.state.result.reading_hint}`,
      );
    } catch {
      if (generationRef.current === generation) setAudioFailed(true);
    } finally {
      if (generationRef.current === generation) {
        playbackRef.current = false;
        setIsPreparingAudio(false);
      }
    }
  }

  return (
    <section
      aria-label="Trợ giảng đọc sách"
      className="mx-auto w-full max-w-[1008px] rounded-card bg-white p-4 sm:p-6 [&_[aria-label='Đóng_hộp_thoại']]:w-12"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-label font-bold text-primary">
            <Sparkles aria-hidden="true" className="size-5" /> Bạn trợ giảng
          </p>
          <p className="mt-2 break-words text-body text-ink">
            {selection ? (
              <>
                Từ bé chọn: <strong>{selection.word}</strong>
              </>
            ) : (
              "Bé chọn một từ trên trang để mình giải thích nhé."
            )}
          </p>
        </div>
        <Button
          className="sm:w-auto sm:shrink-0"
          disabled={disabled || !selection}
          onClick={() => {
            onOpen();
            void tutor.request();
          }}
          variant="secondary"
        >
          <BookOpen aria-hidden="true" className="size-5" /> Giải thích từ
        </Button>
      </div>

      <Modal
        isOpen={tutor.isOpen}
        title="Mình cùng hiểu từ này nhé!"
        onClose={() => close(false)}
      >
        <p className="mb-4 break-words text-heading font-extrabold text-primary">
          {selection?.word}
        </p>
        {tutor.state.status === "loading" ? (
          <p aria-live="polite" className="text-body text-muted" role="status">
            Mình đang tìm cách giải thích cho bé…
          </p>
        ) : tutor.state.status === "ready" ? (
          <div
            className="space-y-4 break-words text-body text-ink"
            aria-live="polite"
          >
            <p>{tutor.state.result.explanation}</p>
            <p className="rounded-card bg-sky p-4">
              {tutor.state.result.reading_hint}
            </p>
            {audioFailed ? (
              <StatusMessage tone="info">
                Mình chưa phát được âm thanh. Bé vẫn có thể đọc lời giải thích ở
                trên nhé.
              </StatusMessage>
            ) : null}
            <Button
              disabled={isPreparingAudio}
              isLoading={isPreparingAudio}
              onClick={() => void listen()}
              variant="secondary"
            >
              {player.isPlaying ? (
                <VolumeX aria-hidden="true" className="size-5" />
              ) : (
                <Volume2 aria-hidden="true" className="size-5" />
              )}
              {isPreparingAudio
                ? "Đang chuẩn bị âm thanh"
                : player.isPlaying
                  ? "Dừng giải thích"
                  : "Nghe giải thích"}
            </Button>
          </div>
        ) : tutor.state.status === "error" ? (
          <div className="space-y-4">
            <StatusMessage tone="info">{tutor.state.message}</StatusMessage>
            {tutor.state.retryable ? (
              <Button onClick={() => void tutor.request()} variant="secondary">
                <RefreshCw aria-hidden="true" className="size-5" />
                Thử lại
              </Button>
            ) : null}
          </div>
        ) : null}
        <Button className="mt-6" onClick={() => close(true)}>
          Đọc tiếp
        </Button>
      </Modal>
    </section>
  );
}
