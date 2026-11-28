"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";

import { fetchAuthenticatedBlobUrl } from "@/lib/api/api-client";
import {
  type CoReadingService,
  type DialogueTurnDTO,
  type NarrationMetaDTO,
  type ParseScriptResponseDTO,
  createCoReadingService,
} from "@/lib/api/co-reading-service";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CoReadingRolePlayModalProps {
  childId: string;
  bookId?: string;
  pageId?: string;
  pageText?: string;
  teacherVoiceId?: string;
  onClose?: () => void;
  /** Override for testing */
  service?: CoReadingService;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function TurnBadge({ owner }: { owner: "AI_OR_PARENT" | "CHILD" }) {
  if (owner === "CHILD") {
    return (
      <span className="inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">
        🧒 Lượt Con
      </span>
    );
  }
  return (
    <span className="inline-block rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-800">
      📖 Ba Mẹ / AI Đọc
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const map: Record<string, string> = {
    NARRATOR: "🎙 Người Dẫn",
    CHARACTER_A: "🌸 Nhân Vật A",
    CHARACTER_B: "🌿 Nhân Vật B",
  };
  return (
    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
      {map[role] ?? role}
    </span>
  );
}

function TurnCard({ turn }: { turn: DialogueTurnDTO }) {
  const isChild = turn.turn_owner === "CHILD";
  return (
    <div
      className={`rounded-xl border p-3 ${
        isChild ? "border-amber-200 bg-amber-50" : "border-sky-100 bg-sky-50"
      }`}
      data-testid={`turn-card-${turn.index}`}
    >
      <div className="mb-1 flex items-center gap-2">
        <TurnBadge owner={turn.turn_owner} />
        <RoleBadge role={turn.role} />
        <span className="text-xs text-gray-500">{turn.speaker_label}</span>
      </div>
      <p className="text-sm leading-relaxed text-gray-800">{turn.text}</p>
      {isChild && turn.coaching_prompt_vi && (
        <p className="mt-1.5 text-xs font-medium text-amber-700">
          💬 {turn.coaching_prompt_vi}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Narration recorder (parent-side)
// ---------------------------------------------------------------------------

interface NarrationRecorderProps {
  bookId: string;
  pageId: string;
  existingMeta: NarrationMetaDTO | null;
  service: CoReadingService;
  onUpdated: (meta: NarrationMetaDTO | null) => void;
}

function NarrationRecorder({
  bookId,
  pageId,
  existingMeta,
  service,
  onUpdated,
}: NarrationRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  // Track whether a local recording blob exists (safe to use in render)
  const [hasLocalAudio, setHasLocalAudio] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioBlobRef = useRef<Blob | null>(null);

  // Stream private audio if already recorded
  useEffect(() => {
    if (!existingMeta?.audio_endpoint) return;
    let cancelled = false;
    fetchAuthenticatedBlobUrl(existingMeta.audio_endpoint)
      .then((url) => {
        if (!cancelled) setBlobUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [existingMeta?.audio_endpoint]);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        audioBlobRef.current = blob;
        const preview = URL.createObjectURL(blob);
        setBlobUrl(preview);
        setHasLocalAudio(true);
        stream.getTracks().forEach((t) => t.stop());
      };
      mr.start();
      mediaRef.current = mr;
      setRecording(true);
    } catch {
      setError("Không thể truy cập micro. Vui lòng cấp quyền.");
    }
  }, []);

  const stopRecording = useCallback(() => {
    mediaRef.current?.stop();
    setRecording(false);
  }, []);

  const uploadNarration = useCallback(async () => {
    if (!audioBlobRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const file = new File([audioBlobRef.current], "narration.webm", {
        type: "audio/webm",
      });
      const meta = await service.uploadNarration(bookId, pageId, file);
      setHasLocalAudio(false);
      audioBlobRef.current = null;
      onUpdated(meta);
    } catch {
      setError("Không thể tải lên. Vui lòng thử lại.");
    } finally {
      setSaving(false);
    }
  }, [bookId, pageId, service, onUpdated]);

  const deleteNarration = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await service.deleteNarration(bookId, pageId);
      setBlobUrl(null);
      setHasLocalAudio(false);
      audioBlobRef.current = null;
      onUpdated(null);
    } catch {
      setError("Không thể xóa. Vui lòng thử lại.");
    } finally {
      setSaving(false);
    }
  }, [bookId, pageId, service, onUpdated]);

  return (
    <div className="rounded-xl border border-rose-100 bg-rose-50 p-3">
      <p className="mb-2 text-sm font-semibold text-rose-700">
        🎤 Giọng Ba Mẹ Kể Chuyện
      </p>
      {error && (
        <p className="mb-2 text-xs text-red-600" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {!recording ? (
          <button
            type="button"
            onClick={startRecording}
            disabled={saving}
            className="rounded-lg bg-rose-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-600 disabled:opacity-50"
          >
            ● Ghi âm
          </button>
        ) : (
          <button
            type="button"
            onClick={stopRecording}
            className="rounded-lg bg-gray-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700"
          >
            ■ Dừng
          </button>
        )}

        {blobUrl && !recording && (
          <audio
            src={blobUrl}
            controls
            className="h-8 max-w-[200px]"
            data-testid="narration-audio"
          >
            <track kind="captions" />
          </audio>
        )}

        {hasLocalAudio && !recording && (
          <button
            type="button"
            onClick={uploadNarration}
            disabled={saving}
            className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {saving ? "Đang lưu..." : "💾 Lưu"}
          </button>
        )}

        {existingMeta && !hasLocalAudio && (
          <>
            <span className="text-xs text-green-700">
              ✓ Đã có giọng Ba Mẹ kể
            </span>
            <button
              type="button"
              onClick={deleteNarration}
              disabled={saving}
              className="rounded-lg bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-300 disabled:opacity-50"
              data-testid="delete-narration-btn"
            >
              Xóa
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export function CoReadingRolePlayModal({
  childId,
  bookId,
  pageId,
  pageText,
  teacherVoiceId,
  onClose,
  service: injectedService,
}: CoReadingRolePlayModalProps) {
  const service = injectedService ?? createCoReadingService();

  // Start with loading=true so we never flash "empty" before the first fetch
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scriptData, setScriptData] = useState<ParseScriptResponseDTO | null>(
    null,
  );
  const [narrationMeta, setNarrationMeta] = useState<NarrationMetaDTO | null>(
    null,
  );

  useEffect(() => {
    const ac = new AbortController();

    // Reset state for new child/page — done inside callbacks to avoid
    // synchronous setState-in-effect lint violation
    service
      .parseScript(
        childId,
        {
          page_text: pageText,
          book_id: bookId,
          page_id: pageId,
          teacher_voice_id: teacherVoiceId,
        },
        ac.signal,
      )
      .then((data) => {
        setScriptData(data);
        setError(null);
        setLoading(false);
        if (bookId && pageId) {
          return service
            .getNarrationMeta(bookId, pageId, ac.signal)
            .then((m) => setNarrationMeta(m))
            .catch(() => {}); // 404 means none yet — not an error
        }
      })
      .catch((e: Error) => {
        if (e.name !== "AbortError") {
          setError("Không thể tải dữ liệu. Vui lòng thử lại.");
          setLoading(false);
        }
      });

    return () => ac.abort();
  }, [childId, bookId, pageId, pageText, teacherVoiceId, service]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="co-reading-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b p-4">
          <h2
            id="co-reading-title"
            className="text-base font-bold text-gray-800"
          >
            📖 Đọc Cùng Con — Phân Vai
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="rounded-full p-1.5 text-gray-500 hover:bg-gray-100"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {loading && (
            <p className="text-center text-sm text-gray-500">
              Đang phân tích lượt đọc...
            </p>
          )}

          {error && !loading && (
            <p className="text-center text-sm text-red-600" role="alert">
              {error}
            </p>
          )}

          {scriptData && !loading && (
            <div className="space-y-3">
              {/* Character voices info */}
              {scriptData.has_dialogue && (
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-2 text-xs text-gray-600">
                  <span className="font-semibold">Phân vai: </span>
                  {Object.entries(scriptData.character_voices).map(
                    ([role, voiceId]) => (
                      <span key={role} className="mr-2">
                        {role === "CHARACTER_A" ? "🌸" : "🌿"} {role}: {voiceId}
                      </span>
                    ),
                  )}
                </div>
              )}

              {/* Turns */}
              <div className="space-y-2" data-testid="turns-list">
                {scriptData.turns.map((turn) => (
                  <TurnCard key={turn.index} turn={turn} />
                ))}
              </div>

              {/* Parent narration recorder (only if book+page available) */}
              {bookId && pageId && (
                <NarrationRecorder
                  bookId={bookId}
                  pageId={pageId}
                  existingMeta={narrationMeta}
                  service={service}
                  onUpdated={setNarrationMeta}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default CoReadingRolePlayModal;
