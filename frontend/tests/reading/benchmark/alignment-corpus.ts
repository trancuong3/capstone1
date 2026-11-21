/**
 * Synthetic, transcript-level evidence corpus for the automatic reading flow.
 *
 * PROVENANCE / HONESTY
 * - Every case was authored by the ViRead engineering team as a scripted
 *   speech-recognition event stream. There is NO recorded audio, NO child
 *   voice and NO real ASR error distribution here. Results measure the
 *   alignment/evidence/echo logic only and must never be reported as WER/CER
 *   or as "child speech recognition accuracy".
 * - Split: `TUNING_CASES` may be inspected and used to fix defects.
 *   `HOLDOUT_CASES` were written before any engine change and are evaluated
 *   once for the final verdict. A holdout case that is opened to debug a fix
 *   must be moved to `TUNING_CASES` and replaced by a fresh holdout case.
 *
 * Expected labels (per book word, in book order):
 *   C  must be graded CORRECT (green)
 *   W  must be graded RETRY (wrong reading, not green)
 *   S  must be graded SKIPPED (omitted, not green)
 *   H  was helped by the app; must NOT be CORRECT (assisted/any non-green)
 *   N  no reliable evidence: must be NO_EVIDENCE (no colour, no penalty)
 *   L  lenient / ambiguous by construction: anything except CORRECT-by-echo
 *      is acceptable; not counted in any rate
 */

export type CorpusLabel = "C" | "W" | "S" | "H" | "N" | "L";

export type CorpusGroup =
  | "fluent"
  | "repeat"
  | "self-correct"
  | "restart"
  | "skip"
  | "wrong"
  | "off-topic"
  | "echo"
  | "duplicate-words"
  | "pause"
  | "unicode-number"
  | "uncertain";

export type CorpusEvent =
  | {
      readonly t: number;
      readonly k: "final";
      readonly text: string;
      /** VAD speech-onset timestamp, when the recorder knows it. */
      readonly onset?: number;
      /** Analysis only; pipelines never see it. */
      readonly src?: "child" | "tts" | "tv";
    }
  | { readonly t: number; readonly k: "interim"; readonly text: string }
  | {
      readonly t: number;
      readonly k: "tts";
      readonly text: string;
      readonly dur: number;
    }
  | { readonly t: number; readonly k: "uncertain" }
  | { readonly t: number; readonly k: "finish" };

export interface CorpusCase {
  readonly id: string;
  readonly group: CorpusGroup;
  readonly book: string;
  readonly expected: string;
  readonly events: readonly CorpusEvent[];
  readonly note: string;
}

const A = "Bé Lan đi học cùng mẹ";
const B = "Mẹ nấu cơm cho cả nhà ăn";
const D = "Ba đi làm. Ba về nhà. Ba ăn cơm với mẹ";
const N1 = "Mai có 2 quả cam";

const f = (
  t: number,
  text: string,
  src: "child" | "tts" | "tv" = "child",
  onset?: number,
): CorpusEvent => ({ t, k: "final", text, src, onset });
const fin = (t: number): CorpusEvent => ({ t, k: "finish" });

