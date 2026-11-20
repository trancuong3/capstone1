import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminKaraokeService } from "@/lib/api/admin-karaoke-service";
import { ServiceError } from "@/lib/api/service-error";
import {
  processingCapabilitiesSchema,
  processingJobSchema,
  qualityFlagSchema,
} from "@/types/karaoke-processing";
import { songId, versionId, lineId, songDetail } from "@/test/karaoke-fixtures";
import {
  jobId,
  inputHash,
  processingJob,
  processingPreview,
} from "@/test/karaoke-processing-fixtures";
vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "test-only" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));
const fetchMock = vi.fn();
const service = createAdminKaraokeService();
const start = {
  expected_revision: 1,
  draft_version_id: versionId,
  idempotency_key: lineId,
  mode: "VOCAL_TRACK" as const,
  source_kind: "DRAFT_AUDIO" as const,
};
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("karaoke processing HTTP contract", () => {
  it("reads capabilities without a mutation or invented worker health", async () => {
    const data = {
      enabled: false,
      configured: false,
      supported_modes: [],
      unavailable_reason: "DISABLED",
      limits: {
        max_audio_bytes: 20971520,
        max_duration_ms: 300000,
        max_lyric_lines: 300,
        max_lyric_characters: 50000,
      },
      queue_warning_after_seconds: 150,
    };
    fetchMock.mockResolvedValue(Response.json({ ...data, worker_alive: true }));
    expect(await service.getProcessingCapabilities()).toEqual(data);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "/karaoke/admin/processing-capabilities",
    );
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(
      processingCapabilitiesSchema.safeParse({
        ...data,
        queue_warning_after_seconds: 0,
      }).success,
    ).toBe(false);
  });
  it.each([401, 403, 404, 503])(
    "preserves capabilities HTTP %s for caller policy",
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json({ detail: { code: "PRIVATE" } }, { status }),
      );
      await expect(service.getProcessingCapabilities()).rejects.toMatchObject({
        status,
      });
    },
  );
  it("sends a stable creation intent and exact start body with abort signal", async () => {
    const data = songDetail();
    const { lyrics: _lyrics, ...draft } = data.draft!;
    void _lyrics;
    const body = {
      title: draft.title,
      author: draft.author,
      min_grade: 1,
      max_grade: 5,
      source_note: draft.source_note,
      usage_note: draft.usage_note,
      creation_request_id: lineId,
    };
    fetchMock.mockResolvedValueOnce(Response.json(data));
    await service.create(body);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body);
    fetchMock.mockResolvedValueOnce(Response.json(processingJob()));
    const controller = new AbortController();
    await service.startProcessing(songId, start, controller.signal);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify(start),
    });
  });
  it("rejects client provider/path injection before HTTP", () => {
    expect(() =>
      service.startProcessing(songId, {
        ...start,
        provider: "fake",
      } as typeof start),
    ).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    { song_id: versionId },
    { draft_version_id: songId },
    { base_revision: 2 },
    { mode: "INSTRUMENTAL_WITH_REFERENCE" },
    { source_kind: "ORIGINAL_RECORDING" },
    { status: "UNKNOWN" },
  ])("rejects mismatched start result %o", async (patch) => {
    fetchMock.mockResolvedValue(
      Response.json({ ...processingJob(), ...patch }),
    );
    await expect(service.startProcessing(songId, start)).rejects.toBeInstanceOf(
      ServiceError,
    );
  });
  it("binds list/get to song, draft, job and requested pagination", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        items: [processingJob()],
        total: 1,
        limit: 10,
        offset: 0,
      }),
    );
    expect((await service.listProcessing(songId)).items).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(
      Response.json({ ...processingJob(), id: lineId }),
    );
    await expect(
      service.getProcessing(songId, jobId, versionId),
    ).rejects.toBeInstanceOf(ServiceError);
    fetchMock.mockResolvedValueOnce(
      Response.json({
        items: [{ ...processingJob(), song_id: versionId }],
        total: 1,
        limit: 10,
        offset: 0,
      }),
    );
    await expect(service.listProcessing(songId)).rejects.toBeInstanceOf(
      ServiceError,
    );
  });
  it.each([
    { job_id: lineId },
    { draft_version_id: songId },
    { base_revision: 2 },
    { input_fingerprint: "b".repeat(64) },
    { audio_url: "javascript:alert(1)" },
    { reference_audio_url: "https://media.example.test/ref.mp3" },
  ])("rejects mixed/unsafe staging preview %o", async (patch) => {
    fetchMock.mockResolvedValue(
      Response.json({ ...processingPreview(), ...patch }),
    );
    await expect(
      service.getProcessingPreview(
        processingJob({ status: "READY", can_apply: true }),
      ),
    ).rejects.toBeInstanceOf(ServiceError);
  });
  it("accepts partial v2 staging without promoting it to playable/published content", async () => {
    const preview = processingPreview();
    preview.lyrics.lines[0].syllables![0].end_ms = null;
    fetchMock.mockResolvedValue(Response.json(preview));
    expect(
      (
        await service.getProcessingPreview(
          processingJob({ status: "NEEDS_REVIEW", can_apply: true }),
        )
      ).lyrics,
    ).toEqual(preview.lyrics);
  });
  it.each([
    { revision: 2 },
    { content_fingerprint: "b".repeat(64) },
    { draft_version_id: songId },
    { song_id: versionId },
    { reference_audio_url: "https://user:pass@example.test/a.mp3" },
  ])("binds draft reference preview to current content %o", async (patch) => {
    fetchMock.mockResolvedValue(
      Response.json({
        song_id: songId,
        draft_version_id: versionId,
        revision: 1,
        content_fingerprint: inputHash,
        reference_audio_url: "https://media.example.test/ref.mp3",
        reference_audio_url_expires_at: "2099-01-01T00:00:00Z",
        ...patch,
      }),
    );
    await expect(
      service.getDraftReferencePreview(songId, 1, versionId, inputHash),
    ).rejects.toBeInstanceOf(ServiceError);
  });
  it("uploads/removes reference without changing playback endpoint", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json(songDetail())),
    );
    const file = new File(["fixture"], "reference.mp3", { type: "audio/mpeg" });
    await service.uploadReference(songId, file, 1, versionId);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("/draft/reference-audio");
    expect(options.body.get("file")).toBe(file);
    expect(options.headers["Content-Type"]).toBeUndefined();
    await service.removeReference(songId, {
      expected_revision: 2,
      draft_version_id: versionId,
    });
    expect(fetchMock.mock.calls[1][1].method).toBe("DELETE");
  });
  it("keeps cancel/retry/apply explicit and does not hide possible cost", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json(
        processingJob({
          status: "CANCELLED",
          retry_policy: "EXPLICIT_COST_ACK",
        }),
      ),
    );
    expect(
      (await service.cancelProcessing(songId, jobId, versionId)).retry_policy,
    ).toBe("EXPLICIT_COST_ACK");
    fetchMock.mockResolvedValueOnce(
      Response.json(processingJob({ id: lineId })),
    );
    const body = {
      expected_revision: 1,
      draft_version_id: versionId,
      idempotency_key: lineId,
      acknowledge_possible_charge: true,
    };
    await service.retryProcessing(songId, jobId, body);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual(body);
    fetchMock.mockResolvedValueOnce(
      Response.json({ ...songDetail(), revision: 2 }),
    );
    await service.applyProcessing(songId, jobId, {
      expected_revision: 1,
      draft_version_id: versionId,
    });
    expect(fetchMock.mock.calls[2][0]).toContain(`/${jobId}/apply`);
    expect(fetchMock.mock.calls).toHaveLength(3);
  });
  it("requires reviewed fingerprint in review ACK, not an onPlayed assumption", async () => {
    const body = {
      expected_revision: 2,
      draft_version_id: versionId,
      content_fingerprint: inputHash,
      confirmed_listened: true,
      acknowledged_flag_ids: [],
    };
    fetchMock.mockResolvedValueOnce(Response.json(songDetail()));
    await expect(service.confirmReview(songId, body)).rejects.toBeInstanceOf(
      ServiceError,
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        ...songDetail(),
        revision: 3,
        processing_review: {
          required: true,
          current_content_fingerprint: inputHash,
          reviewed: true,
          reviewed_at: "2026-11-17T00:00:00Z",
          quality_flags: [],
        },
      }),
    );
    await expect(service.confirmReview(songId, body)).resolves.toMatchObject({
      revision: 3,
    });
  });
  it("validates exact quality enums, unique flags and message membership", () => {
    const flag = {
      id: lineId,
      codes: ["HELD_NOTE_UNCERTAIN"],
      line_id: null,
      syllable_ids: [],
      affected_syllable_count: 1,
      message_key: "HELD_NOTE_UNCERTAIN",
    };
    expect(qualityFlagSchema.safeParse(flag).success).toBe(true);
    expect(
      qualityFlagSchema.safeParse({ ...flag, message_key: "LYRIC_MISMATCH" })
        .success,
    ).toBe(false);
    expect(
      qualityFlagSchema.safeParse({
        ...flag,
        codes: ["HELD_NOTE_UNCERTAIN", "HELD_NOTE_UNCERTAIN"],
      }).success,
    ).toBe(false);
    expect(
      processingJobSchema.safeParse({
        ...processingJob(),
        quality_flags: [flag, flag],
      }).success,
    ).toBe(false);
    expect(
      processingJobSchema.safeParse(processingJob({ can_apply: true })).success,
    ).toBe(false);
  });
});
