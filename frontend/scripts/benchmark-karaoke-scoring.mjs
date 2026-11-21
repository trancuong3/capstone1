// Deterministic evidence replay. This measures classification, not ASR quality.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const frontend = fileURLToPath(new URL("../", import.meta.url));
const [baselineRef, output] = process.argv.slice(2);
if (baselineRef && !/^[a-f0-9]{7,40}$/i.test(baselineRef))
  throw Error("Use an immutable Git commit hash");

function lyrics(text = "bé hát vui", timed = true) {
  const words = text.split(" ");
  return {
    format_version: timed ? 2 : 1,
    lines: [
      {
        id: "line",
        text,
        start_ms: 1000,
        end_ms: 1000 + words.length * 1000,
        ...(timed
          ? {
              syllables: words.map((text, i) => ({
                id: `s${i}`,
                text,
                start_ms: 1000 + i * 1000,
                end_ms: 2000 + i * 1000,
              })),
            }
          : {}),
      },
    ],
  };
}
const M = "matched",
  D = "different",
  O = "omitted",
  U = "unknown";
// Calibration cases reproduce inspected failures. Held-out expectations were
// fixed before running this replay and must not be silently changed to pass.
const cases = [
  {
    id: "correct",
    split: "calibration",
    text: "bé hát vui",
    expected: [M, M, M],
  },
  {
    id: "substitution",
    split: "calibration",
    text: "bé nói vui",
    expected: [M, D, M],
  },
  {
    id: "interior-missing",
    split: "calibration",
    text: "bé vui",
    expected: [M, O, M],
  },
  {
    id: "unknown-leading-edge",
    split: "calibration",
    text: "hát vui",
    expected: [U, M, M],
  },
  {
    id: "no-recognition",
    split: "calibration",
    playback: true,
    expected: [U, U, U],
  },
  {
    id: "ambiguous-preview",
    split: "calibration",
    song: lyrics("bé bé vui", false),
    preview: true,
    text: "bé vui",
    expected: [U, U, M],
  },
  {
    id: "future-preview",
    split: "calibration",
    preview: true,
    text: "bé hát vui",
    to: 1500,
    expected: [M, U, U],
  },
  {
    id: "longer-omission",
    split: "held-out",
    song: lyrics("con mèo nhỏ ngủ ngoan"),
    text: "con mèo ngủ ngoan",
    to: 6000,
    expected: [M, M, O, M, M],
  },
  {
    id: "all-different",
    split: "held-out",
    text: "xe chạy nhanh",
    expected: [D, D, D],
  },
  {
    id: "extra-word",
    split: "held-out",
    text: "bé rất hát vui",
    expected: [M, M, M],
  },
  {
    id: "all-repeated-preview",
    split: "held-out",
    song: lyrics("la la la", false),
    preview: true,
    text: "la",
    expected: [U, U, U],
  },
  {
    id: "timed-repeat",
    split: "held-out",
    song: lyrics("la la la"),
    text: "la",
    to: 2000,
    expected: [M, U, U],
  },
  {
    id: "seek-boundary",
    split: "held-out",
    text: "bé",
    from: 2100,
    to: 2400,
    earliest: 2000,
    expected: [U, U, U],
  },
  {
    id: "delayed-final",
    split: "held-out",
    text: "bé",
    from: 2100,
    to: 2400,
    earliest: 1000,
    expected: [M, U, U],
  },
  {
    id: "late-missing-asr",
    split: "held-out",
    song: lyrics("con mèo nhỏ ngủ ngoan"),
    playback: true,
    to: 6000,
    expected: [U, U, U, U, U],
  },
  {
    id: "too-short-to-prove-wrong",
    split: "held-out",
    text: "xe chạy nhanh",
    from: 1100,
    to: 1200,
    expected: [U, U, U],
  },
];

async function engine(ref) {
  const target = path
    .join(frontend, "lib/karaoke/live-singing-score.ts")
    .replaceAll("\\", "/");
  const baseline = ref
    ? execFileSync(
        "git",
        ["show", `${ref}:frontend/lib/karaoke/live-singing-score.ts`],
        { cwd: frontend, encoding: "utf8" },
      )
    : null;
  const bundle = await build({
    root: frontend,
    configFile: false,
    envDir: false,
    publicDir: false,
    logLevel: "error",
    resolve: { alias: { "@": frontend } },
    plugins: baseline
      ? [
          {
            name: "pinned-karaoke-baseline",
            enforce: "pre",
            load(id) {
              if (id.replaceAll("\\", "/") === target) return baseline;
            },
          },
        ]
      : [],
    build: {
      write: false,
      minify: false,
      lib: { entry: target, formats: ["es"] },
    },
  });
  const code = [bundle]
    .flat()
    .flatMap((b) => b.output)
    .find((o) => o.type === "chunk").code;
  return (
    await import(
      `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
    )
  ).LiveSingingAttempt;
}

function replay(Attempt) {
  const results = cases.map((c) => {
    const song = c.song ?? lyrics();
    const attempt = new Attempt(song);
    const end = c.to ?? 4000;
    if (c.playback) {
      for (let ms = 1000; ms < end + 500; ms += 100)
        attempt.observePlayback(ms, ms + 100);
      attempt.flushPlayedOmissions(end + 500);
    }
    let preview;
    if (c.text) {
      if (c.preview)
        preview = attempt.preview(c.text, c.from ?? 1000, end, c.earliest ?? 0);
      else attempt.accept(c.text, c.from ?? 1000, end, c.earliest ?? 0);
    }
    const words = attempt.result().lineScores.flatMap((line) => line.words);
    const actual = words.map((w) =>
      preview ? (preview.get(w.id) ?? U) : w.state,
    );
    return {
      id: c.id,
      split: c.split,
      preview: !!c.preview,
      expected: c.expected,
      actual,
      passed: JSON.stringify(actual) === JSON.stringify(c.expected),
    };
  });
  const matrix = Object.fromEntries(
    [M, D, O, U].map((s) => [
      s,
      Object.fromEntries([M, D, O, U].map((t) => [t, 0])),
    ]),
  );
  for (const result of results)
    result.expected.forEach((state, i) => matrix[state][result.actual[i]]++);
  const expectedAssessed = results
    .flatMap((r) => r.expected)
    .filter((s) => s !== U).length;
  const assessed = results
    .flatMap((r) => r.actual)
    .filter((s) => s !== U).length;
  return {
    cases: results.length,
    passed: results.filter((r) => r.passed).length,
    expectedAssessed,
    assessed,
    matrix,
    results,
  };
}

const baseline = baselineRef ? replay(await engine(baselineRef)) : null;
const current = replay(await engine());
const report = {
  kind: "synthetic-evidence-replay-not-asr-accuracy",
  baselineRef: baselineRef ?? null,
  baseline,
  current,
};
if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(
  JSON.stringify({
    baseline: baseline && `${baseline.passed}/${baseline.cases}`,
    current: `${current.passed}/${current.cases}`,
    matrix: current.matrix,
  }),
);
if (current.passed !== current.cases) {
  console.error(JSON.stringify(current.results.filter((r) => !r.passed)));
  process.exitCode = 1;
}
