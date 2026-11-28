import { getBrowserAccessToken } from "@/lib/api/browser-auth";
import { ServiceError } from "@/lib/api/service-error";
import { getApiBaseUrl } from "@/lib/supabase/config";

export interface ParentPinStatusDTO {
  readonly has_pin: boolean;
  readonly child_mode_default: boolean;
  readonly is_locked_out: boolean;
  readonly locked_until: string | null;
  readonly remaining_attempts: number;
  readonly storage_ready: boolean;
}

export interface ParentPinVerifyResponseDTO {
  readonly verified: boolean;
  readonly remaining_attempts: number;
  readonly locked_until: string | null;
}

export interface PassportStampDTO {
  readonly stamp_key: string;
  readonly category:
    "STREAK" | "BOOKS" | "COURAGE_WORDS" | "GOAL_KEEPER" | "COMPREHENSION";
  readonly title_vi: string;
  readonly description_vi: string;
  readonly unlocked: boolean;
  readonly progress_current: number;
  readonly progress_target: number;
}

export interface ReadingPassportDTO {
  readonly child_id: string;
  readonly child_alias: string;
  readonly streak_days: number;
  readonly best_goal_streak_cycles: number;
  readonly completed_sessions: number;
  readonly books_explored: number;
  readonly mastered_difficult_words: number;
  readonly comprehension_correct: number;
  readonly unlocked_stamps_count: number;
  readonly total_stamps_count: number;
  readonly stamps: readonly PassportStampDTO[];
  readonly gentle_message_vi: string;
  readonly has_parent_encouragement: boolean;
}

export interface ParentEncouragementNoteDTO {
  readonly id: string;
  readonly child_id: string;
  readonly title: string | null;
  readonly mime_type: string;
  readonly size_bytes: number;
  readonly duration_ms: number | null;
  readonly audio_stream_path: string;
  readonly signed_audio_url: string | null;
  readonly created_at: string;
}

function unauthorizedError(): ServiceError {
  return new ServiceError({
    code: "AUTH_REQUIRED",
    message: "Authentication required.",
    status: 401,
    request_id: "",
    retryable: false,
  });
}

async function authedRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getBrowserAccessToken({
    onUnauthorized: unauthorizedError,
  });
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/json");
  }
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    let detailMessage = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { detail?: unknown };
      if (typeof body?.detail === "string") {
        detailMessage = body.detail;
      }
    } catch {
      // Ignore JSON parse errors on empty error payloads.
    }
    throw new ServiceError({
      code:
        response.status === 403
          ? "FORBIDDEN"
          : response.status === 404
            ? "RESOURCE_NOT_FOUND"
            : response.status === 413 ||
                response.status === 415 ||
                response.status === 422
              ? "VALIDATION_ERROR"
              : "NETWORK_ERROR",
      message: detailMessage,
      status: response.status,
      request_id: response.headers.get("x-request-id") ?? "",
      retryable: response.status >= 500,
    });
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export interface FamilyPedagogyService {
  getPinStatus(): Promise<ParentPinStatusDTO>;
  upsertPin(payload: {
    readonly pin: string;
    readonly current_pin?: string | null;
    readonly child_mode_default?: boolean;
  }): Promise<ParentPinStatusDTO>;
  verifyPin(pin: string): Promise<ParentPinVerifyResponseDTO>;
  deletePin(currentPin: string): Promise<ParentPinStatusDTO>;
  getReadingPassport(childId: string): Promise<ReadingPassportDTO>;
  getEncouragementNote(
    childId: string,
  ): Promise<ParentEncouragementNoteDTO | null>;
  uploadEncouragementNote(
    childId: string,
    input: {
      readonly blob: Blob;
      readonly filename?: string;
      readonly title?: string;
      readonly durationMs?: number;
    },
  ): Promise<ParentEncouragementNoteDTO>;
  fetchEncouragementAudioBlob(
    note: Pick<
      ParentEncouragementNoteDTO,
      "audio_stream_path" | "signed_audio_url"
    >,
  ): Promise<Blob>;
  deleteEncouragementNote(childId: string, noteId: string): Promise<void>;
}

export function createFamilyPedagogyService(): FamilyPedagogyService {
  return {
    getPinStatus() {
      return authedRequest<ParentPinStatusDTO>("/profiles/me/pin-status");
    },
    upsertPin(payload) {
      return authedRequest<ParentPinStatusDTO>("/profiles/me/pin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    verifyPin(pin) {
      return authedRequest<ParentPinVerifyResponseDTO>(
        "/profiles/me/pin/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin }),
        },
      );
    },
    deletePin(currentPin) {
      return authedRequest<ParentPinStatusDTO>("/profiles/me/pin", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: currentPin }),
      });
    },
    getReadingPassport(childId) {
      return authedRequest<ReadingPassportDTO>(
        `/profiles/children/${encodeURIComponent(childId)}/reading-passport`,
      );
    },
    getEncouragementNote(childId) {
      return authedRequest<ParentEncouragementNoteDTO | null>(
        `/profiles/children/${encodeURIComponent(childId)}/encouragement-note`,
      );
    },
    uploadEncouragementNote(childId, input) {
      const form = new FormData();
      form.append(
        "file",
        input.blob,
        input.filename ?? "parent-encouragement.webm",
      );
      if (input.title?.trim()) {
        form.append("title", input.title.trim());
      }
      if (typeof input.durationMs === "number" && input.durationMs > 0) {
        form.append("duration_ms", String(Math.round(input.durationMs)));
      }
      return authedRequest<ParentEncouragementNoteDTO>(
        `/profiles/children/${encodeURIComponent(childId)}/encouragement-note`,
        {
          method: "POST",
          body: form,
        },
      );
    },
    async fetchEncouragementAudioBlob(note) {
      if (note.signed_audio_url) {
        try {
          const direct = await fetch(note.signed_audio_url);
          if (direct.ok) {
            return await direct.blob();
          }
        } catch {
          // Fall back to authenticated backend stream below.
        }
      }
      const token = await getBrowserAccessToken({
        onUnauthorized: unauthorizedError,
      });
      const resp = await fetch(`${getApiBaseUrl()}${note.audio_stream_path}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!resp.ok) {
        throw new Error(`Audio stream HTTP ${resp.status}`);
      }
      return await resp.blob();
    },
    deleteEncouragementNote(childId, noteId) {
      return authedRequest<void>(
        `/profiles/children/${encodeURIComponent(childId)}/encouragement-note/${encodeURIComponent(noteId)}`,
        { method: "DELETE" },
      );
    },
  };
}
