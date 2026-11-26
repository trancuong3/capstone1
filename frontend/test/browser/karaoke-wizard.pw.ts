import { expect, test, type Page, type Route } from "@playwright/test";
import { installApiFixture, setRole } from "./real-data-fixture";
import {
  songDetail,
  previewDetail,
  songId,
  versionId,
  stamp,
} from "../karaoke-fixtures";
import {
  processingJob,
  processingPreview,
  jobId,
} from "../karaoke-processing-fixtures";
import type {
  AdminKaraokeDetail,
  KaraokeValidation,
} from "../../types/karaoke";
// All HTTP/media below is test-only. No real DB, provider, recording or publishing.
function silentAudio() {
  const rate = 8000,
    bytes = Buffer.alloc(44 + rate * 20 * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
async function setup(page: Page, resume = false) {
  await installApiFixture(page);
  await setRole(page, "admin");
  await page.addInitScript(() => {
    const nativeAudio = window.Audio;
    const audios: HTMLAudioElement[] = [];
    Object.defineProperty(window, "__karaokeWizardProbe", { value: audios });
    window.Audio = new Proxy(nativeAudio, {
      construct(target, args) {
        const audio = Reflect.construct(target, args) as HTMLAudioElement;
        audios.push(audio);
        return audio;
      },
    });
  });
  const data: AdminKaraokeDetail = songDetail();
  data.draft = {
    ...data.draft!,
    title: "",
    author: "",
    source_note: "",
    usage_note: "",
    has_audio: false,
    has_reference_audio: false,
    audio_sha256: null,
    duration_ms: null,
    audio_size_bytes: null,
    lyrics: { format_version: 2, lines: [] },
  };
  let job = processingJob({
    status: "NEEDS_REVIEW",
    stage: "COMPLETE",
    can_apply: true,
  });
  const requests: string[] = [];
  const rejection = { remaining: 0 };
  if (resume) {
    data.draft = {
      ...songDetail().draft!,
      lyrics: processingPreview().lyrics,
      audio_sha256: "a".repeat(64),
    };
    data.processing_summary = {
      job_id: jobId,
      draft_version_id: versionId,
      status: "READY",
      stage: "COMPLETE",
      retry_policy: "NONE",
      safe_error_code: null,
      updated_at: stamp,
    };
    job = { ...job, status: "READY" };
  }
  async function send(route: Route, value: unknown, status = 200) {
    return route.fulfill({
      status,
      contentType: "application/json",
      headers: {
        "access-control-allow-origin": "http://127.0.0.1:3106",
        "access-control-allow-headers": "authorization,content-type,accept",
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      },
      body: status === 204 ? undefined : JSON.stringify(value),
    });
  }
  const words = () => ({
    ...data.draft!.lyrics,
    lines: data.draft!.lyrics.lines.map((line, i) => ({
      ...line,
      start_ms: 1000 + i * 4000,
      end_ms: 4000 + i * 4000,
      syllables: line.syllables!.map((s, n, all) => ({
        ...s,
        start_ms: Math.round(1000 + i * 4000 + (n * 3000) / all.length),
        end_ms: Math.round(1000 + i * 4000 + ((n + 1) * 3000) / all.length),
      })),
    })),
  });
  await page.context().route("https://media.example.test/**", (route) => {
    const bytes = silentAudio();
    const range = /^bytes=(\d+)-(\d*)$/.exec(
      route.request().headers().range ?? "",
    );
    const start = range ? Number(range[1]) : 0,
      end = range?.[2]
        ? Math.min(bytes.length - 1, Number(range[2]))
        : bytes.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: "audio/wav",
      body: bytes.subarray(start, end + 1),
      headers: {
        "access-control-allow-origin": "*",
        "accept-ranges": "bytes",
        ...(range
          ? { "content-range": `bytes ${start}-${end}/${bytes.length}` }
          : {}),
      },
    });
  });
  await page
    .context()
    .route("http://127.0.0.1:8000/karaoke/admin/**", async (route) => {
      const req = route.request(),
        method = req.method(),
        path = new URL(req.url()).pathname;
      if (method === "OPTIONS") return send(route, null, 204);
      requests.push(`${method} ${path}`);
      expect(req.headers().authorization).toMatch(/^Bearer /);
      if (path.endsWith("processing-capabilities"))
        return send(route, {
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
        });
      if (path.endsWith("/songs") && method === "POST") {
        const { creation_request_id, ...metadata } = req.postDataJSON();
        expect(creation_request_id).toMatch(/^[0-9a-f-]{36}$/);
        Object.assign(data.draft!, metadata);
        return send(route, data, 201);
      }
      if (path === `/karaoke/admin/songs/${songId}` && method === "GET")
        return send(route, data);
      if (path.endsWith("/draft/audio") && method === "POST") {
        expect(req.postDataBuffer()?.toString()).toContain("fixture-song.mp3");
        if (rejection.remaining > 0) {
          rejection.remaining--;
          return send(route, { detail: "Unsupported test-only codec" }, 415);
        }
        data.revision++;
        Object.assign(data.draft!, {
          has_audio: true,
          audio_sha256: "a".repeat(64),
          duration_ms: 20000,
          audio_size_bytes: 1000,
        });
        return send(route, data);
      }
      if (path.endsWith("/draft") && method === "PUT") {
        const { expected_revision, draft_version_id, ...payload } =
          req.postDataJSON();
        expect(expected_revision).toBe(data.revision);
        expect(draft_version_id).toBe(versionId);
        Object.assign(data.draft!, payload);
        data.revision++;
        return send(route, data);
      }
      if (path.endsWith("/processing-jobs") && method === "POST") {
        expect(req.postDataJSON().expected_revision).toBe(data.revision);
        expect(data.draft!.lyrics.format_version).toBe(2);
        job = { ...job, base_revision: data.revision };
        return send(route, job, 202);
      }
      if (path.endsWith(`/processing-jobs/${jobId}`)) return send(route, job);
      if (path.endsWith(`/processing-jobs/${jobId}/preview`))
        return send(route, {
          ...processingPreview(),
          base_revision: job.base_revision,
          lyrics: words(),
          reference_audio_url: "https://media.example.test/ref.mp3",
          reference_audio_url_expires_at: "2099-01-01T00:00:00Z",
        });
      if (path.endsWith(`/processing-jobs/${jobId}/apply`)) {
        expect(req.postDataJSON().expected_revision).toBe(data.revision);
        data.draft!.lyrics = words();
        data.draft!.audio_sha256 = "b".repeat(64);
        data.revision++;
        data.processing_review = {
          required: true,
          current_content_fingerprint: "c".repeat(64),
          reviewed: false,
          reviewed_at: null,
          quality_flags: [],
        };
        job = {
          ...job,
          status: "APPLIED",
          can_apply: false,
          applied_revision: data.revision,
        };
        return send(route, data);
      }
      if (path.endsWith("/draft/reference-preview"))
        return send(route, {
          song_id: songId,
          draft_version_id: versionId,
          revision: data.revision,
          content_fingerprint: "c".repeat(64),
          reference_audio_url: "https://media.example.test/ref.mp3",
          reference_audio_url_expires_at: "2099-01-01T00:00:00Z",
        });
      if (path.endsWith("/draft/preview"))
        return send(route, {
          ...previewDetail(),
          title: data.draft!.title,
          revision: data.revision,
          lyrics: data.draft!.lyrics,
        });
      if (path.endsWith("/draft/validation")) {
        const issues: KaraokeValidation["issues"] = [];
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
        if (!data.processing_review?.reviewed)
          issues.push({
            code: "PROCESSING_REVIEW_REQUIRED",
            field: "review",
            line_id: null,
          });
        return send(route, {
          valid: issues.length === 0,
          revision: data.revision,
          draft_version_id: versionId,
          issues,
        });
      }
      if (path.endsWith("/draft/review")) {
        expect(req.postDataJSON()).toMatchObject({
          expected_revision: data.revision,
          draft_version_id: versionId,
          confirmed_listened: true,
          content_fingerprint: "c".repeat(64),
          acknowledged_flag_ids: [],
        });
        data.revision++;
        data.processing_review = {
          ...data.processing_review!,
          reviewed: true,
          reviewed_at: stamp,
        };
        return send(route, data);
      }
      if (path.endsWith("/publish")) {
        expect(data.processing_review?.reviewed).toBe(true);
        expect(req.postDataJSON().expected_revision).toBe(data.revision);
        data.published = { ...data.draft!, state: "PUBLISHED" };
        data.draft = null;
        data.status = "PUBLISHED";
        data.revision++;
        return send(route, data);
      }
      return send(
        route,
        { detail: "Unexpected isolated karaoke test request" },
        500,
      );
    });
  return { requests, data, rejection };
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
}
test("repeat proposal requires consent, supports undo, and makes no writes", async ({
  page,
}) => {
  const state = await setup(page);
  await page.goto("/admin/karaoke/new");
  const field = page.getByLabel("Lời bài hát", { exact: true });
  await field.fill("Bé hát, vui! ×2");
  await expect(field).toHaveValue("Bé hát, vui! ×2");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .getByRole("button", { name: "Mở rộng câu lặp", exact: true })
    .click();
  await expect(field).toHaveValue("Bé hát, vui! ×2");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Mở rộng câu lặp", exact: true })
    .click();
  await expect(field).toHaveValue("Bé hát, vui!\nBé hát, vui!");
  await noOverflow(page);
  await page
    .getByRole("button", { name: "Hoàn tác mở rộng lời", exact: true })
    .click();
  await expect(field).toHaveValue("Bé hát, vui! ×2");
  expect(state.requests.every((request) => request.startsWith("GET"))).toBe(
    true,
  );
});