export const TUNING_CASES: readonly CorpusCase[] = [
  {
    id: "t01-fluent-single-final",
    group: "fluent",
    book: A,
    expected: "C C C C C C",
    events: [f(1000, "Bé Lan đi học cùng mẹ"), fin(5000)],
    note: "baseline fluent reading",
  },
  {
    id: "t02-fluent-three-finals",
    group: "fluent",
    book: A,
    expected: "C C C C C C",
    events: [f(1000, "Bé"), f(2200, "Lan đi"), f(3400, "học cùng mẹ"), fin(6000)],
    note: "segment boundaries must not matter",
  },
  {
    id: "t03-fluent-token-finals",
    group: "fluent",
    book: A,
    expected: "C C C C C C",
    events: [
      f(500, "Bé"),
      f(1400, "Lan"),
      f(2300, "đi"),
      f(3200, "học"),
      f(4100, "cùng"),
      f(5000, "mẹ"),
      fin(7000),
    ],
    note: "slow, syllable by syllable",
  },
  {
    id: "t04-repeat-word",
    group: "repeat",
    book: A,
    expected: "C C C C C C",
    events: [f(1000, "Bé Lan Lan đi học cùng mẹ"), fin(6000)],
    note: "repeated word counts once",
  },
  {
    id: "t05-self-correct-inline",
    group: "self-correct",
    book: B,
    expected: "C C C C C C C",
    events: [f(1000, "Mẹ nấu cớm cơm cho cả nhà ăn"), fin(8000)],
    note: "mispronounces then fixes immediately",
  },
  {
    id: "t06-self-correct-after-advance",
    group: "self-correct",
    book: B,
    expected: "C C C C C C C",
    events: [f(1000, "Mẹ nấu cớm cho cơm cho cả nhà ăn"), fin(9000)],
    note: "goes on, then returns to fix the wrong word",
  },
  {
    id: "t07-restart-sentence",
    group: "restart",
    book: A,
    expected: "C C C C C C",
    events: [f(1000, "Bé Lan đi học Bé Lan đi học cùng mẹ"), fin(8000)],
    note: "re-reads the sentence from the start",
  },
  {
    id: "t08-restart-after-error",
    group: "restart",
    book: A,
    expected: "C C C C C C",
    events: [f(1000, "Bé Lan đi hộp Bé Lan đi học cùng mẹ"), fin(8000)],
    note: "error, restart, then reads correctly",
  },
  {
    id: "t09-skip-one-word",
    group: "skip",
    book: A,
    expected: "C C S C C C",
    events: [f(1000, "Bé Lan học cùng mẹ"), fin(6000)],
    note: "omits a word",
  },
  {
    id: "t10-omit-last-word",
    group: "skip",
    book: A,
    expected: "C C C C C S",
    events: [f(1000, "Bé Lan đi học cùng"), fin(6000)],
    note: "stops before the last word",
  },
  {
    id: "t11-wrong-word",
    group: "wrong",
    book: A,
    expected: "C C C W C C",
    events: [f(1000, "Bé Lan đi hộp cùng mẹ"), fin(6000)],
    note: "clear substitution",
  },
  {
    id: "t12-tone-confusion",
    group: "wrong",
    book: A,
    expected: "C C C C W C",
    events: [f(1000, "Bé Lan đi học cung mẹ"), fin(6000)],
    note: "cùng vs cung: tone must be preserved",
  },
  {
    id: "t13-d-vs-dd",
    group: "wrong",
    book: A,
    expected: "C C W C C C",
    events: [f(1000, "Bé Lan di học cùng mẹ"), fin(6000)],
    note: "đi vs di",
  },
  {
    id: "t14-off-topic-tv",
    group: "off-topic",
    book: B,
    expected: "N N N N N N N",
    events: [f(1000, "hôm nay trời mưa to lắm", "tv")],
    note: "no word overlaps the book",
  },
  {
    id: "t15-off-topic-one-coincidence",
    group: "off-topic",
    book: B,
    expected: "N N N N N N N",
    events: [f(1000, "mẹ ơi nhà mình có khách", "tv")],
    note: "only the first word coincides with the book",
  },
  {
    id: "t16-off-topic-two-coincidences",
    group: "off-topic",
    book: D,
    expected: "N N N N N N N N N N N",
    events: [f(1000, "ba ơi mẹ đi chợ chưa", "tv")],
    note: "scattered coincidences must not score or penalise",
  },
  {
    id: "t17-echo-during-and-tail",
    group: "echo",
    book: B,
    expected: "C C C H C C C",
    events: [
      f(1500, "Mẹ nấu cơm"),
      { t: 4000, k: "tts", text: "cho", dur: 600 },
      f(4300, "cho", "tts", 4100),
      f(4900, "cho", "tts", 4100),
      f(8800, "cả nhà ăn", "child", 8000),
      fin(12000),
    ],
    note: "echo while playing and 300 ms after the sample ends",
  },
  {
    id: "t18-echo-phrase-after-tts",
    group: "echo",
    book: B,
    expected: "C H H H C C C",
    events: [
      f(1500, "Mẹ"),
      { t: 4000, k: "tts", text: "nấu cơm cho", dur: 1400 },
      f(5800, "nấu cơm cho", "tts", 4200),
      f(9800, "cả nhà ăn", "child", 9000),
      fin(13000),
    ],
    note: "whole phrase echoed after the sample finished",
  },
  {
    id: "t19-imitation-after-sample",
    group: "echo",
    book: B,
    expected: "C C C H C C C",
    events: [
      f(1500, "Mẹ nấu cơm"),
      { t: 4000, k: "tts", text: "cho", dur: 600 },
      f(5200, "cho", "child", 4900),
      f(6600, "cả nhà ăn", "child", 6000),
      fin(10000),
    ],
    note: "child imitating AFTER the sample is real speech but is assisted",
  },
  {
    id: "t20-number-word",
    group: "unicode-number",
    book: N1,
    expected: "C C C C C",
    events: [f(1000, "Mai có hai quả cam"), fin(6000)],
    note: "book digit 2 read as 'hai'",
  },
  {
    id: "t21-nfd-transcript",
    group: "unicode-number",
    book: A,
    expected: "C C C C C C",
    events: [f(1000, "Bé Lan đi học cùng mẹ".normalize("NFD")), fin(5000)],
    note: "decomposed Unicode must match composed book text",
  },
  {
    id: "t22-jump-line",
    group: "duplicate-words",
    book: D,
    expected: "C C C L L L L C C C C",
    events: [f(1000, "Ba đi làm ba ăn cơm với mẹ"), fin(8000)],
    note: "skips 'về nhà'; the lone 'ba' is ambiguous (idx 3 or 6); re-anchors on the later bigram",
  },
  {
    id: "t23-pause-long",
    group: "pause",
    book: A,
    expected: "C C C C C C",
    events: [f(1000, "Bé Lan"), f(16000, "đi học cùng mẹ"), fin(22000)],
    note: "long hesitation is not an error",
  },
  {
    id: "t24-uncertain-gap",
    group: "uncertain",
    book: B,
    expected: "C C N C C C C",
    events: [
      f(1000, "Mẹ nấu"),
      { t: 2000, k: "uncertain" },
      f(3000, "cho cả nhà ăn"),
      fin(8000),
    ],
    note: "unclear audio never invents an omission",
  },
];

