import type { AdminKaraokeDetail, KaraokePreview } from "@/types/karaoke";

// Test-only DTOs. Never imported by application code or used as API fallbacks.
export const songId = "11111111-1111-4111-8111-111111111111";
export const versionId = "22222222-2222-4222-8222-222222222222";
export const lineId = "33333333-3333-4333-8333-333333333333";
export const stamp = "2026-11-14T00:00:00Z";
export function songDetail(): AdminKaraokeDetail {
  return {
    song_id: songId,
    revision: 1,
    status: "DRAFT",
    created_at: stamp,
    updated_at: stamp,
    published: null,
    draft: {
      id: versionId,
      version_no: 1,
      state: "DRAFT",
      title: "Bài hát của bé",
      author: "Tác giả",
      min_grade: 1,
      max_grade: 5,
      source_note: "Nguồn được cấp phép",
      usage_note: "Được quyền sử dụng",
      has_audio: true,
      has_cover: false,
      duration_ms: 20000,
      audio_size_bytes: 10000,
      created_at: stamp,
      updated_at: stamp,
      published_at: null,
      lyrics: {
        format_version: 1,
        lines: [
          {
            id: lineId,
            text: "Em vui đến trường",
            start_ms: 1000,
            end_ms: 3000,
          },
        ],
      },
    },
  };
}
export function previewDetail(): KaraokePreview {
  return {
    song_id: songId,
    version_id: versionId,
    revision: 1,
    title: "Bài hát của bé",
    author: "Tác giả",
    duration_ms: 20000,
    audio_url: "https://media.example.test/track.mp3?token=test-only",
    audio_url_expires_at: "2099-01-01T00:00:00Z",
    cover_url: null,
    lyrics: songDetail().draft!.lyrics,
  };
}
