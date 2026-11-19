import { vi } from "vitest";
import { createAdminKaraokeService } from "@/lib/api/admin-karaoke-service";
import {
  emptyKaraokeMetadata,
  type AdminKaraokeDetail,
  type KaraokeDraftWrite,
  type KaraokeSongCreate,
  type KaraokeValidation,
} from "@/types/karaoke";
import type {
  ProcessingCapabilities,
  ProcessingDraftRequest,
  ProcessingJob,
  ProcessingStart,
  ProcessingReviewRequest,
} from "@/types/karaoke-processing";
import {
  songDetail,
  songId,
  versionId,
  previewDetail,
  stamp,
} from "@/test/karaoke-fixtures";
import {
  inputHash,
  processingJob,
  jobId,
} from "@/test/karaoke-processing-fixtures";
export const wizardCapabilities: ProcessingCapabilities = {
  enabled: true,
  configured: true,
  supported_modes: ["VOCAL_TRACK", "INSTRUMENTAL_WITH_REFERENCE"],
  unavailable_reason: null,
  limits: {
    max_audio_bytes: 20971520,
    max_duration_ms: 300000,
    max_lyric_lines: 300,
    max_lyric_characters: 50000,
  },
  queue_warning_after_seconds: 120,
};
export function makeWizardFixture() {
  const initial = songDetail();
  initial.draft = {
    ...initial.draft!,
    ...emptyKaraokeMetadata,
    has_audio: false,
    audio_sha256: null,
    has_reference_audio: false,
    reference_audio_sha256: null,
    duration_ms: null,
    audio_size_bytes: null,
    lyrics: { format_version: 2, lines: [] },
  };
  let data = structuredClone(initial);
  let job: ProcessingJob = processingJob({
    status: "NEEDS_REVIEW",
    stage: "COMPLETE",
    can_apply: true,
  });
  const cas = (revision: number, draftId: string) => {
    if (revision !== data.revision || draftId !== data.draft?.id)
      throw new Error("Fixture CAS mismatch");
  };
  const clone = () => structuredClone(data);
  const applyWords = () => ({
    ...data.draft!.lyrics,
    lines: data.draft!.lyrics.lines.map((line, lineIndex) => ({
      ...line,
      start_ms: 1000 + lineIndex * 4000,
      end_ms: 4000 + lineIndex * 4000,
      syllables: line.syllables!.map((s, index, all) => ({
        ...s,
        start_ms: Math.round(
          1000 + lineIndex * 4000 + (index * 3000) / all.length,
        ),
        end_ms: Math.round(
          1000 + lineIndex * 4000 + ((index + 1) * 3000) / all.length,
        ),
      })),
    })),
  });
  const service = {
    ...createAdminKaraokeService(),
    getProcessingCapabilities: vi.fn().mockResolvedValue(wizardCapabilities),
    get: vi.fn().mockImplementation(async () => clone()),
    create: vi.fn().mockImplementation(async (body: KaraokeSongCreate) => {
      const { creation_request_id: key, ...metadata } = body;
      void key;
      data.draft = { ...data.draft!, ...metadata };
      return clone();
    }),
    createDraft: vi.fn().mockImplementation(async () => clone()),
    save: vi
      .fn()
      .mockImplementation(async (_id: string, body: KaraokeDraftWrite) => {
        cas(body.expected_revision, body.draft_version_id);
        const { expected_revision, draft_version_id, ...payload } = body;
        void expected_revision;
        void draft_version_id;
        data.draft = { ...data.draft!, ...payload };
        data.revision++;
        if (data.processing_review)
          data.processing_review = {
            ...data.processing_review,
            current_content_fingerprint: "d".repeat(64),
            reviewed: false,
            reviewed_at: null,
          };
        return clone();
      }),
    upload: vi
      .fn()
      .mockImplementation(
        async (
          _id: string,
          kind: "audio" | "cover",
          _file: File,
          revision: number,
          draftId: string,
        ) => {
          cas(revision, draftId);
          data.revision++;
          data.draft =
            kind === "audio"
              ? {
                  ...data.draft!,
                  has_audio: true,
                  audio_sha256: inputHash,
                  duration_ms: 20000,
                  audio_size_bytes: 1000,
                }
              : { ...data.draft!, has_cover: true };
          return clone();
        },
      ),
    uploadReference: vi
      .fn()
      .mockImplementation(
        async (_id: string, _file: File, revision: number, draftId: string) => {
          cas(revision, draftId);
          data.revision++;
          data.draft = {
            ...data.draft!,
            has_reference_audio: true,
            reference_audio_sha256: "e".repeat(64),
          };
          return clone();
        },
      ),
    startProcessing: vi
      .fn()
      .mockImplementation(async (_id: string, body: ProcessingStart) => {
        cas(body.expected_revision, body.draft_version_id);
        job = {
          ...job,
          base_revision: data.revision,
          mode: body.mode,
          source_kind: body.source_kind,
        };
        return structuredClone(job);
      }),
    getProcessing: vi.fn().mockImplementation(async () => structuredClone(job)),
    cancelProcessing: vi.fn().mockImplementation(async () => {
      job = { ...job, status: "CANCELLED", can_apply: false };
      return structuredClone(job);
    }),
    applyProcessing: vi
      .fn()
      .mockImplementation(
        async (_id: string, _job: string, body: ProcessingDraftRequest) => {
          cas(body.expected_revision, body.draft_version_id);
          data.draft = {
            ...data.draft!,
            lyrics: applyWords(),
            audio_sha256: "b".repeat(64),
          };
          data.revision++;
          data.processing_review = {
            required: true,
            current_content_fingerprint: "c".repeat(64),
            reviewed: false,
            reviewed_at: null,
            quality_flags: job.quality_flags,
          };
          job = {
            ...job,
            status: "APPLIED",
            can_apply: false,
            applied_revision: data.revision,
          };
          data.processing_summary = {
            job_id: jobId,
            draft_version_id: versionId,
            status: "APPLIED",
            stage: "COMPLETE",
            safe_error_code: null,
            retry_policy: "NONE",
            updated_at: stamp,
          };
          return clone();
        },
      ),
    getProcessingPreview: vi.fn().mockImplementation(async () => ({
      job_id: jobId,
      song_id: songId,
      draft_version_id: versionId,
      base_revision: job.base_revision,
      input_fingerprint: inputHash,
      ...Object.fromEntries(
        Object.entries(previewDetail()).filter(
          ([key]) =>
            !["version_id", "revision", "song_id", "lyrics"].includes(key),
        ),
      ),
      lyrics: applyWords(),
      reference_audio_url: "https://media.example.test/ref.mp3",
      reference_audio_url_expires_at: "2099-01-01T00:00:00Z",
      quality_flags: job.quality_flags,
    })),
    preview: vi.fn().mockImplementation(async () => ({
      ...previewDetail(),
      revision: data.revision,
      title: data.draft!.title,
      lyrics: data.draft!.lyrics,
    })),
    validate: vi.fn().mockImplementation(async () => {
      const issues: KaraokeValidation["issues"] = [];
      if (!data.draft!.title)
        issues.push({ code: "TITLE_REQUIRED", field: "title", line_id: null });
      if (!data.draft!.source_note)
        issues.push({
          code: "SOURCE_REQUIRED",
          field: "source_note",
          line_id: null,
        });
      if (!data.draft!.usage_note)
        issues.push({
          code: "USAGE_REQUIRED",
          field: "usage_note",
          line_id: null,
        });
      if (data.processing_review?.required && !data.processing_review.reviewed)
        issues.push({
          code: "PROCESSING_REVIEW_REQUIRED",
          field: "review",
          line_id: null,
        });
      return {
        valid: issues.length === 0,
        revision: data.revision,
        draft_version_id: versionId,
        issues,
      };
    }),
    confirmReview: vi
      .fn()
      .mockImplementation(
        async (_id: string, body: ProcessingReviewRequest) => {
          cas(body.expected_revision, body.draft_version_id);
          if (
            !body.confirmed_listened ||
            body.content_fingerprint !==
              data.processing_review?.current_content_fingerprint
          )
            throw new Error("Fixture review mismatch");
          data.revision++;
          data.processing_review = {
            ...data.processing_review!,
            reviewed: true,
            reviewed_at: stamp,
          };
          return clone();
        },
      ),
    getDraftReferencePreview: vi.fn().mockImplementation(async () => ({
      song_id: songId,
      draft_version_id: versionId,
      revision: data.revision,
      content_fingerprint: data.processing_review!.current_content_fingerprint!,
      reference_audio_url: "https://media.example.test/ref.mp3",
      reference_audio_url_expires_at: "2099-01-01T00:00:00Z",
    })),
    publish: vi
      .fn()
      .mockImplementation(
        async (_id: string, revision: number, draftId: string) => {
          cas(revision, draftId);
          if (!data.processing_review?.reviewed)
            throw new Error("Fixture review required");
          data.published = { ...data.draft!, state: "PUBLISHED" };
          data.draft = null;
          data.status = "PUBLISHED";
          data.revision++;
          return clone();
        },
      ),
  };
  return {
    initial,
    service,
    data: clone,
    setData: (next: AdminKaraokeDetail) => {
      data = structuredClone(next);
    },
    setJob: (next: ProcessingJob) => {
      job = next;
    },
  };
}
