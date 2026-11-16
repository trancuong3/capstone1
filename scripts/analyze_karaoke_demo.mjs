/** Offline analysis artifact only: decode the tracked demo MP3 using Chromium.
 * No Auth/Storage/API requests, no uploads, no lyric timing guesses or runtime imports.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requireFrontend = createRequire(path.join(root, "frontend/package.json"));
const { chromium } = requireFrontend("@playwright/test");
const audio = fs.readFileSync(
  path.join(root, "docs/karaoke-demo/ngoi-sao-nho.mp3"),
);
const cache = path.join(root, ".cache");
fs.mkdirSync(cache, { recursive: true });
const out = fs.mkdtempSync(path.join(cache, "karaoke-v2-audio-"));
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const result = await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const decoder = new OfflineAudioContext(1, 1, 16000);
    const buffer = await decoder.decodeAudioData(bytes.buffer);
    const pcm = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const samples = buffer.getChannelData(c);
      for (let i = 0; i < samples.length; i++)
        pcm[i] += samples[i] / buffer.numberOfChannels;
    }
    return {
      sampleRate: buffer.sampleRate,
      duration: buffer.duration,
      samples: Array.from(pcm),
    };
  }, audio.toString("base64"));
  const pcm = Float32Array.from(result.samples);
  fs.writeFileSync(path.join(out, "mono.f32"), Buffer.from(pcm.buffer));
  fs.writeFileSync(
    path.join(out, "metadata.json"),
    JSON.stringify(
      {
        sample_rate: result.sampleRate,
        duration_seconds: result.duration,
        samples: pcm.length,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      artifact_directory: out,
      sample_rate: result.sampleRate,
      duration_seconds: result.duration,
      samples: pcm.length,
    }),
  );
} finally {
  await browser.close();
}