test("flagged syllable becomes editable on backing after listening to reference", async ({
  page,
}) => {
  const state = await setup(page, true);
  const line = state.data.draft!.lyrics.lines[0];
  const unit = line.syllables![1];
  state.data.processing_summary = null;
  state.data.processing_review = {
    required: true,
    reviewed: false,
    reviewed_at: null,
    current_content_fingerprint: "c".repeat(64),
    quality_flags: [
      {
        id: jobId,
        line_id: line.id,
        syllable_ids: [unit.id],
        codes: ["HELD_NOTE_UNCERTAIN"],
        message_key: "HELD_NOTE_UNCERTAIN",
        affected_syllable_count: 1,
      },
    ],
  };
  await page.goto(`/admin/karaoke/${songId}/edit`);
  await page
    .getByRole("button", {
      name: "Nghe và kiểm tra bản nháp đã lưu",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "Tải bản hát đối chiếu", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Nghe bản hát đối chiếu", exact: true })
    .click();
  await page.getByRole("button", { name: "Phát", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Tạm dừng", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Kiểm tra câu được đánh dấu", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Nghe bản nháp", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Nội dung tiếng đang chọn", { exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByLabel("Nội dung tiếng đang chọn", { exact: true }),
  ).toHaveValue(unit.text);
  await expect(
    page.getByRole("button", {
      name: `Chọn tiếng 2: ${unit.text}`,
      exact: true,
    }),
  ).toBeFocused();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __karaokeWizardProbe: HTMLAudioElement[] }
          ).__karaokeWizardProbe.filter((audio) => !audio.paused).length,
      ),
    )
    .toBe(0);
  expect(state.requests.every((request) => request.startsWith("GET"))).toBe(
    true,
  );
  await noOverflow(page);
});

