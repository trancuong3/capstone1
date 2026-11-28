import { expect, test, type Page, type Route } from "@playwright/test";
import { ids, installApiFixture } from "./real-data-fixture";

const PAGE_1_ID = ids.page;
const PAGE_1_REV = ids.revision;

interface WordSpec {
  word_id: string;
  word_index: number;
  text: string;
  bbox: readonly [number, number, number, number];
  line_index: number;
}

function buildWrappedVietnamesePassage(): {
  words: WordSpec[];
  text: string;
} {
  const paragraphs = [
    "Buổi sáng mùa xuân nắng ấm nhẹ nhàng chiếu qua khung cửa sổ nhỏ bên vườn hoa hồng rực rỡ.",
    "Bé Lan ngồi ngay ngắn bên bàn gỗ đọc từng chữ thật to rõ ràng và chú mèo mướp nằm nghe rất chăm chú.",
    "Những giọt sương long lanh đọng trên tán lá xanh biếc khiến khu vườn trở nên trong lành và tươi vui lạ thường.",
  ];
  const words: WordSpec[] = [];
  paragraphs.forEach((para, lineIdx) => {
    const tokens = para.split(/\s+/u);
    tokens.forEach((token, i) => {
      const idx = words.length;
      words.push({
        word_id: `95000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        word_index: idx,
        text: token,
        bbox: [
          0.05 + (i % 10) * 0.09,
          0.08 + lineIdx * 0.22 + Math.floor(i / 10) * 0.08,
          0.08,
          0.05,
        ],
        line_index: lineIdx,
      });
    });
  });
  return { words, text: paragraphs.join("\n\n") };
}

function makeSilentWavBuffer(durationSec = 0.25): Buffer {
  const sampleRate = 16_000;
  const dataBytes = Math.floor(sampleRate * durationSec) * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(buf.length - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

async function installHostedVercelReadingSession(
  page: Page,
  options: {
    hostedUnconfigured?: boolean;
    forceTts503?: boolean;
  } = {},
) {
  await installApiFixture(page);
  const { hostedUnconfigured = true, forceTts503 = false } = options;
  const passage = buildWrappedVietnamesePassage();
  const now = "2026-11-26T10:00:00Z";
  const base = `/reading/sessions/${ids.session}`;
  const corsHeadersFor = (route: Route) => ({
    "access-control-allow-origin":
      route.request().headers().origin || "http://127.0.0.1:3106",
    "access-control-allow-headers": "authorization,content-type,accept",
    "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-expose-headers":
      "X-TTS-Provider,X-Resolved-Voice-Id,X-TTS-Region,X-TTS-Model-Version,X-TTS-Scope,X-TTS-Cache,X-TTS-Cached-Speed,X-TTS-Fallback-Used",
  });
  const json = (
    route: Route,
    body: unknown,
    status = 200,
    extraHeaders: Record<string, string> = {},
  ) =>
    route.fulfill({
      status,
      headers: { ...corsHeadersFor(route), ...extraHeaders },
      contentType: "application/json",
      body: JSON.stringify(body),
    });

  const metrics = {
    statusCalls: 0,
    timedCalls: 0,
    shortCalls: 0,
    relockCalls: 0,
    http409Count: 0,
    timedBodies: [] as Array<Record<string, unknown>>,
    sessionLockVoiceBySession: new Map<string, string>(),
  };

  await page.route("http://127.0.0.1:8000/books/*/pages", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeadersFor(route) });
    return json(route, [
      {
        page_id: PAGE_1_ID,
        page_number: 1,
        lifecycle_status: "ACTIVE",
        current_verified_revision_id: PAGE_1_REV,
        preview_url: null,
      },
    ]);
  });

  await page.route("http://127.0.0.1:8000/reading-presence/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeadersFor(route) });
    return json(route, { email_enabled: false, updated_at: now });
  });

  await page.route("http://127.0.0.1:8000/reading/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeadersFor(route) });
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/reading/history")) return route.fallback();
    if (path === base) {
      return json(route, {
        id: ids.session,
        child_id: ids.child,
        book_id: ids.book,
        state: "PAGE_READY",
        started_at: now,
        ended_at: null,
        duration_ms: null,
      });
    }
    if (path === base + "/page") {
      return json(route, {
        page_id: PAGE_1_ID,
        book_id: ids.book,
        page_revision_id: PAGE_1_REV,
        page_number: 1,
        confidence: 0.99,
        width: 800,
        height: 1100,
        image_overlay_safe: false,
        image_url: null,
        verified_text: passage.text,
        verification_status: "VERIFIED",
        text: passage.text,
        words: passage.words,
      });
    }
    if (path === base + "/progress") {
      return json(route, {
        session_id: ids.session,
        persisted: true,
        start_page_id: PAGE_1_ID,
        end_page_id: PAGE_1_ID,
        current_page_id: PAGE_1_ID,
        start_page_number: 1,
        end_page_number: 1,
        current_page_number: 1,
        current_index: 0,
        total_pages: 1,
        completed_pages: 0,
        pages: [
          {
            page_id: PAGE_1_ID,
            page_revision_id: PAGE_1_REV,
            page_number: 1,
            page_order: 0,
            status: "IN_PROGRESS",
            started_at: now,
            completed_at: null,
          },
        ],
      });
    }
    if (path === base + "/practice-state") {
      return json(route, {
        session_id: ids.session,
        legacy_evidence_present: false,
        pages: [],
        words: [],
      });
    }
    if (path === base + "/completion-summary") {
      return json(route, {
        assessment: null,
        duration_minutes: 1,
        pages_explored: 1,
        selected_range_pages: 1,
        practiced_words: 0,
        score: null,
        correct_words: [],
        mispronounced_words: [],
        skipped_words: [],
        transcripts: [],
        spoken_words: [],
      });
    }
    if (path.includes("/questions")) {
      return json(route, { session_id: ids.session, questions: [] });
    }
    return json(route, { ok: true });
  });

  await page.route("http://127.0.0.1:8000/voice/**", (route) => {
    if (route.request().method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: corsHeadersFor(route) });
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === "/voice/status") {
      metrics.statusCalls += 1;
      if (hostedUnconfigured) {
        return json(route, {
          default_mode: "local_only",
          default_voice_id: "local_north_truc_ly",
          local: {
            configured: false,
            mode: "disabled_or_unconfigured",
            error_code: "LOCAL_VOICE_UNCONFIGURED",
            available: false,
            stt_ready: false,
            tts_ready: false,
          },
          google: {
            stt_configured: false,
            tts_configured: !forceTts503,
            stt_cooldown: false,
            tts_cooldown: false,
          },
        });
      }
      return json(route, {
        default_mode: "local_only",
        default_voice_id: "local_north_truc_ly",
        local: {
          configured: true,
          mode: "local",
          error_code: null,
          available: true,
          stt_ready: true,
          tts_ready: true,
        },
        google: {
          stt_configured: false,
          tts_configured: true,
          stt_cooldown: false,
          tts_cooldown: false,
        },
      });
    }

    if (path === "/voice/voices") {
      return json(route, {
        default_voice_id: hostedUnconfigured
          ? "google_vi_vn_neural2_a"
          : "local_north_truc_ly",
        local_worker_ready: !hostedUnconfigured,
        google_tts_available: !forceTts503,
        voices: [
          {
            voice_id: "local_north_truc_ly",
            name: "Cô Trúc Ly - Miền Bắc",
            gender: "female",
            region: "north",
            provider: "local",
          },
          {
            voice_id: "google_vi_vn_neural2_a",
            name: "Cô Linh (Google) - Miền Bắc",
            gender: "female",
            region: "north",
            provider: "google",
          },
          {
            voice_id: "google_vi_vn_neural2_c",
            name: "Cô Mai (Google) - Miền Nam",
            gender: "female",
            region: "south",
            provider: "google",
          },
        ],
      });
    }

    if (path === "/voice/session-lock") {
      metrics.relockCalls += 1;
      const body = (route.request().postDataJSON() ?? {}) as {
        session_id?: string;
        voice_id?: string;
      };
      if (body.session_id && body.voice_id) {
        metrics.sessionLockVoiceBySession.set(body.session_id, body.voice_id);
      }
      return json(route, {
        session_id: body.session_id ?? ids.session,
        voice_id: body.voice_id ?? "google_vi_vn_neural2_a",
        provider: (body.voice_id ?? "").startsWith("google_")
          ? "google"
          : "local",
        locked: true,
      });
    }

    if (path === "/voice/text-to-speech/timed") {
      metrics.timedCalls += 1;
      const body = (route.request().postDataJSON() ?? {}) as {
        words?: string[];
        voice_id?: string;
        session_id?: string;
        speed?: number;
      };
      metrics.timedBodies.push(body);
      if (forceTts503) {
        return json(
          route,
          { detail: { code: "LOCAL_VOICE_UNCONFIGURED" } },
          503,
        );
      }
      const requestedVoice = body.voice_id || "google_vi_vn_neural2_a";
      if (body.session_id) {
        const locked = metrics.sessionLockVoiceBySession.get(body.session_id);
        if (locked && locked !== requestedVoice) {
          metrics.http409Count += 1;
          return json(
            route,
            {
              detail: {
                code: "SESSION_VOICE_LOCKED",
                message: `Locked to ${locked}`,
              },
            },
            409,
          );
        }
        metrics.sessionLockVoiceBySession.set(body.session_id, requestedVoice);
      }
      const reqWords = body.words ?? passage.words.map((w) => w.text);
      const wavBuf = makeSilentWavBuffer(0.35);
      const step = 0.35 / Math.max(1, reqWords.length);
      return json(
        route,
        {
          audio_base64: wavBuf.toString("base64"),
          content_type: "audio/wav",
          duration_seconds: 0.35,
          words: reqWords.map((_, index) => ({
            index,
            start: Number((index * step).toFixed(3)),
            end: Number(((index + 1) * step).toFixed(3)),
          })),
          resolved_voice_id: requestedVoice,
          provider: requestedVoice.startsWith("google_") ? "google" : "local",
          region: requestedVoice.endsWith("_c") ? "south" : "north",
          model_version: requestedVoice.startsWith("google_")
            ? "google-cloud-tts-v1"
            : "viread-local-tts-v1",
          cached_speed: body.speed ?? 0.9,
        },
        200,
        {
          "X-TTS-Scope": "CATALOG",
          "X-TTS-Cache": "HIT",
          "X-TTS-Provider": requestedVoice.startsWith("google_")
            ? "google"
            : "local",
          "X-Resolved-Voice-Id": requestedVoice,
          "X-TTS-Cached-Speed": String(body.speed ?? 0.9),
        },
      );
    }

    if (path === "/voice/text-to-speech") {
      metrics.shortCalls += 1;
      if (forceTts503) {
        return json(
          route,
          { detail: { code: "LOCAL_VOICE_UNCONFIGURED" } },
          503,
        );
      }
      const body = (route.request().postDataJSON() ?? {}) as {
        voice_id?: string;
        session_id?: string;
      };
      const requestedVoice = body.voice_id || "google_vi_vn_neural2_a";
      if (body.session_id) {
        const locked = metrics.sessionLockVoiceBySession.get(body.session_id);
        if (locked && locked !== requestedVoice) {
          metrics.http409Count += 1;
          return json(route, { detail: { code: "SESSION_VOICE_LOCKED" } }, 409);
        }
        metrics.sessionLockVoiceBySession.set(body.session_id, requestedVoice);
      }
      return route.fulfill({
        status: 200,
        headers: {
          ...corsHeadersFor(route),
          "X-TTS-Scope": "CATALOG",
          "X-TTS-Cache": "HIT",
          "X-TTS-Provider": requestedVoice.startsWith("google_")
            ? "google"
            : "local",
          "X-Resolved-Voice-Id": requestedVoice,
          "X-TTS-Cached-Speed": "0.90",
        },
        contentType: "audio/wav",
        body: makeSilentWavBuffer(0.2),
      });
    }

    return json(route, { detail: { code: "LOCAL_STT_UNAVAILABLE" } }, 503);
  });

  // Deterministic lightweight SpeechRecognition + getUserMedia hooks for headless Chromium
  await page.addInitScript(() => {
    type RecInst = {
      onspeechstart: (() => void) | null;
      onresult: ((ev: unknown) => void) | null;
      onend: (() => void) | null;
      onerror: ((ev: unknown) => void) | null;
      results: Array<{
        isFinal: boolean;
        length: number;
        0: { transcript: string; confidence: number };
      }>;
    };
    const recs: RecInst[] = [];
    class MockReadingRecognition {
      continuous = true;
      interimResults = true;
      lang = "vi-VN";
      maxAlternatives = 1;
      onspeechstart: (() => void) | null = null;
      onresult: ((ev: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      results: Array<{
        isFinal: boolean;
        length: number;
        0: { transcript: string; confidence: number };
      }> = [];
      constructor() {
        recs.push(this);
      }
      start() {}
      stop() {
        this.onend?.();
      }
      abort() {
        this.onend?.();
      }
    }
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: MockReadingRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: MockReadingRecognition,
    });

    if (navigator.mediaDevices) {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        configurable: true,
        value: async () => {
          const ctx = new AudioContext();
          await ctx.resume();
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const dest = ctx.createMediaStreamDestination();
          osc.frequency.value = 220;
          gain.gain.value = 0.001;
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
          const stream = dest.stream;
          for (const track of stream.getTracks()) {
            const stop = track.stop.bind(track);
            track.stop = () => {
              try {
                osc.stop();
                void ctx.close();
              } catch {
                // ignore
              }
              stop();
            };
          }
          return stream;
        },
      });
    }

    (window as unknown as Record<string, unknown>).__overhaulStt = {
      count: () => recs.length,
      emit: (transcript: string, isFinal: boolean) => {
        const rec = recs[recs.length - 1];
        if (!rec?.onresult) return;
        rec.onspeechstart?.();
        const idx = rec.results.length;
        const entry = {
          isFinal,
          length: 1,
          0: { transcript, confidence: 0.95 },
        };
        if (isFinal) {
          rec.results.push(entry);
          rec.onresult({
            resultIndex: idx,
            results: Object.assign([...rec.results], {
              length: rec.results.length,
            }),
          });
        } else {
          const temp = [...rec.results, entry];
          rec.onresult({
            resultIndex: idx,
            results: Object.assign(temp, { length: temp.length }),
          });
        }
      },
    };
  });

  await page.goto(`/reading/${ids.session}?state=reading`);
  await page.waitForSelector("[data-word-id]", { timeout: 25_000 });
  return { passage, metrics };
}

test.describe("Vercel Reading Flow Overhaul: Zero-Layout-Shift Highlighting & Voice Stability", () => {
  test("preserves 0.00px word bounding-box geometry across live highlight transitions and all 12 presentation states + isCurrent", async ({
    page,
    isMobile,
  }) => {
    if (!isMobile) {
      await page.setViewportSize({ width: 1280, height: 800 });
    } else {
      await page.setViewportSize({ width: 390, height: 844 });
    }

    await installHostedVercelReadingSession(page, {
      hostedUnconfigured: false,
    });

    const measureAllWords = () =>
      page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(
          "[data-reading-scroll-container='true']",
        );
        const scrollTop = scroller ? scroller.scrollTop : 0;
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>("[data-word-id]"),
        );
        return nodes.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.dataset.wordId ?? "",
            text: el.textContent ?? "",
            x: Number(r.x.toFixed(2)),
            y: Number((r.y + scrollTop).toFixed(2)),
            width: Number(r.width.toFixed(2)),
            height: Number(r.height.toFixed(2)),
          };
        });
      });

    const baseline = await measureAllWords();
    expect(baseline.length).toBeGreaterThan(25);

    // 1. Live STT reading transitions (interim preview -> confirmed correct -> next current -> mispronounced)
    await page
      .getByRole("button", { name: "Bé đọc với nhận diện giọng nói" })
      .click();
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              window as unknown as {
                __overhaulStt: { count: () => number };
              }
            ).__overhaulStt.count(),
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);

    const steps: Array<[string, boolean]> = [
      ["Buổi sáng mùa", false],
      ["Buổi sáng mùa xuân nắng ấm", true],
      ["nhẹ nhàng chiếu qua khung cửa", false],
      ["nhẹ nhàng chiếu qua khung cửa sổ nhỏ", true],
    ];

    for (const [text, isFinal] of steps) {
      await page.evaluate(
        ([t, f]) => {
          (
            window as unknown as {
              __overhaulStt: { emit: (s: string, fin: boolean) => void };
            }
          ).__overhaulStt.emit(t as string, f as boolean);
        },
        [text, isFinal] as const,
      );
      await page.waitForTimeout(100);
      const current = await measureAllWords();
      expect(current).toHaveLength(baseline.length);
      for (let i = 0; i < baseline.length; i += 1) {
        expect(Math.abs(current[i].x - baseline[i].x)).toBeLessThanOrEqual(
          0.01,
        );
        expect(Math.abs(current[i].y - baseline[i].y)).toBeLessThanOrEqual(
          0.01,
        );
        expect(
          Math.abs(current[i].width - baseline[i].width),
        ).toBeLessThanOrEqual(0.01);
        expect(
          Math.abs(current[i].height - baseline[i].height),
        ).toBeLessThanOrEqual(0.01);
      }
    }

    // 2. Exhaustive sweep of ALL 12 WordPresentationState classes x (isCurrent=false, isCurrent=true)
    //    + all 5 non-flow absolute overlay glyphs on mid-line and wrap-boundary Vietnamese words.
    const maxShift = await page.evaluate(() => {
      const states: Array<{
        readonly name: string;
        readonly cls: string;
        readonly glyph?: { readonly cls: string; readonly text?: string };
      }> = [
        { name: "unread", cls: "border-b-transparent" },
        {
          name: "current",
          cls: "bg-yellow-200/60 ring-2 ring-yellow-500 border-b-amber-600",
        },
        {
          name: "preview-correct",
          cls: "bg-emerald-50 text-emerald-950 border-dashed border-b-emerald-500",
          glyph: {
            cls: "pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-emerald-600",
          },
        },
        {
          name: "correct",
          cls: "bg-success-surface text-success-ink border-solid border-b-emerald-700/60",
        },
        {
          name: "incorrect",
          cls: "bg-red-200 text-red-900 ring-1 ring-red-500 border-b-red-500",
        },
        {
          name: "omission",
          cls: "bg-red-200 text-red-900 ring-1 ring-red-500 border-b-transparent",
        },
        {
          name: "repeated",
          cls: "bg-purple-200 text-purple-900 ring-1 ring-purple-500 border-b-transparent",
        },
        {
          name: "hesitation",
          cls: "bg-purple-200 text-purple-900 ring-1 ring-purple-500 border-b-transparent",
        },
        {
          name: "self-corrected",
          cls: "bg-green-200 text-green-900 ring-2 ring-green-600 ring-offset-2 border-b-transparent",
          glyph: {
            cls: "pointer-events-none absolute -top-2 -right-1 rounded-full bg-white/95 px-1 text-[10px] leading-tight text-green-900 shadow-2xs",
            text: "↺",
          },
        },
        {
          name: "unresolved",
          cls: "bg-red-200 text-red-900 ring-2 ring-red-600 border-b-transparent",
          glyph: {
            cls: "pointer-events-none absolute -top-2 -right-1 rounded-full bg-white/95 px-1 text-[10px] leading-tight text-red-900 shadow-2xs",
            text: "◇",
          },
        },
        {
          name: "assisted",
          cls: "bg-sky text-primary underline decoration-dotted decoration-2 underline-offset-4 border-b-transparent",
          glyph: {
            cls: "pointer-events-none absolute -top-2 -right-1 rounded-full bg-white/95 px-1 text-[10px] leading-tight text-primary shadow-2xs",
            text: "\u266A",
          },
        },
        {
          name: "uncertain",
          cls: "bg-slate-100 text-slate-700 ring-1 ring-slate-400 border-b-transparent",
          glyph: {
            cls: "pointer-events-none absolute -top-2 -right-1 rounded-full bg-white/95 px-1 text-[10px] leading-tight text-slate-700 shadow-2xs",
            text: "?",
          },
        },
      ];

      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>("[data-word-id]"),
      );
      const initial = nodes.map((n) => n.getBoundingClientRect());
      let worstDelta = 0;

      // Pick first word, 6th word (likely near wrap boundary), and 12th word
      const targets = [nodes[0], nodes[5], nodes[11]].filter(Boolean);
      const originalClasses = targets.map((el) => el.className);
      const stateTokens = new Set(
        [
          ...states.map((s) => s.cls),
          "ring-2 ring-primary/45 shadow-xs transition-none",
        ]
          .flatMap((cls) => cls.split(/\s+/))
          .filter(Boolean),
      );
      const baseClassesPerTarget = originalClasses.map((cls) =>
        cls
          .split(/\s+/)
          .filter((token) => token && !stateTokens.has(token))
          .join(" "),
      );

      for (const state of states) {
        for (const isCurr of [false, true]) {
          const currentModifier = !isCurr
            ? ""
            : state.name === "current" || state.name === "incorrect"
              ? "shadow-xs transition-none"
              : "ring-2 ring-primary/45 shadow-xs transition-none";

          targets.forEach((el, idx) => {
            el.className = `${baseClassesPerTarget[idx]} ${state.cls} ${currentModifier}`;
            if (state.glyph) {
              const overlay = document.createElement("span");
              overlay.setAttribute("aria-hidden", "true");
              overlay.dataset.sweepOverlay = "true";
              overlay.className = state.glyph.cls;
              if (state.glyph.text) {
                overlay.textContent = state.glyph.text;
              }
              el.appendChild(overlay);
            }
          });
          // Force synchronous layout read across ALL words on the page
          for (let i = 0; i < nodes.length; i += 1) {
            const r = nodes[i].getBoundingClientRect();
            const b = initial[i];
            worstDelta = Math.max(
              worstDelta,
              Math.abs(r.x - b.x),
              Math.abs(r.y - b.y),
              Math.abs(r.width - b.width),
              Math.abs(r.height - b.height),
            );
          }
          for (const el of targets) {
            el.querySelectorAll("[data-sweep-overlay='true']").forEach((node) =>
              node.remove(),
            );
          }
        }
      }
      targets.forEach((el, idx) => {
        el.className = originalClasses[idx];
      });
      return worstDelta;
    });

    expect(maxShift).toBeLessThanOrEqual(0.01);
  });

  test("keeps honest non-flapping badge under hosted LOCAL_VOICE_UNCONFIGURED, IDB hit after reload, and zero 409 on voice preview", async ({
    page,
  }) => {
    const { metrics } = await installHostedVercelReadingSession(page, {
      hostedUnconfigured: true,
    });

    // 1. Under LOCAL_VOICE_UNCONFIGURED + default local_only policy:
    //    Badge resolves deterministically to on-device offline tiers (never cloud) and never flaps over time.
    const badge = page.getByTestId("voice-engine-status-badge");
    await expect(badge).toHaveAttribute("data-stt-tier", "browser_wasm");
    await expect(badge).toHaveAttribute(
      "data-tts-tier",
      /^(local_offline|browser_wasm)$/,
    );
    const initialTtsTier =
      (await badge.getAttribute("data-tts-tier")) ?? "local_offline";
    await page.waitForTimeout(1_600);
    await expect(badge).toHaveAttribute("data-stt-tier", "browser_wasm");
    await expect(badge).toHaveAttribute("data-tts-tier", initialTtsTier);

    // 2. Open Voice Settings -> enable Google fallback -> close dialog
    await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Giọng đọc mẫu" });
    await expect(dialog).toBeVisible();

    await dialog
      .getByRole("button", {
        name: /Tự động linh hoạt|Máy này \+ Google dự phòng/,
      })
      .click();
    await dialog.getByRole("button", { name: "Đóng hộp thoại" }).click();
    await expect(dialog).toBeHidden();
    await expect(badge).toHaveAttribute("data-tts-tier", "google_cloud");

    // 3. Play sample ("Nghe đọc mẫu cả trang") #1 -> fetches /voice/text-to-speech/timed and caches in IndexedDB
    const sampleButton = page.getByRole("button", {
      name: "Nghe đọc mẫu cả trang",
    });
    await sampleButton.click();
    await expect
      .poll(() => metrics.timedCalls, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(1);
    expect(metrics.http409Count).toBe(0);

    // Wait for short 0.35s sample playback + async IDB write to complete cleanly
    await page.waitForTimeout(1_000);

    // 4. Reload page to clear all in-memory JS caches and verify IndexedDB cache hit (0 extra timed network calls!)
    await page.reload();
    await page.waitForSelector("[data-word-id]", { timeout: 25_000 });
    await expect(badge).toHaveAttribute("data-tts-tier", "google_cloud");
    const timedCallsBeforeReloadRepeat = metrics.timedCalls;
    await page.getByRole("button", { name: "Nghe đọc mẫu cả trang" }).click();
    await page.waitForTimeout(1_000);
    expect(metrics.timedCalls).toBe(timedCallsBeforeReloadRepeat);
    expect(metrics.http409Count).toBe(0);

    // 5. Re-open settings while session voice is locked to North -> click Miền Nam tab (filter only, no relock!)
    //    -> click Nghe thử (omits session_id) -> select Cô Mai (Google) + click Nghe thử -> ZERO 409!
    await page.getByRole("button", { name: "Giọng đọc", exact: true }).click();
    await expect(dialog).toBeVisible();
    const relocksBeforeTab = metrics.relockCalls;
    await dialog.getByRole("button", { name: "Miền Nam" }).click();
    expect(metrics.relockCalls).toBe(relocksBeforeTab);

    const southVoiceRadio = dialog.getByRole("radio", {
      name: /Cô Mai \(Google\)/,
    });
    await expect(southVoiceRadio).toBeVisible();
    await southVoiceRadio.click();
    await expect
      .poll(() => metrics.relockCalls, { timeout: 5_000 })
      .toBeGreaterThan(relocksBeforeTab);

    const timedCallsBeforePreview = metrics.timedCalls;
    await dialog.getByRole("button", { name: /Nghe thử/ }).click();
    await expect
      .poll(() => metrics.timedCalls, { timeout: 10_000 })
      .toBeGreaterThan(timedCallsBeforePreview);
    const previewBody = metrics.timedBodies[metrics.timedBodies.length - 1];
    expect(previewBody?.session_id).toBeUndefined();
    expect(metrics.http409Count).toBe(0);
    await dialog.getByRole("button", { name: "Đóng hộp thoại" }).click();
    await expect(dialog).toBeHidden();
  });

  test("keeps reading controls interactive (non-blocking tts-error) and skips duplicate short TTS roundtrip on 503 LOCAL_VOICE_UNCONFIGURED", async ({
    page,
  }) => {
    await page.route("**/workers/sherpa-tts-worker.js", (route) =>
      route.abort(),
    );
    await page.addInitScript(() => {
      Object.defineProperty(window, "speechSynthesis", {
        configurable: true,
        value: {
          getVoices: () => [],
          speak: () => {},
          cancel: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      });
    });
    const { metrics } = await installHostedVercelReadingSession(page, {
      hostedUnconfigured: true,
      forceTts503: true,
    });

    const sampleButton = page.getByRole("button", {
      name: "Nghe đọc mẫu cả trang",
    });
    const micButton = page.getByRole("button", {
      name: "Bé đọc với nhận diện giọng nói",
    });

    // Trigger TTS 503 -> enters recoverable non-blocking tts-error without duplicate /voice/text-to-speech roundtrip
    await sampleButton.click();
    await expect.poll(() => metrics.timedCalls, { timeout: 10_000 }).toBe(1);
    await expect(page.getByTestId("tts-error-banner")).toBeVisible();
    await page.waitForTimeout(300);
    expect(metrics.shortCalls).toBe(0);

    // Reading controls MUST remain enabled and unobstructed (no full-screen backdrop) so the child can still read!
    await expect(micButton).toBeEnabled();
    await expect(sampleButton).toBeEnabled();
    const firstWord = page.locator("[data-word-id]").first();
    await expect(firstWord).toBeVisible();

    // Child can still click mic directly (auto-clearing tts-error banner) and read live words
    await micButton.click();
    await expect(page.getByTestId("tts-error-banner")).toBeHidden();
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            (
              window as unknown as {
                __overhaulStt: { count: () => number };
              }
            ).__overhaulStt.count(),
          ),
        { timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(1);
    await page.evaluate(() => {
      (
        window as unknown as {
          __overhaulStt: { emit: (s: string, fin: boolean) => void };
        }
      ).__overhaulStt.emit("Buổi sáng mùa xuân", true);
    });
    await expect(firstWord).toHaveAttribute("data-reading-state", "correct");
  });
});
