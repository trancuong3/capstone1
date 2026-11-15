/** Opt-in live acceptance. Never imported by the app or invoked by CI.
 * Requires explicitly approved temporary sessions in ignored .cache, a confirmed
 * Supabase project and running localhost servers. Never receives a service key.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFrontend = createRequire(path.join(root, "frontend/package.json"));
const { chromium, expect: baseExpect } = requireFrontend("@playwright/test");
const { createServerClient } = requireFrontend("@supabase/ssr");
const expect = baseExpect.configure({ timeout: 30_000 });
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--apply-demo") || !args.includes("--project-ref")) {
  console.log(
    "Opt-in only: --apply-demo --project-ref <confirmed-ref> [--resume]. Requires approved temporary sessions; see KARAOKE_SETUP.md.",
  );
  process.exit(2);
}
const project = option("--project-ref");
assert.match(project, /^[a-z]{20}$/, "Invalid project ref");
const sessionFile = path.join(root, ".cache/karaoke-live-sessions.json");
const evidenceFile = path.join(root, ".cache/karaoke-live-evidence.json");
const sessions = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
assert.equal(new URL(sessions.supabase_url).host, `${project}.supabase.co`);
process.loadEnvFile(path.join(root, "frontend/.env.local"));
assert.equal(
  new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).host,
  `${project}.supabase.co`,
);
const publicKey =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert.ok(publicKey, "Public Supabase key missing");
const base = "http://localhost:3000";
const api = "http://127.0.0.1:8000";
const bundle = path.join(root, "docs/karaoke-demo");
const metadata = JSON.parse(
  fs.readFileSync(path.join(bundle, "song.json"), "utf8"),
);
const lyrics = JSON.parse(
  fs.readFileSync(path.join(bundle, "ngoi-sao-nho.json"), "utf8"),
);
const evidence = fs.existsSync(evidenceFile)
  ? JSON.parse(fs.readFileSync(evidenceFile, "utf8"))
  : { project, checks: [] };
assert.equal(
  evidence.project,
  project,
  "Previous evidence belongs to another project",
);
if (evidence.song_id && !args.includes("--resume")) {
  throw new Error("An existing acceptance song must be resumed explicitly");
}
const checkpoint = (name) => {
  if (!evidence.checks.includes(name)) evidence.checks.push(name);
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  console.log(`PASS ${name}`);
};
let stage = "setup";
let browser;
let lastPage;
async function backend(method, pathname, role, body) {
  const response = await fetch(api + pathname, {
    method,
    signal: AbortSignal.timeout(45_000),
    headers: {
      ...(role
        ? { Authorization: `Bearer ${sessions[role].access_token}` }
        : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response;
}
async function authenticatedContext(role, viewport) {
  const jar = new Map();
  const client = createServerClient(sessions.supabase_url, publicKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) jar.set(name, value);
      },
    },
  });
  const { error } = await client.auth.setSession(sessions[role]);
  assert.equal(error, null, "Approved temporary session was not accepted");
  const context = await browser.newContext({
    viewport,
    serviceWorkers: "block",
  });
  await context.addCookies(
    [...jar].map(([name, value]) => ({
      name,
      value,
      url: base,
      sameSite: "Lax",
    })),
  );
  await context.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.__karaokeAcceptanceAudios = [];
    window.Audio = new Proxy(NativeAudio, {
      construct(target, values) {
        const audio = Reflect.construct(target, values);
        window.__karaokeAcceptanceAudios.push(audio);
        return audio;
      },
    });
  });
  return context;
}
async function noOverflow(page) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Karaoke page has horizontal overflow",
  );
}
async function readyToPublish(page) {
  await page
    .getByRole("button", { name: "Kiểm tra điều kiện xuất bản" })
    .click();
  await expect(
    page.getByText("Bản nháp hợp lệ", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Tải bản nghe thử / Căn thời gian" })
    .click();
  await expect(
    page.getByRole("button", { name: "Phát", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Phát", exact: true }).click();
  await expect(page.getByTestId("karaoke-active-line")).toHaveText(
    lyrics.lines[0].text,
  );
  await page.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Xuất bản bài hát" }),
  ).toBeEnabled();
}
try {
  stage = "real API authorization";
  assert.equal((await backend("GET", "/karaoke/admin/songs")).status, 401);
  assert.equal(
    (await backend("GET", "/karaoke/admin/songs", "parent")).status,
    403,
  );
  assert.equal(
    (await backend("GET", "/karaoke/admin/songs", "admin")).status,
    200,
  );
  checkpoint("real-auth-401-403-admin-200");
  browser = await chromium.launch({ headless: true });
  const adminContext = await authenticatedContext("admin", {
    width: 1440,
    height: 1000,
  });
  const admin = await adminContext.newPage();
  lastPage = admin;
  const errors = [];
  admin.on("pageerror", () => errors.push("admin pageerror"));
  admin.on("dialog", (dialog) => dialog.accept());
  stage = "admin create draft";
  if (!evidence.song_id) {
    await admin.goto(`${base}/admin/karaoke/new`);
    for (const [label, key] of [
      ["Tên bài hát", "title"],
      ["Tác giả / người thể hiện", "author"],
      ["Nguồn nhạc và lời", "source_note"],
      ["Quyền sử dụng nội dung", "usage_note"],
    ])
      await admin.getByLabel(label, { exact: true }).fill(metadata[key]);
    await admin
      .getByRole("button", { name: "Tạo bản nháp", exact: true })
      .click();
    await expect(admin).toHaveURL(/\/admin\/karaoke\/[0-9a-f-]+\/edit$/);
    evidence.song_id = new URL(admin.url()).pathname.split("/")[3];
    checkpoint("admin-created-draft-through-ui");
  } else {
    await admin.goto(`${base}/admin/karaoke/${evidence.song_id}/edit`);
  }
  const detailResponse = await backend(
    "GET",
    `/karaoke/admin/songs/${evidence.song_id}`,
    "admin",
  );
  assert.equal(detailResponse.status, 200);
  let detail = await detailResponse.json();
  assert.equal((detail.draft ?? detail.published).title, metadata.title);
  if (detail.draft) {
    stage = "real multipart upload";
    if (!detail.draft.has_audio) {
      const uploadResponse = admin.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname ===
            `/karaoke/admin/songs/${evidence.song_id}/draft/audio`,
        { timeout: 120_000 },
      );
      await admin
        .getByLabel("File nhạc MP3")
        .setInputFiles(path.join(bundle, "ngoi-sao-nho.mp3"));
      assert.equal((await uploadResponse).status(), 200);
      await expect(
        admin.getByRole("button", { name: "Thay nhạc MP3", exact: true }),
      ).toBeEnabled();
      checkpoint("admin-mp3-upload-through-ui");
    }
    stage = "import save reload lyrics";
    await admin
      .getByLabel("File lời bài hát")
      .setInputFiles(path.join(bundle, "ngoi-sao-nho.json"));
    await expect(admin.getByLabel("Lời dòng 18", { exact: true })).toHaveValue(
      lyrics.lines[17].text,
    );
    await admin
      .getByRole("button", { name: "Lưu lời và thời gian", exact: true })
      .click();
    await expect(admin.getByText(/Đã lưu bản nháp/)).toBeVisible();
    await admin.reload();
    await expect(admin.getByLabel("Bắt đầu dòng 1 (ms)")).toHaveValue("220");
    await expect(admin.getByLabel("Kết thúc dòng 18 (ms)")).toHaveValue(
      "99600",
    );
    checkpoint("18-lyrics-persist-after-reload");
    stage = "validation native preview publication";
    await readyToPublish(admin);
    await noOverflow(admin);
    await admin.screenshot({
      path: path.join(root, ".cache/karaoke-live-admin.png"),
      fullPage: true,
    });
    await admin.getByRole("button", { name: "Xuất bản bài hát" }).click();
    await expect(
      admin.getByText("Đã xuất bản bài hát.", { exact: true }),
    ).toBeVisible();
    checkpoint("validated-native-mp3-preview-published-through-ui");
  }
  detail = await (
    await backend("GET", `/karaoke/admin/songs/${evidence.song_id}`, "admin")
  ).json();
  assert.equal(detail.status, "PUBLISHED");
  evidence.version_id = detail.published.id;
  evidence.duration_ms = detail.published.duration_ms;
  assert.ok(Math.abs(evidence.duration_ms - 103367) <= 1);
  const playbackResponse = await backend(
    "GET",
    `/karaoke/songs/${evidence.song_id}/playback?child_id=${sessions.child_id}`,
    "parent",
  );
  assert.equal(playbackResponse.status, 200);
  const playback = await playbackResponse.json();
  assert.deepEqual(playback.lyrics, lyrics);
  for (const field of [
    "audio_path",
    "audio_sha256",
    "source_note",
    "usage_note",
    "created_by",
  ])
    assert.ok(!(field in playback), "Private field escaped public DTO");
  const media = await fetch(playback.audio_url, {
    headers: { Range: "bytes=0-1023" },
  });
  assert.equal(media.status, 206, "Signed MP3 Range request failed");
  assert.equal((await media.arrayBuffer()).byteLength, 1024);
  assert.match(media.headers.get("content-type"), /^audio\/mpeg/);
  checkpoint("real-storage-signed-mp3-range-and-public-dto");
  stage = "parent real dashboard library player";
  const parentContext = await authenticatedContext("parent", {
    width: 1440,
    height: 1000,
  });
  const parent = await parentContext.newPage();
  lastPage = parent;
  parent.on("pageerror", () => errors.push("parent pageerror"));
  await parent.goto(`${base}/dashboard`);
  await parent
    .getByRole("button", {
      name: `${sessions.child_alias}, lớp ${sessions.child_grade}`,
      exact: true,
    })
    .click();
  await parent.getByRole("button", { name: "Hát vui", exact: true }).click();
  await expect(
    parent.getByRole("link", {
      name: `Hát bài ${metadata.title}`,
      exact: true,
    }),
  ).toBeVisible();
  await noOverflow(parent);
  await parent
    .getByRole("link", { name: `Hát bài ${metadata.title}`, exact: true })
    .click();
  const player = parent.getByRole("region", {
    name: "Hát cùng bé",
    exact: true,
  });
  await expect(
    player.getByRole("button", { name: "Phát", exact: true }),
  ).toBeEnabled();
  assert.ok(
    await parent.evaluate(() =>
      window.__karaokeAcceptanceAudios.every((a) => a.paused),
    ),
  );
  await player.getByRole("button", { name: "Phát", exact: true }).click();
  await expect(player.getByTestId("karaoke-active-line")).toHaveText(
    lyrics.lines[0].text,
  );
  await player.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await parent.setViewportSize({ width: 390, height: 844 });
  await noOverflow(parent);
  await parent.screenshot({
    path: path.join(root, ".cache/karaoke-live-parent-mobile.png"),
    fullPage: true,
  });
  const position = player.getByRole("slider", {
    name: "Vị trí phát",
    exact: true,
  });
  await position.focus();
  await position.press("End");
  await expect(
    player.getByRole("button", { name: "Hát lại", exact: true }),
  ).toBeVisible();
  await player.getByRole("button", { name: "Hát lại", exact: true }).click();
  await expect(
    player.getByRole("button", { name: "Tạm dừng", exact: true }),
  ).toBeVisible();
  await player.getByRole("button", { name: "Về đầu", exact: true }).click();
  checkpoint("real-parent-child-catalog-mp3-pause-keyboard-seek-replay-mobile");
  stage = "navigation audio disposal";
  await parent
    .getByRole("link", { name: "Về thư viện bài hát", exact: true })
    .click();
  await expect(parent).toHaveURL(/\/karaoke$/);
  await expect
    .poll(() =>
      parent.evaluate(() =>
        window.__karaokeAcceptanceAudios.every(
          (a) => a.paused && !a.getAttribute("src"),
        ),
      ),
    )
    .toBe(true);
  await parent.goBack();
  await expect(
    parent.getByRole("button", { name: "Phát", exact: true }),
  ).toBeEnabled();
  assert.ok(
    await parent.evaluate(() =>
      window.__karaokeAcceptanceAudios.every((a) => a.paused),
    ),
  );
  await parent.goForward();
  await expect(parent).toHaveURL(/\/karaoke$/);
  await expect
    .poll(() =>
      parent.evaluate(() =>
        window.__karaokeAcceptanceAudios.every(
          (a) => a.paused && !a.getAttribute("src"),
        ),
      ),
    )
    .toBe(true);
  checkpoint("navigation-back-forward-stops-audio-without-autoplay");
  stage = "published version isolation and audio replacement";
  if (
    !evidence.checks.includes(
      "real-draft-audio-reset-version-isolation-and-409",
    )
  ) {
    const previousVersion = evidence.version_id;
    await admin.goto(`${base}/admin/karaoke/${evidence.song_id}/edit`);
    await admin
      .getByRole("button", {
        name: "Tạo bản nháp từ bản xuất bản",
        exact: true,
      })
      .click();
    await expect(admin.getByLabel("Bắt đầu dòng 1 (ms)")).toHaveValue("220");
    const draftState = await (
      await backend("GET", `/karaoke/admin/songs/${evidence.song_id}`, "admin")
    ).json();
    assert.ok(draftState.draft);
    const malformed = new FormData();
    malformed.set(
      "file",
      new Blob(["This is not an MP3"], { type: "audio/mpeg" }),
      "invalid.mp3",
    );
    malformed.set("expected_revision", String(draftState.revision));
    malformed.set("draft_version_id", draftState.draft.id);
    const invalidUpload = await fetch(
      `${api}/karaoke/admin/songs/${evidence.song_id}/draft/audio`,
      {
        method: "POST",
        signal: AbortSignal.timeout(45_000),
        headers: { Authorization: `Bearer ${sessions.admin.access_token}` },
        body: malformed,
      },
    );
    assert.equal(invalidUpload.status, 415);
    const stale = await backend(
      "PUT",
      `/karaoke/admin/songs/${evidence.song_id}/draft`,
      "admin",
      {
        ...metadata,
        lyrics,
        draft_version_id: draftState.draft.id,
        expected_revision: draftState.revision - 1,
      },
    );
    assert.equal(stale.status, 409);
    const uploadResponse = admin.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/karaoke/admin/songs/${evidence.song_id}/draft/audio`,
      { timeout: 120_000 },
    );
    await admin
      .getByLabel("File nhạc MP3")
      .setInputFiles(path.join(bundle, "ngoi-sao-nho.mp3"));
    const uploaded = await uploadResponse;
    assert.equal(uploaded.status(), 200);
    const uploadedDetail = await uploaded.json();
    assert.equal(uploadedDetail.revision, draftState.revision + 1);
    assert.ok(
      uploadedDetail.draft.lyrics.lines.every(
        (line) => line.start_ms === null && line.end_ms === null,
      ),
    );
    await expect(admin.getByLabel("Bắt đầu dòng 1 (ms)")).toHaveValue("");
    const unchanged = await backend(
      "GET",
      `/karaoke/songs/${evidence.song_id}/playback?child_id=${sessions.child_id}&expected_version_id=${previousVersion}`,
      "parent",
    );
    assert.equal(unchanged.status, 200);
    assert.deepEqual((await unchanged.json()).lyrics, lyrics);
    checkpoint("real-upload-invalid-415-stale-save-409-and-draft-timing-reset");
    await admin
      .getByLabel("File lời bài hát")
      .setInputFiles(path.join(bundle, "ngoi-sao-nho.json"));
    await expect(admin.getByLabel("Bắt đầu dòng 1 (ms)")).toHaveValue("220");
    await admin
      .getByRole("button", { name: "Lưu lời và thời gian", exact: true })
      .click();
    await expect(admin.getByText(/Đã lưu bản nháp/)).toBeVisible();
    await readyToPublish(admin);
    await admin
      .getByRole("button", { name: "Xuất bản bài hát", exact: true })
      .click();
    await expect(
      admin.getByText("Đã xuất bản bài hát.", { exact: true }),
    ).toBeVisible();
    const stalePlayback = await backend(
      "GET",
      `/karaoke/songs/${evidence.song_id}/playback?child_id=${sessions.child_id}&expected_version_id=${previousVersion}`,
      "parent",
    );
    assert.equal(stalePlayback.status, 409);
    await parent
      .getByRole("link", { name: `Hát bài ${metadata.title}`, exact: true })
      .click();
    await expect(
      parent.getByRole("button", { name: "Tải phiên bản mới", exact: true }),
    ).toBeVisible();
    assert.ok(
      await parent.evaluate(() =>
        window.__karaokeAcceptanceAudios.every(
          (a) => a.paused && !a.getAttribute("src"),
        ),
      ),
    );
    await parent
      .getByRole("button", { name: "Tải phiên bản mới", exact: true })
      .click();
    await expect(
      parent.getByRole("button", { name: "Phát", exact: true }),
    ).toBeEnabled();
    assert.ok(
      await parent.evaluate(() =>
        window.__karaokeAcceptanceAudios.every((a) => a.paused),
      ),
    );
    evidence.version_id = (
      await (
        await backend(
          "GET",
          `/karaoke/admin/songs/${evidence.song_id}`,
          "admin",
        )
      ).json()
    ).published.id;
    checkpoint("real-draft-audio-reset-version-isolation-and-409");
  }
  stage = "hide show published demo";
  await admin.goto(`${base}/admin/karaoke`);
  const card = admin
    .locator("article,section,div")
    .filter({
      has: admin.getByRole("heading", { name: metadata.title, exact: true }),
    })
    .filter({
      has: admin.getByRole("button", { name: "Ẩn bài hát", exact: true }),
    })
    .last();
  await card.getByRole("button", { name: "Ẩn bài hát", exact: true }).click();
  await expect(
    admin.getByRole("button", { name: "Hiện lại", exact: true }),
  ).toBeVisible();
  assert.equal(
    (
      await backend(
        "GET",
        `/karaoke/songs/${evidence.song_id}/playback?child_id=${sessions.child_id}`,
        "parent",
      )
    ).status,
    404,
  );
  await admin.getByRole("button", { name: "Hiện lại", exact: true }).click();
  await expect(
    admin.getByRole("button", { name: "Ẩn bài hát", exact: true }),
  ).toBeVisible();
  assert.equal(
    (
      await backend(
        "GET",
        `/karaoke/songs/${evidence.song_id}/playback?child_id=${sessions.child_id}`,
        "parent",
      )
    ).status,
    200,
  );
  checkpoint("hide-show-real-demo-final-published");
  assert.equal(errors.length, 0, "Browser pageerror occurred");
  evidence.status = "passed";
  delete evidence.failed_stage;
  delete evidence.error_type;
  delete evidence.error_summary;
  evidence.completed_at = new Date().toISOString();
  checkpoint("live-acceptance-complete");
} catch (error) {
  evidence.status = "incomplete";
  evidence.failed_stage = stage;
  evidence.error_type = error?.name ?? "Error";
  evidence.error_summary = String(error?.message ?? "Unknown error")
    .split("\n")[0]
    .replace(/https?:\/\/\S+/g, "[URL redacted]")
    .replace(/eyJ[A-Za-z0-9_.-]+/g, "[JWT redacted]")
    .slice(0, 300);
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2));
  await lastPage
    ?.screenshot({
      path: path.join(root, ".cache/karaoke-live-failure.png"),
      fullPage: true,
    })
    .catch(() => {});
  console.error(
    `FAIL ${stage}: ${evidence.error_type}: ${evidence.error_summary}. No tokens or signed URLs are logged.`,
  );
  process.exitCode = 1;
} finally {
  await browser?.close();
}
