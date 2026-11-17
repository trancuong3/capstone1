import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdminKaraokeService,
  karaokeErrorMessage,
} from "@/lib/api/admin-karaoke-service";
import { ServiceError } from "@/lib/api/service-error";
import { createKaraokeService } from "@/lib/api/karaoke-service";
import {
  previewDetail,
  songDetail,
  songId,
  versionId,
  syllableLyrics,
} from "@/test/karaoke-fixtures";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "karaoke-test-only" } },
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
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("karaoke real HTTP adapter", () => {
  it("accepts v2 published syllables but rejects incomplete or mismatching nested timing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const parent = createKaraokeService();
    const data = { ...previewDetail(), lyrics: syllableLyrics() };
    fetchMock.mockResolvedValueOnce(Response.json(data));
    expect((await parent.playback(songId, versionId)).lyrics).toEqual(
      data.lyrics,
    );
    for (const patch of [
      { start_ms: null },
      { end_ms: 5000 },
      { text: "Không khớp" },
    ]) {
      const invalid = structuredClone(data);
      Object.assign(invalid.lyrics.lines[0].syllables![0], patch);
      fetchMock.mockResolvedValueOnce(Response.json(invalid));
      await expect(parent.playback(songId, versionId)).rejects.toBeInstanceOf(
        ServiceError,
      );
    }
  });
  it("prepares read-only parent catalog/playback bound to child and published version", async () => {
    const parent = createKaraokeService();
    const source = previewDetail();
    const { revision: _revision, ...playback } = source;
    fetchMock.mockResolvedValueOnce(
      Response.json({
        items: [
          {
            song_id: songId,
            version_id: versionId,
            title: source.title,
            author: source.author,
            duration_ms: source.duration_ms,
            cover_url: null,
            min_grade: 1,
            max_grade: 5,
          },
        ],
        total: 1,
        limit: 12,
        offset: 0,
      }),
    );
    await parent.list(versionId);
    fetchMock.mockResolvedValueOnce(Response.json(playback));
    await expect(
      parent.playback(songId, versionId, versionId),
    ).resolves.toEqual(playback);
    const [url, options] = fetchMock.mock.calls[1];
    expect(new URL(url).searchParams.get("child_id")).toBe(versionId);
    expect(new URL(url).searchParams.get("expected_version_id")).toBe(
      versionId,
    );
    expect(options.method).toBe("GET");
    expect(_revision).toBe(1);
  });
  it("uses authenticated no-store list with encoded filters and pagination", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ items: [], total: 0, limit: 12, offset: 12 }),
    );
    await service.list({ search: "Bé & bạn", status: "DRAFT", offset: 12 });
    const [url, options] = fetchMock.mock.calls[0];
    expect(new URL(url).searchParams.get("search")).toBe("Bé & bạn");
    expect(new URL(url).searchParams.get("limit")).toBe("12");
    expect(options).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      headers: { Authorization: "Bearer karaoke-test-only" },
    });
  });
  it("gets only the requested detail and strips undeclared private fields", async () => {
    fetchMock.mockResolvedValue(
      Response.json({ ...songDetail(), storage_secret: "do not expose" }),
    );
    expect(await service.get(songId)).toEqual(songDetail());
    expect(fetchMock.mock.calls[0][0]).toBe(
      `http://127.0.0.1:8000/karaoke/admin/songs/${songId}`,
    );
  });
  it.each(["../other", "not-a-uuid", "//example.test"])(
    "rejects malformed resource ID %s before HTTP",
    (id) => {
      expect(() => service.get(id)).toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("rejects cross-song and stale-revision responses", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      Response.json({ ...songDetail(), song_id: versionId }),
    );
    await expect(service.get(songId)).rejects.toBeInstanceOf(ServiceError);
    fetchMock.mockResolvedValueOnce(
      Response.json({ ...previewDetail(), revision: 2 }),
    );
    await expect(service.preview(songId, 1, versionId)).rejects.toBeInstanceOf(
      ServiceError,
    );
    fetchMock.mockResolvedValueOnce(
      Response.json({
        valid: true,
        revision: 1,
        draft_version_id: songId,
        issues: [],
      }),
    );
    await expect(service.validate(songId, 1, versionId)).rejects.toBeInstanceOf(
      ServiceError,
    );
  });
  it.each([
    "javascript:alert(1)",
    "data:audio/mpeg;base64,AA",
    "https://user:secret@example.test/audio",
  ])("rejects unsafe signed media URL %s", async (audio_url) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      Response.json({ ...previewDetail(), audio_url }),
    );
    await expect(service.preview(songId, 1, versionId)).rejects.toBeInstanceOf(
      ServiceError,
    );
  });
  it("saves exact optimistic revision/draft and does not POST from a read", async () => {
    const data = songDetail();
    fetchMock.mockImplementation(() => Promise.resolve(Response.json(data)));
    const body = {
      title: "Tên mới",
      author: "",
      min_grade: 1,
      max_grade: 3,
      source_note: "Nguồn",
      usage_note: "Quyền",
      lyrics: data.draft!.lyrics,
      expected_revision: 1,
      draft_version_id: versionId,
    };
    await service.save(songId, body);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify(body),
    });
    await service.get(songId);
    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
  });
  it("uploads multipart without setting a JSON Content-Type", async () => {
    fetchMock.mockResolvedValue(Response.json(songDetail()));
    const file = new File(["test-only"], "song.mp3", { type: "audio/mpeg" });
    const controller = new AbortController();
    await service.upload(
      songId,
      "audio",
      file,
      7,
      versionId,
      controller.signal,
    );
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers["Content-Type"]).toBeUndefined();
    expect(options.signal).toBe(controller.signal);
    expect(options.body).toBeInstanceOf(FormData);
    expect(options.body.get("expected_revision")).toBe("7");
    expect(options.body.get("draft_version_id")).toBe(versionId);
    expect(options.body.get("file")).toBe(file);
  });
  it("uses explicit create/publish/visibility mutations", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(Response.json(songDetail())),
    );
    await service.createDraft(songId, 1);
    await service.publish(songId, 2, versionId);
    await service.visibility(songId, 3, false);
    expect(
      fetchMock.mock.calls.map(([url, options]) => [
        new URL(url).pathname,
        options.method,
        JSON.parse(options.body),
      ]),
    ).toEqual([
      [
        `/karaoke/admin/songs/${songId}/draft`,
        "POST",
        { expected_revision: 1 },
      ],
      [
        `/karaoke/admin/songs/${songId}/publish`,
        "POST",
        { expected_revision: 2, draft_version_id: versionId },
      ],
      [
        `/karaoke/admin/songs/${songId}/visibility`,
        "PATCH",
        { expected_revision: 3, visible: false },
      ],
    ]);
  });
  it.each([401, 403, 404, 409, 413, 415, 422, 503])(
    "keeps HTTP %d and never reflects private errors",
    async (status) => {
      fetchMock.mockResolvedValue(
        Response.json(
          { detail: "PRIVATE SQL token or storage secret" },
          { status },
        ),
      );
      try {
        await service.get(songId);
        throw new Error("Expected HTTP failure");
      } catch (e) {
        expect(e).toBeInstanceOf(ServiceError);
        expect((e as ServiceError).status).toBe(status);
        expect(karaokeErrorMessage(e)).not.toContain("PRIVATE");
      }
    },
  );
});