test("wizard upload → staging → apply → explicit review → publish, with one audio source", async ({
  page,
}, info) => {
  const state = await setup(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/admin/karaoke/new");
  await expect(
    page.getByRole("heading", { name: "Tạo karaoke dễ dàng" }),
  ).toBeVisible();
  expect(state.requests.every((r) => r.startsWith("GET"))).toBe(true);
  await page
    .getByLabel("Bài hát có giọng (MP3)", { exact: true })
    .setInputFiles({
      name: "fixture-song.mp3",
      mimeType: "audio/mpeg",
      buffer: Buffer.from("fixture-only"),
    });
  await page
    .getByLabel("Tên bài hát", { exact: true })
    .fill("Bài hát thử của admin");
  await page
    .getByText("Thông tin thêm: tác giả, lớp, nguồn và quyền sử dụng", {
      exact: true,
    })
    .click();
  await page
    .getByLabel("Nguồn nhạc và lời", { exact: true })
    .fill("Nội dung fixture tự tạo để kiểm thử");
  await page
    .getByLabel("Quyền sử dụng nội dung", { exact: true })
    .fill("Chỉ fixture kiểm thử, không phát hành");
  await page.getByLabel("Lời bài hát", { exact: true }).fill("Bé hát, vui!");
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("wizard-input.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Tạo karaoke", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Nghe kết quả chưa áp dụng",
      exact: true,
    }),
  ).toBeEnabled();
  await expect(page).toHaveURL(/\/admin\/karaoke\/new$/);
  expect(
    state.requests.filter((r) => r === "POST /karaoke/admin/songs"),
  ).toHaveLength(1);
  await page
    .getByRole("button", { name: "Nghe kết quả chưa áp dụng", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Dùng kết quả này trong bản nháp",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("region", { name: "Nghe và duyệt bản nháp", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Xuất bản bài hát", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Phát", exact: true }).click();
  await page.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  expect(state.requests.some((r) => r.endsWith("/draft/review"))).toBe(false);
  await page
    .getByRole("button", { name: "Tải bản hát đối chiếu", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Nghe bản hát đối chiếu", exact: true })
    .click();
  await page.getByRole("button", { name: "Phát", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Tạm dừng", exact: true }),
  ).toBeVisible();
  const oldReferenceReads = state.requests.filter((r) =>
    r.endsWith("/draft/reference-preview"),
  ).length;
  const oldBackingReads = state.requests.filter((r) =>
    r.endsWith("/draft/preview"),
  ).length;
  await page
    .getByRole("button", { name: "Làm mới bản hát đối chiếu", exact: true })
    .click();
  await expect
    .poll(
      () =>
        state.requests.filter((r) => r.endsWith("/draft/reference-preview"))
          .length,
    )
    .toBe(oldReferenceReads + 1);
  expect(
    state.requests.filter((r) => r.endsWith("/draft/preview")),
  ).toHaveLength(oldBackingReads);
  await expect(
    page.getByRole("region", { name: "Bản hát đối chiếu", exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __karaokeWizardProbe: HTMLAudioElement[] }
          ).__karaokeWizardProbe.filter((audio) => !audio.paused).length,
      ),
    )
    .toBe(0);
  await page
    .getByRole("button", { name: "Nghe nhạc nền", exact: true })
    .click();
  await noOverflow(page);
  await page.screenshot({
    path: info.outputPath("wizard-review.png"),
    fullPage: true,
  });
  await page.getByRole("checkbox", { name: /Tôi đã nghe nhạc nền/ }).check();
  await page
    .getByRole("button", { name: "Tôi đã nghe và duyệt", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Xuất bản bài hát", exact: true }),
  ).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Xuất bản bài hát", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Bài hát đã xuất bản", exact: true }),
  ).toBeVisible();
  expect(state.requests.filter((r) => r.endsWith("/publish"))).toHaveLength(1);
  expect(errors).toEqual([]);
});
test("reopening READY is read-only and requires explicit apply", async ({
  page,
}) => {
  const state = await setup(page, true);
  await page.goto(`/admin/karaoke/${songId}/edit`);
  await expect(
    page.getByRole("button", { name: "Dùng kết quả", exact: true }),
  ).toBeEnabled();
  expect(state.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Dùng kết quả", exact: true }),
  ).toBeEnabled();
  expect(state.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
  await page.getByRole("button", { name: "Dùng kết quả", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Nghe và duyệt bản nháp", exact: true }),
  ).toBeVisible();
  expect(state.requests.filter((r) => r.endsWith("/apply"))).toHaveLength(1);
  await noOverflow(page);
});
test("replacement after rejection keeps pasted lyrics and uses the already-created draft", async ({
  page,
}) => {
  const state = await setup(page);
  state.rejection.remaining = 1;
  await page.goto("/admin/karaoke/new");
  const input = page.getByLabel("Bài hát có giọng (MP3)", { exact: true });
  await input.setInputFiles({
    name: "fixture-song.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("invalid codec fixture"),
  });
  await page.getByLabel("Lời bài hát", { exact: true }).fill("Bé hát, vui!");
  await page.getByRole("button", { name: "Tạo karaoke", exact: true }).click();
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Lời bài hát", { exact: true })).toHaveValue(
    "Bé hát, vui!",
  );
  await page.getByLabel("Tên bài hát", { exact: true }).fill("Tên sửa sau lỗi");
  await input.setInputFiles({
    name: "fixture-song.mp3",
    mimeType: "audio/mpeg",
    buffer: Buffer.from("replacement fixture"),
  });
  await page
    .getByRole("button", { name: "Tạo / căn lại karaoke", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Dùng kết quả", exact: true }),
  ).toBeEnabled();
  expect(
    state.requests.filter((r) => r === "POST /karaoke/admin/songs"),
  ).toHaveLength(1);
  expect(state.requests.filter((r) => r.endsWith("/draft/audio"))).toHaveLength(
    2,
  );
  expect(state.data.draft!.title).toBe("Tên sửa sau lỗi");
  expect(state.data.draft!.lyrics.lines[0].text).toBe("Bé hát, vui!");
  expect(
    state.requests.filter(
      (r) => r.endsWith("/apply") || r.endsWith("/publish"),
    ),
  ).toEqual([]);
  await noOverflow(page);
});
test("missing rights metadata opens the saved inputs and focuses the field without discarding typing", async ({
  page,
}) => {
  const state = await setup(page, true);
  state.data.draft!.source_note = "";
  state.data.draft!.usage_note = "";
  await page.goto(`/admin/karaoke/${songId}/edit`);
  await page.getByRole("button", { name: "Dùng kết quả", exact: true }).click();
  const source = page.getByLabel("Nguồn nhạc và lời", { exact: true });
  await expect(source).toBeVisible();
  await expect(source).toBeFocused();
  await source.fill("Nguồn thử");
  await expect(source).toBeVisible();
  await expect(source).toHaveValue("Nguồn thử");
  await page
    .getByLabel("Quyền sử dụng nội dung", { exact: true })
    .fill("Quyền fixture");
  expect(
    state.requests.filter(
      (r) => r.endsWith("/publish") || r.endsWith("/draft/review"),
    ),
  ).toEqual([]);
  await noOverflow(page);
});
