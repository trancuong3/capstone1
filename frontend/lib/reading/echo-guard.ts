/**
 * Chặn bằng chứng STT do chính giọng đọc mẫu (TTS) tạo ra, kể cả tiếng vọng
 * sau khi mẫu kết thúc.
 *
 * Quy tắc (đã đo trên corpus echo trong `tests/reading/benchmark`):
 * 1. Đang phát mẫu            → loại bỏ mọi kết quả STT.
 * 2. Biết thời điểm bắt đầu nói (VAD `onsetAt`):
 *    - bắt đầu nói trước `endedAt + onsetGraceMs`  → loại (tiếng vọng, hoặc
 *      bé nói chen; chưa đo được khả năng phân biệt nên không dùng làm bằng
 *      chứng, theo yêu cầu "chỉ ngắt lời bằng giọng nói khi đã đo").
 *    - bắt đầu nói sau mốc đó                       → là giọng bé, giữ lại.
 * 3. Không biết `onsetAt`: trong `tailMs` sau khi mẫu kết thúc, loại kết quả
 *    nếu phần lớn từ trùng với văn bản mẫu.
 *
 * Mọi mốc thời gian là mili-giây của cùng một đồng hồ đơn điệu.
 */

import { tokenizeVietnameseText } from "@/lib/reading/vietnamese-text";

export interface EchoGuardOptions {
  /** Echo can outlive the player's `ended` event (room reverb, speaker delay). */
  readonly onsetGraceMs?: number;
  /** Fallback window when the recorder cannot tell when speech started. */
  readonly tailMs?: number;
  /** Share of segment words that must come from the sample to call it echo. */
  readonly overlapThreshold?: number;
  /** Forget playbacks older than this. */
  readonly retainMs?: number;
}

export type EchoVerdictReason =
  | "ok"
  | "playing"
  | "onset-during-playback"
  | "tail-overlap";

export interface EchoVerdict {
  readonly accept: boolean;
  readonly reason: EchoVerdictReason;
  readonly playbackId?: string;
}

export interface EchoSegment {
  readonly text: string;
  readonly receivedAt: number;
  readonly onsetAt?: number | null;
}

interface PlaybackRecord {
  readonly id: string;
  readonly tokens: readonly string[];
  readonly startedAt: number;
  endedAt: number | null;
}

export class EchoGuard {
  private readonly records: PlaybackRecord[] = [];
  private readonly onsetGraceMs: number;
  private readonly tailMs: number;
  private readonly overlapThreshold: number;
  private readonly retainMs: number;

  constructor(options: EchoGuardOptions = {}) {
    this.onsetGraceMs = options.onsetGraceMs ?? 250;
    this.tailMs = options.tailMs ?? 1500;
    this.overlapThreshold = options.overlapThreshold ?? 0.6;
    this.retainMs = options.retainMs ?? 30_000;
  }

  playbackStarted(id: string, text: string, now: number): void {
    this.prune(now);
    this.records.push({
      id,
      tokens: tokenizeVietnameseText(text),
      startedAt: now,
      endedAt: null,
    });
  }

  /** Ended, cancelled or failed: the sample stopped being audible at `now`. */
  playbackEnded(id: string, now: number): void {
    const record = this.records.find((entry) => entry.id === id);
    if (record && record.endedAt === null) record.endedAt = now;
  }

  isPlaying(): boolean {
    return this.records.some((record) => record.endedAt === null);
  }

  evaluate(segment: EchoSegment): EchoVerdict {
    const active = this.records.find(
      (record) =>
        record.startedAt <= segment.receivedAt &&
        (record.endedAt === null || segment.receivedAt < record.endedAt),
    );
    if (active) return { accept: false, reason: "playing", playbackId: active.id };

    const tokens = tokenizeVietnameseText(segment.text);
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record.endedAt === null || segment.receivedAt < record.startedAt) {
        continue;
      }
      const sinceEnd = segment.receivedAt - record.endedAt;
      if (sinceEnd > this.retainMs) continue;

      if (segment.onsetAt != null) {
        if (
          segment.onsetAt >= record.startedAt &&
          segment.onsetAt < record.endedAt + this.onsetGraceMs
        ) {
          return {
            accept: false,
            reason: "onset-during-playback",
            playbackId: record.id,
          };
        }
        continue;
      }
      if (
        sinceEnd <= this.tailMs &&
        tokens.length > 0 &&
        this.overlap(tokens, record.tokens) >= this.overlapThreshold
      ) {
        return {
          accept: false,
          reason: "tail-overlap",
          playbackId: record.id,
        };
      }
    }
    return { accept: true, reason: "ok" };
  }

  private overlap(
    spoken: readonly string[],
    sample: readonly string[],
  ): number {
    if (!spoken.length) return 0;
    const pool = new Map<string, number>();
    for (const token of sample) pool.set(token, (pool.get(token) ?? 0) + 1);
    let shared = 0;
    for (const token of spoken) {
      const remaining = pool.get(token) ?? 0;
      if (remaining > 0) {
        shared += 1;
        pool.set(token, remaining - 1);
      }
    }
    return shared / spoken.length;
  }

  private prune(now: number): void {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record.endedAt !== null && now - record.endedAt > this.retainMs) {
        this.records.splice(index, 1);
      }
    }
  }
}
