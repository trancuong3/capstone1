/* Native Vietnamese ASR bench. Use only a WAV approved for processing by the
 * selected browser's speech service. No user profile or physical input is used.
 * Run from frontend: node scripts/benchmark-karaoke-mic.mjs chrome --reviewed-wav <file.wav> <lyrics.json> [offsetMs]
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "vite";

const [channel, confirmAudio, wavPath, lyricsPath, offset = "0"] =
  process.argv.slice(2);
const offsetMs = Number(offset);
if (
  !["chrome", "msedge"].includes(channel) ||
  confirmAudio !== "--reviewed-wav" ||
  !wavPath ||
  !lyricsPath ||
  !Number.isSafeInteger(offsetMs) ||
  offsetMs < 0
)
  throw Error(
    "Expected chrome|msedge --reviewed-wav <approved PCM WAV> <lyrics JSON> [offsetMs]",
  );

const frontend = fileURLToPath(new URL("../", import.meta.url));
const media = fs.readFileSync(wavPath);
if (
  media.toString("ascii", 0, 4) !== "RIFF" ||
  media.toString("ascii", 8, 12) !== "WAVE"
)
  throw Error("A PCM WAV is required for Chromium fake audio capture.");
const input = JSON.parse(fs.readFileSync(lyricsPath, "utf8"));
const lyrics = input.lyrics ?? input;
const entry = path
  .join(frontend, "native-score-probe.tsx")
  .replaceAll("\\", "/");
const source = [
  'import React from "react";',
  'import {createRoot} from "react-dom/client";',
  'import {useKaraokeScoring} from "@/hooks/use-karaoke-scoring";',
  'const player = document.querySelector("audio");',
  "const time = () => window.benchInput.offsetMs + player.currentTime * 1000;",
  "function Probe() {",
  "  const mic = useKaraokeScoring(window.benchInput.lyrics, time);",
  "  window.currentMic = mic;",
  "  React.useEffect(() => {",
  "    let frame; let previous = null;",
  "    function tick() {",
  "      const now = time();",
  "      if (!player.paused && !player.ended && window.currentMic?.status === 'listening') {",
  "        if (previous !== null && now > previous && now - previous <= 650) { window.currentMic.observePlayback(previous, now); window.playbackTicks = (window.playbackTicks || 0) + 1; }",
  "        previous = now;",
  "      } else previous = null;",
  "      frame = requestAnimationFrame(tick);",
  "    }",
  "    frame = requestAnimationFrame(tick); return () => cancelAnimationFrame(frame);",
  "  }, []);",
  '  if (window.endTime != null && window.finalizeMs == null && ["scored", "insufficient"].includes(mic.status))',
  "    window.finalizeMs = Math.round(performance.now() - window.endTime);",
  "  async function run() {",
  "    if (!await mic.arm()) return;",
  "    await new Promise(r => setTimeout(r, 3000));",
  "    player.onended = () => { window.endTime = performance.now(); mic.finish(); };",
  "    await player.play(); mic.resume();",
  "  }",
  '  return React.createElement("button", {onClick: run}, "Start");',
  "}",
  'createRoot(document.getElementById("probe")).render(React.createElement(Probe));',
].join("\n");
const bundles = await build({
  root: frontend,
  configFile: false,
  publicDir: false,
  envDir: false,
  logLevel: "error",
  resolve: { alias: { "@": frontend } },
  plugins: [
    {
      name: "native-karaoke-score-probe",
      enforce: "pre",
      resolveId(id) {
        if (id.endsWith("native-score-probe.tsx")) return entry;
      },
      load(id) {
        if (id === entry) return source;
      },
    },
  ],
  define: { "process.env.NODE_ENV": '"production"' },
  build: {
    write: false,
    lib: { entry, name: "NativeMicProbe", formats: ["iife"] },
  },
});
const bundle = [bundles]
  .flat()
  .flatMap((result) => result.output)
  .find((o) => o.type === "chunk").code;

const server = http.createServer((req, res) => {
  if (req.url === "/clock") {
    res.setHeader("Content-Type", "audio/wav");
    res.end(media);
  } else if (req.url === "/probe.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(bundle);
  } else if (req.url === "/") {
    res.setHeader("Content-Type", "text/html;charset=utf-8");
    res.end(
      '<audio muted preload="auto" src="/clock"></audio><div id="probe"></div><script src="/probe.js"></script>',
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({
    channel,
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-audio-capture=" + path.resolve(wavPath),
    ],
  });
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(error.message));
  await page.addInitScript(
    (data) => {
      window.benchInput = data;
      const Native = window.SpeechRecognition ?? window.webkitSpeechRecognition;
      window.events = {
        boundStarts: 0,
        defaultStarts: 0,
        finals: 0,
        errors: [],
        transcripts: [],
      };
      if (!Native) return;
      Object.defineProperty(window, "SpeechRecognition", {
        value: new Proxy(Native, {
          construct(target, args) {
            const rec = Reflect.construct(target, args);
            const seenFinals = new Set();
            const start = rec.start;
            rec.start = function (...args) {
              if (!args[0]) {
                window.events.defaultStarts++;
                throw Error("This benchmark requires explicit track input");
              }
              if (args[0].readyState === "live" && !/fake/i.test(args[0].label))
                throw Error("Unexpected live audio track");
              const value = start.apply(this, args);
              if (args[0].readyState === "live") window.events.boundStarts++;
              return value;
            };
            rec.addEventListener("result", (e) => {
              for (let i = e.resultIndex; i < e.results.length; i++) {
                if (e.results[i].isFinal && !seenFinals.has(i)) {
                  seenFinals.add(i);
                  window.events.transcripts.push(e.results[i][0].transcript);
                }
              }
              if (
                Array.from(e.results)
                  .slice(e.resultIndex)
                  .some((r) => r.isFinal)
              )
                window.events.finals++;
            });
            rec.addEventListener("error", (e) =>
              window.events.errors.push(e.error),
            );
            return rec;
          },
        }),
      });
    },
    { lyrics, offsetMs },
  );
  await page.goto("http://127.0.0.1:" + server.address().port);
  await page.waitForFunction(() =>
    Number.isFinite(document.querySelector("audio")?.duration),
  );
  const duration = await page.evaluate(async () => {
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "audioinput",
    );
    if (!inputs.length || inputs.some((d) => !/fake/i.test(d.label)))
      throw Error("Fake input devices required");
    return document.querySelector("audio").duration;
  });
  await page.getByRole("button", { name: "Start" }).click();
  await page.waitForFunction(
    () =>
      (window.currentMic?.status === "unavailable" &&
        document.querySelector("audio").paused) ||
      window.finalizeMs != null,
    null,
    { timeout: (duration + 30) * 1000 },
  );
  const result = await page.evaluate(() => {
    const { status, error, score, liveScore } = window.currentMic;
    const report = score ?? liveScore;
    return {
      ...window.events,
      status,
      error,
      finalizeMs: window.finalizeMs ?? null,
      kind: report?.kind,
      evaluated: report?.evaluatedWords,
      matched: report?.matchedWords,
      total: report?.totalWords,
      playbackTicks: window.playbackTicks ?? 0,
      words: report?.lineScores.flatMap((l) =>
        l.words.map((w) => ({ id: w.id, text: w.text, state: w.state })),
      ),
      matchedIds: report?.lineScores.flatMap((l) =>
        l.words.filter((w) => w.state === "matched").map((w) => w.id),
      ),
    };
  });
  console.log(
    JSON.stringify({
      channel,
      browser: browser.version(),
      wavSha256: createHash("sha256").update(media).digest("hex"),
      duration,
      offsetMs,
      ...result,
    }),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    server.close();
  }
}
