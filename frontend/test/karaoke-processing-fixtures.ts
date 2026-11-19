import {
  songId,
  versionId,
  stamp,
  syllableLyrics,
} from "@/test/karaoke-fixtures";
import type {
  ProcessingJob,
  ProcessingPreview,
} from "@/types/karaoke-processing";

export const jobId = "55555555-5555-4555-8555-555555555555";
export const inputHash = "a".repeat(64);
export function processingJob(
  patch: Partial<ProcessingJob> = {},
): ProcessingJob {
  return {
    id: jobId,
    song_id: songId,
    draft_version_id: versionId,
    base_revision: 1,
    mode: "VOCAL_TRACK",
    source_kind: "DRAFT_AUDIO",
    status: "QUEUED",
    stage: "QUEUED",
    input_fingerprint: inputHash,
    created_at: stamp,
    updated_at: stamp,
    finished_at: null,
    applied_at: null,
    applied_revision: null,
    safe_error_code: null,
    retry_policy: "NONE",
    can_apply: false,
    quality_flags: [],
    ...patch,
  };
}
export function processingPreview(): ProcessingPreview {
  return {
    job_id: jobId,
    song_id: songId,
    draft_version_id: versionId,
    base_revision: 1,
    input_fingerprint: inputHash,
    title: "Bài thử",
    author: "Tác giả",
    duration_ms: 20000,
    audio_url: "https://media.example.test/backing.mp3",
    audio_url_expires_at: "2099-01-01T00:00:00Z",
    cover_url: null,
    reference_audio_url: null,
    reference_audio_url_expires_at: null,
    lyrics: syllableLyrics(),
    quality_flags: [],
  };
}
