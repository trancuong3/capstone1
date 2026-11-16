/** Explicit opt-in live check. No fixture Auth/API/audio and no v2 publication.
 * May create ONE v1 draft from the canonical song, after --allow-v1-draft.
 * The imported v2 remains in browser memory until a compatible release exists.
 * Requires separately approved temporary sessions; never takes a server key.
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
const expect = baseExpect.configure({ timeout: 45_000 });
const args = process.argv.slice(2);
const project = args[args.indexOf("--project-ref") + 1];
assert.ok(args.includes("--check-live"));
assert.ok(args.includes("--project-ref"));
assert.equal(project, "hgkklatgepyzbkkmwfvp");
const songId = "0374bb5e-426e-4375-8c1f-2f11c529e786";
const sessionFile = path.join(root, ".cache/karaoke-upgrade-sessions.json");
const sessions = JSON.parse(fs.readFileSync(sessionFile, "utf8"));
assert.equal(sessions.project, project);
assert.equal(new URL(sessions.supabase_url).hostname, `${project}.supabase.co`);
process.loadEnvFile(path.join(root, "frontend/.env.local"));
assert.equal(
  new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname,
  `${project}.supabase.co`,
);
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
assert.ok(key);
const base = "http://localhost:3000";
const api = "http://127.0.0.1:8000";
const lyricsPath = path.join(root, "docs/karaoke-demo/ngoi-sao-nho-v2.json");
const lyrics = JSON.parse(fs.readFileSync(lyricsPath, "utf8"));
const reportPath = path.join(root, ".cache/karaoke-upgrade-live-report.json");
const report = {
  project,
  song_id: songId,
  checks: [],
  human_listening: "requires_reviewer",
  v2_publication: "after_compatible_release",
};
function checkpoint(name) {
  report.checks.push(name);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`PASS ${name}`);
}
async function backend(role, route) {
  return fetch(api + route, {
    signal: AbortSignal.timeout(45_000),
    headers: role
      ? { Authorization: `Bearer ${sessions[role].access_token}` }
      : {},
  });
}
async function detail() {
  const response = await backend("admin", `/karaoke/admin/songs/${songId}`);
  assert.equal(response.status, 200, "Admin detail unavailable");
  return response.json();
}
async function authenticatedContext(browser, role, viewport) {
  const jar = new Map();
  const client = createServerClient(sessions.supabase_url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (items) => {
        for (const { name, value } of items) jar.set(name, value);
      },
    },
  });
  const { error } = await client.auth.setSession(sessions[role]);
  assert.equal(error, null, "Temporary session unavailable");
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
    window.__karaokeLiveAudios = [];
    window.Audio = new Proxy(NativeAudio, {
      construct(target, values) {
        const audio = Reflect.construct(target, values);
        window.__karaokeLiveAudios.push(audio);
        return audio;
      },
    });
  });
  return context;
}
async function seek(page, ms) {
  await page.evaluate((position) => {
    const audio = window.__karaokeLiveAudios.at(-1);
    audio.pause();
    audio.currentTime = position / 1000;
  }, ms);
}
async function noOverflow(page) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Horizontal overflow",
  );
}
let browser;
let lastPage;
let stage = "real authentication";
try {
  assert.equal((await backend(null, "/karaoke/admin/songs")).status, 401);
  assert.equal((await backend("parent", "/karaoke/admin/songs")).status, 403);
  const initial = await detail();
  assert.equal(initial.status, "PUBLISHED");
  assert.equal(
    initial.published.lyrics.format_version,
    1,
    "This pre-release check expects the existing v1 song",
  );
  report.before_revision = initial.revision;
  report.published_version_id = initial.published.id;
  checkpoint("real-auth-401-403-admin-200");
  const playbackResponse = await backend(
    "parent",
    `/karaoke/songs/${songId}/playback?child_id=${sessions.child_id}`,
  );
  assert.equal(playbackResponse.status, 200);
  const playback = await playbackResponse.json();
  assert.deepEqual(playback.lyrics, initial.published.lyrics);
  for (const field of [
    "audio_path",
    "audio_sha256",
    "source_note",
    "usage_note",
    "created_by",
  ])
    assert.ok(!(field in playback), "Private DTO field exposed");
  const media = await fetch(playback.audio_url, {
    headers: { Range: "bytes=0-1023" },
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(media.status, 206);
  assert.equal((await media.arrayBuffer()).byteLength, 1024);
  assert.match(media.headers.get("content-type"), /^audio\/mpeg/);
  checkpoint("real-private-mp3-range-206-and-public-dto");
  browser = await chromium.launch({ headless: true });
  const adminContext = await authenticatedContext(browser, "admin", {
    width: 1440,
    height: 1000,
  });
  const admin = await adminContext.newPage();
  lastPage = admin;
  const errors = [];
  admin.on("pageerror", () => errors.push("admin pageerror"));
  admin.on("dialog", (dialog) => dialog.accept());
  stage = "v1 draft preview";
  await admin.goto(`${base}/admin/karaoke/${songId}/edit`);
  if (!initial.draft) {
    assert.ok(
      args.includes("--allow-v1-draft"),
      "Draft creation requires explicit opt-in",
    );
    await admin
      .getByRole("button", {
        name: "Tạo bản nháp từ bản xuất bản",
        exact: true,
      })
      .click();
  }
  await expect(admin.getByLabel("Tên bài hát", { exact: true })).toBeVisible();
  const draftState = await detail();
  assert.ok(draftState.draft);
  assert.equal(draftState.draft.lyrics.format_version, 1);
  assert.deepEqual(draftState.draft.lyrics, initial.published.lyrics);
  report.draft_version_id = draftState.draft.id;
  await admin
    .getByRole("button", {
      name: "Tải bản nghe thử / Căn thời gian",
      exact: true,
    })
    .click();
  const preview = admin.getByRole("region", {
    name: "Nghe thử bài hát",
    exact: true,
  });
  await expect(
    preview.getByRole("button", { name: "Phát", exact: true }),
  ).toBeEnabled();
  const attemptedWrites = [];
  admin.on("request", (request) => {
    if (
      new URL(request.url()).pathname.startsWith("/karaoke/") &&
      request.method() !== "GET"
    )
      attemptedWrites.push(request.method());
  });
  stage = "unsaved v2 real MP3 synchronization";
  await admin.getByLabel("File lời bài hát").setInputFiles(lyricsPath);
  await expect(admin.getByLabel("Lời dòng 18", { exact: true })).toHaveValue(
    lyrics.lines[17].text,
  );
  await preview.getByRole("button", { name: "Phát", exact: true }).click();
  await expect
    .poll(() =>
      admin.evaluate(() => {
        const a = window.__karaokeLiveAudios.at(-1);
        return a.currentTime > 0.4 && !a.paused && a.readyState >= 2;
      }),
    )
    .toBe(true);
  await preview.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  for (const line of lyrics.lines) {
    const unit = line.syllables[0];
    await seek(admin, Math.floor((unit.start_ms + unit.end_ms) / 2));
    await expect(
      preview.locator(`[data-syllable-id="${unit.id}"]`),
    ).toHaveAttribute("data-state", "active");
  }
  checkpoint("all-18-v2-cues-follow-native-real-mp3-clock-without-saving");
  await seek(admin, 700);
  await noOverflow(admin);
  await preview.screenshot({
    path: path.join(root, ".cache/karaoke-upgrade-live-admin.png"),
  });
  await admin.setViewportSize({ width: 390, height: 844 });
  await noOverflow(admin);
  await preview.screenshot({
    path: path.join(root, ".cache/karaoke-upgrade-live-admin-mobile.png"),
  });
  assert.deepEqual(
    attemptedWrites,
    [],
    "Unsaved preview must not write or publish",
  );
  const unchanged = await detail();
  assert.equal(unchanged.revision, draftState.revision);
  assert.equal(unchanged.published.id, initial.published.id);
  assert.deepEqual(unchanged.draft.lyrics, draftState.draft.lyrics);
  checkpoint("published-v1-and-draft-unchanged-by-local-v2-preview");
  stage = "real parent and child stage";
  const parentContext = await authenticatedContext(browser, "parent", {
    width: 390,
    height: 844,
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
  await parent
    .getByRole("link", { name: `Hát bài ${playback.title}`, exact: true })
    .click();
  const player = parent.getByRole("region", {
    name: "Hát cùng bé",
    exact: true,
  });
  const start = player.getByRole("button", {
    name: "Bắt đầu hát",
    exact: true,
  });
  await expect(start).toBeEnabled();
  assert.ok(
    await parent.evaluate(() =>
      window.__karaokeLiveAudios.every((a) => a.paused),
    ),
  );
  await start.click();
  await expect(player.getByTestId("karaoke-cue")).toContainText("Chuẩn bị");
  await player.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  await player
    .getByRole("combobox", { name: "Tốc độ hát" })
    .selectOption("0.75");
  await player
    .getByRole("button", { name: "Hát lại câu này", exact: true })
    .click();
  await player.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  assert.equal(
    await parent.evaluate(() => window.__karaokeLiveAudios.at(-1).playbackRate),
    0.75,
  );
  await noOverflow(parent);
  await player.screenshot({
    path: path.join(root, ".cache/karaoke-upgrade-live-parent-mobile.png"),
  });
  await player
    .getByText("Âm lượng và thông tin bài hát", { exact: true })
    .click();
  await expect(
    player.getByText(playback.author, { exact: true }),
  ).toBeVisible();
  await player.getByText("Chọn câu để luyện", { exact: true }).click();
  await player
    .getByRole("button", { name: "Trở về hát cả bài", exact: true })
    .click();
  await player
    .getByRole("slider", { name: "Vị trí phát", exact: true })
    .press("End");
  await expect(
    player.getByRole("button", { name: "Hát lại bài này", exact: true }),
  ).toBeVisible();
  await player
    .getByRole("button", { name: "Hát lại bài này", exact: true })
    .click();
  await player.getByRole("button", { name: "Tạm dừng", exact: true }).click();
  checkpoint(
    "real-child-stage-count-in-practice-slow-credits-end-replay-mobile",
  );
  await parent
    .getByRole("link", { name: "Về thư viện bài hát", exact: true })
    .click();
  await expect(parent).toHaveURL(/\/karaoke$/);
  await expect
    .poll(() =>
      parent.evaluate(() =>
        window.__karaokeLiveAudios.every(
          (a) => a.paused && !a.getAttribute("src"),
        ),
      ),
    )
    .toBe(true);
  assert.deepEqual(errors, [], "Live application page errors");
  checkpoint("navigation-disposes-real-audio-no-pageerrors");
  report.status = "passed_pre_release_checks";
  report.after_revision = (await detail()).revision;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
} catch (error) {
  report.status = "failed";
  report.failed_stage = stage;
  report.error_type = error?.constructor?.name ?? "Error";
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  if (lastPage)
    await lastPage
      .screenshot({
        path: path.join(root, ".cache/karaoke-upgrade-live-failure.png"),
        fullPage: true,
      })
      .catch(() => {});
  console.error(`FAIL ${stage} (${report.error_type})`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