const H1 = "Chú chó nhỏ chạy theo bà ra vườn";
const H2 = "Trời mưa to. Mưa rơi trên mái nhà. Mưa tạnh rồi.";
const H3 = "Em hái hoa tặng cô giáo";
const H4 = "Lan có 3 con mèo";

export const HOLDOUT_CASES: readonly CorpusCase[] = [
  {
    id: "h01-fluent-whole",
    group: "fluent",
    book: H1,
    expected: "C C C C C C C C",
    events: [f(1000, "Chú chó nhỏ chạy theo bà ra vườn"), fin(7000)],
    note: "fluent",
  },
  {
    id: "h02-fluent-pairs",
    group: "fluent",
    book: H1,
    expected: "C C C C C C C C",
    events: [
      f(1000, "Chú chó"),
      f(2500, "nhỏ chạy"),
      f(4000, "theo bà"),
      f(5500, "ra vườn"),
      fin(9000),
    ],
    note: "two-word finals",
  },
  {
    id: "h03-repeat-first-word",
    group: "repeat",
    book: H3,
    expected: "C C C C C C",
    events: [f(1000, "Em em hái hoa tặng cô giáo"), fin(7000)],
    note: "repeat at the very start",
  },
  {
    id: "h04-self-correct-inline",
    group: "self-correct",
    book: H1,
    expected: "C C C C C C C C",
    events: [f(1000, "Chú chó nhỏ chạy theo ba bà ra vườn"), fin(8000)],
    note: "ba then bà",
  },
  {
    id: "h05-restart-midsentence",
    group: "restart",
    book: H1,
    expected: "C C C C C C C C",
    events: [f(1000, "Chú chó nhỏ chạy Chú chó nhỏ chạy theo bà ra vườn"), fin(9000)],
    note: "restarts after four words",
  },
  {
    id: "h06-skip-two",
    group: "skip",
    book: H3,
    expected: "C C S S C C",
    events: [f(1000, "Em hái cô giáo"), fin(6000)],
    note: "omits two adjacent words",
  },
  {
    id: "h07-wrong-tone",
    group: "wrong",
    book: H1,
    expected: "C C C C C W C C",
    events: [f(1000, "Chú chó nhỏ chạy theo bả ra vườn"), fin(8000)],
    note: "bà vs bả",
  },
  {
    id: "h08-duplicate-words-fluent",
    group: "duplicate-words",
    book: H2,
    expected: "C C C C C C C C C C C",
    events: [f(1000, "Trời mưa to Mưa rơi trên mái nhà Mưa tạnh rồi"), fin(9000)],
    note: "mưa occurs three times",
  },
  {
    id: "h09-jump-line-duplicates",
    group: "duplicate-words",
    book: H2,
    expected: "C C C L L L L L L C C",
    events: [f(1000, "Trời mưa to Mưa tạnh rồi"), fin(8000)],
    note: "jumps to the last sentence",
  },
  {
    id: "h10-off-topic-tv",
    group: "off-topic",
    book: H3,
    expected: "N N N N N N",
    events: [f(1000, "hôm nay có phim hoạt hình mới", "tv")],
    note: "no overlap",
  },
  {
    id: "h11-off-topic-one-word",
    group: "off-topic",
    book: H1,
    expected: "N N N N N N N N",
    events: [f(1000, "chú ơi cho cháu hỏi đường", "tv")],
    note: "one coincidence at the start",
  },
  {
    id: "h12-echo-single-word",
    group: "echo",
    book: H3,
    expected: "C C H C C C",
    events: [
      f(1500, "Em hái"),
      { t: 3000, k: "tts", text: "hoa", dur: 500 },
      f(3300, "hoa", "tts", 3100),
      f(3900, "hoa", "tts", 3100),
      f(7200, "tặng cô giáo", "child", 6500),
      fin(10000),
    ],
    note: "echo inside and after playback",
  },
  {
    id: "h13-echo-phrase",
    group: "echo",
    book: H1,
    expected: "C C C H H H C C",
    events: [
      f(1500, "Chú chó nhỏ"),
      { t: 4000, k: "tts", text: "chạy theo bà", dur: 1500 },
      f(5900, "chạy theo bà", "tts", 4300),
      f(9800, "ra vườn", "child", 9000),
      fin(13000),
    ],
    note: "phrase echo after playback",
  },
  {
    id: "h14-imitation",
    group: "echo",
    book: H3,
    expected: "C C H C C C",
    events: [
      f(1500, "Em hái"),
      { t: 3000, k: "tts", text: "hoa", dur: 500 },
      f(4600, "hoa", "child", 4000),
      f(6200, "tặng cô giáo", "child", 5500),
      fin(9000),
    ],
    note: "real imitation after the sample",
  },
  {
    id: "h15-self-correct-after-advance",
    group: "self-correct",
    book: H1,
    expected: "C C C C C C C C",
    events: [f(1000, "Chú chó nhỏ chạy theo bả ra bà ra vườn"), fin(9000)],
    note: "returns to fix bà",
  },
  {
    id: "h16-hesitation",
    group: "pause",
    book: H3,
    expected: "C C C C C C",
    events: [f(1000, "Em"), f(12000, "hái hoa"), f(14000, "tặng cô giáo"), fin(18000)],
    note: "long pause only",
  },
  {
    id: "h17-uncertain-gap",
    group: "uncertain",
    book: H1,
    expected: "C C N C C C C C",
    events: [
      f(1000, "Chú chó"),
      { t: 2200, k: "uncertain" },
      f(3500, "chạy theo bà ra vườn"),
      fin(9000),
    ],
    note: "unclear audio",
  },
  {
    id: "h18-number-word",
    group: "unicode-number",
    book: H4,
    expected: "C C C C C",
    events: [f(1000, "Lan có ba con mèo"), fin(6000)],
    note: "digit 3 spoken as 'ba'",
  },
  {
    id: "h19-number-digit-transcript",
    group: "unicode-number",
    book: H4,
    expected: "C C C C C",
    events: [f(1000, "Lan có 3 con mèo"), fin(6000)],
    note: "digit transcript",
  },
  {
    id: "h20-wrong-number",
    group: "wrong",
    book: H4,
    expected: "C C W C C",
    events: [f(1000, "Lan có bốn con mèo"), fin(6000)],
    note: "ba vs bốn is an error",
  },
];

export function bookWords(book: string) {
  return book
    .split(/\s+/u)
    .filter(Boolean)
    .map((text, index) => ({
      text,
      word_index: index,
      word_id: `w${index}`,
      bbox: [0, 0, 1, 1] as [number, number, number, number],
    }));
}
