import { normalizeVietnameseText } from "@/lib/reading/vietnamese-text";

/**
 * Giọng nói điều khiển trong lúc đọc & luyện từ khó. Chỉ nhận cả câu nói ngắn
 * (một lệnh), không tìm lệnh bên trong câu dài, và luôn nhường cho văn bản sách
 * khi cụm lệnh trùng với đoạn bé sắp đọc.
 */
export type VoiceIntentType =
  "HELP" | "SPELL" | "REPLAY" | "WAIT" | "STOP" | "RESUME" | "NONE";

export interface VoiceIntent {
  readonly type: VoiceIntentType;
  /** Why NONE was returned (diagnostics, tests). */
  readonly reason?:
    "not-a-command" | "in-book" | "low-confidence" | "too-long" | "empty";
}

export interface VoiceIntentContext {
  /** Text the child is expected to read next (a window is enough). */
  readonly upcomingText?: string;
  /** STT confidence 0..1 when the provider supplies one on a comparable scale. */
  readonly confidence?: number | null;
  /** Minimum confidence for non-stop commands. */
  readonly minConfidence?: number;
}

const POLITE_PREFIX = /^(?:(?:cô|thầy|mẹ|ba) )?(?:ơi )?/u;
const POLITE_SUFFIX =
  /(?: (?:ạ|nhé|nha|đi|với|một chút|chút|xíu|một xíu|chút xíu))*$/u;

const COMMANDS: readonly {
  type: VoiceIntentType;
  patterns: readonly RegExp[];
}[] = [
  {
    type: "SPELL",
    patterns: [
      /^(?:cô |thầy )?đánh vần(?: giúp| cho| hộ)?(?: con| bé| em)?(?: từ này| chữ này| tiếng này)?$/u,
      /^(?:cho )?(?:con |bé |em )?nghe đánh vần(?: từ này| chữ này| tiếng này)?$/u,
      /^(?:con|bé|em) (?:muốn|cần) (?:cô |thầy )?đánh vần(?: giúp)?$/u,
    ],
  },
  {
    type: "HELP",
    patterns: [
      /^(?:con|bé|em) (?:không|chưa) biết(?: đọc)?(?: từ này| chữ này| chỗ này)?$/u,
      /^(?:cô |thầy )?đọc mẫu(?: giúp| cho| hộ)?(?: con| bé| em)?$/u,
      /^(?:cô |thầy )?đọc(?: giúp| cho| hộ) (?:con|bé|em)$/u,
      /^(?:cô |thầy )?giúp (?:con|bé|em) đọc(?: từ này| chữ này)?$/u,
      /^(?:con|bé|em) cần (?:cô )?(?:giúp|đọc mẫu)$/u,
    ],
  },
  {
    type: "REPLAY",
    patterns: [
      /^(?:cô |thầy )?(?:đọc|nghe) lại(?: lần nữa| một lần nữa| giúp con| cho con)?$/u,
      /^(?:cho )?(?:con |bé |em )?nghe lại(?: từ này| chữ này)?$/u,
    ],
  },
  {
    type: "WAIT",
    patterns: [
      /^(?:đợi|chờ)(?: con| bé| em)?$/u,
      /^(?:con|bé|em) (?:đang )?(?:nghĩ|suy nghĩ)$/u,
    ],
  },
  {
    type: "STOP",
    patterns: [
      /^(?:con |bé |em )?(?:dừng|tạm dừng|ngừng)(?: lại| đọc| nghe)?$/u,
      /^(?:con |bé |em )?(?:không|thôi) đọc nữa$/u,
    ],
  },
  {
    type: "RESUME",
    patterns: [
      /^(?:con |bé |em )?(?:đọc tiếp|tiếp tục|đọc nữa)$/u,
      /^(?:cho )?(?:con |bé |em )?(?:đọc tiếp|tiếp tục)(?: bài)?$/u,
    ],
  },
];

const MAX_COMMAND_TOKENS = 8;

function stripCourtesy(spoken: string): string {
  return spoken.replace(POLITE_PREFIX, "").replace(POLITE_SUFFIX, "").trim();
}

function appearsInBook(candidate: string, upcomingText?: string): boolean {
  if (!upcomingText) return false;
  const book = ` ${normalizeVietnameseText(upcomingText)} `;
  const phrase = candidate.trim();
  return phrase.length > 0 && book.includes(` ${phrase} `);
}

export function parseVoiceIntent(
  text: string,
  context: VoiceIntentContext = {},
): VoiceIntent {
  const spoken = normalizeVietnameseText(text);
  if (!spoken) return { type: "NONE", reason: "empty" };
  if (spoken.split(" ").length > MAX_COMMAND_TOKENS) {
    return { type: "NONE", reason: "too-long" };
  }
  const variants = Array.from(new Set([spoken, stripCourtesy(spoken)])).filter(
    Boolean,
  );
  for (const command of COMMANDS) {
    const matched = variants.some((variant) =>
      command.patterns.some((pattern) => pattern.test(variant)),
    );
    if (!matched) continue;
    // The passage takes precedence when the child is simply reading it.
    if (
      variants.some((variant) => appearsInBook(variant, context.upcomingText))
    ) {
      return { type: "NONE", reason: "in-book" };
    }
    const confidence = context.confidence;
    const threshold = context.minConfidence ?? 0.6;
    if (
      confidence != null &&
      Number.isFinite(confidence) &&
      confidence > 0 &&
      confidence < threshold
    ) {
      return { type: "NONE", reason: "low-confidence" };
    }
    return { type: command.type };
  }
  return { type: "NONE", reason: "not-a-command" };
}
