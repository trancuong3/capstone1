/**
 * Phát hiện "không thấy người đọc trong khung hình" để tạm dừng buổi đọc và,
 * nếu phụ huynh đã bật, báo cho server chuẩn bị một email trung tính.
 *
 * Quyền riêng tư (cố ý hạn chế):
 * - Chỉ nhận số liệu đã tính trên thiết bị (số khuôn mặt, chất lượng khung,
 *   mức chuyển động). KHÔNG nhận ảnh/âm thanh, KHÔNG nhận diện danh tính.
 * - Không lưu, không gửi ảnh. Server chỉ nhận mã "đợt vắng mặt".
 *
 * Chống báo nhầm: chỉ coi là "vắng" khi (a) chất lượng khung tốt, (b) không có
 * khuôn mặt, (c) gần như không có chuyển động, (d) liên tục đủ lâu, (e) trước
 * đó đã có bằng chứng liên tục có người đọc trong khung. Cúi đọc sách, quay
 * đầu, camera tối/bị che, thiết bị không hỗ trợ hay lỗi camera đều là
 * "không chắc" — không bao giờ tính là vắng và làm lại bộ đếm.
 */

export type FrameQuality = "ok" | "dark" | "covered" | "unsupported" | "error";

export interface PresenceSample {
  readonly at: number;
  /** null: thiết bị không có bộ phát hiện khuôn mặt. */
  readonly faceCount: number | null;
  readonly quality: FrameQuality;
  /** 0..1, mức thay đổi giữa hai khung liên tiếp. */
  readonly motion: number;
}

export type SessionPhase =
  | "reading"
  | "paused-by-presence"
  | "paused-other"
  | "ended";

export interface PresenceContext {
  /** Phụ huynh đã bật "nhắc qua email". Mặc định tắt. */
  readonly optedIn: boolean;
  readonly sessionPhase: SessionPhase;
  readonly appVisible: boolean;
  readonly cameraGranted: boolean;
}

export interface PresenceConfig {
  readonly confirmPresentMs: number;
  readonly absentMs: number;
  readonly returnConfirmMs: number;
  readonly heartbeatMs: number;
  readonly motionThreshold: number;
}

export const DEFAULT_PRESENCE_CONFIG: PresenceConfig = {
  confirmPresentMs: 3000,
  absentMs: 45_000,
  returnConfirmMs: 2000,
  heartbeatMs: 10_000,
  motionThreshold: 0.02,
};

export type CancelReason =
  | "RETURNED"
  | "SESSION_ENDED"
  | "APP_BACKGROUND"
  | "OPT_OUT"
  | "PAUSED_BY_PARENT"
  | "CAMERA_UNAVAILABLE";

export type PresenceEffect =
  | { readonly type: "PAUSE_SESSION" }
  | { readonly type: "SHOW_NOTICE" }
  | { readonly type: "ARM_ALERT"; readonly episodeId: string }
  | { readonly type: "CONFIRM_ALERT"; readonly episodeId: string }
  | {
      readonly type: "CANCEL_ALERT";
      readonly episodeId: string;
      readonly reason: CancelReason;
    };

export type Observation = "present" | "absent" | "uncertain";

export function observe(
  sample: PresenceSample,
  config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
): Observation {
  if (sample.quality !== "ok" || sample.faceCount === null) return "uncertain";
  if (sample.faceCount > 0) return "present";
  // No face but the scene is moving (leaning over the book, turning the head,
  // a hand in front): the reader may still be there.
  return sample.motion < config.motionThreshold ? "absent" : "uncertain";
}

interface Episode {
  readonly id: string;
  lastConfirmAt: number;
}

export class PresenceMonitor {
  private everPresent = false;
  private presentSince: number | null = null;
  private absentSince: number | null = null;
  private episode: Episode | null = null;
  private returningSince: number | null = null;

  constructor(
    private readonly newEpisodeId: () => string,
    private readonly config: PresenceConfig = DEFAULT_PRESENCE_CONFIG,
  ) {}

  get hasPendingAlert(): boolean {
    return this.episode !== null;
  }

  get isWatching(): boolean {
    return this.everPresent;
  }

  /** Feed one context + (optional) sample; returns what the app must do. */
  update(
    context: PresenceContext,
    sample: PresenceSample | null,
    at: number,
  ): PresenceEffect[] {
    const effects: PresenceEffect[] = [];

    const gate = this.gateReason(context);
    if (gate) {
      this.cancelEpisode(effects, gate);
      this.reset();
      return effects;
    }
    if (!sample) return effects;

    const observation = observe(sample, this.config);

    if (this.episode) {
      this.updateEpisode(observation, at, effects);
      return effects;
    }
    if (context.sessionPhase !== "reading") {
      // Paused by the child/parent: nothing is evaluated, nothing is pending.
      this.reset();
      return effects;
    }

    if (observation === "present") {
      this.absentSince = null;
      this.presentSince ??= at;
      if (at - this.presentSince >= this.config.confirmPresentMs) {
        this.everPresent = true;
      }
      return effects;
    }
    this.presentSince = null;
    if (observation === "uncertain") {
      // Not evidence of absence: the continuous-absence clock restarts.
      this.absentSince = null;
      return effects;
    }
    this.absentSince ??= at;
    if (this.everPresent && at - this.absentSince >= this.config.absentMs) {
      const id = this.newEpisodeId();
      this.episode = { id, lastConfirmAt: at };
      this.returningSince = null;
      effects.push({ type: "PAUSE_SESSION" });
      effects.push({ type: "SHOW_NOTICE" });
      effects.push({ type: "ARM_ALERT", episodeId: id });
    }
    return effects;
  }

  private gateReason(context: PresenceContext): CancelReason | "idle" | null {
    if (!context.optedIn) return "OPT_OUT";
    if (context.sessionPhase === "ended") return "SESSION_ENDED";
    if (!context.appVisible) return "APP_BACKGROUND";
    if (!context.cameraGranted) return "CAMERA_UNAVAILABLE";
    if (context.sessionPhase === "paused-other" && this.episode) {
      return "PAUSED_BY_PARENT";
    }
    return null;
  }

  private updateEpisode(
    observation: Observation,
    at: number,
    effects: PresenceEffect[],
  ): void {
    const episode = this.episode!;
    if (observation === "present") {
      this.returningSince ??= at;
      if (at - this.returningSince >= this.config.returnConfirmMs) {
        this.cancelEpisode(effects, "RETURNED");
        // They are back: they have to press Continue; nothing reopens by itself.
        this.absentSince = null;
        this.presentSince = at;
        this.everPresent = true;
      }
      return;
    }
    this.returningSince = null;
    // Heartbeat only while the reader is still positively absent. If the
    // camera is covered or unclear we stop vouching, so the server will not send.
    if (
      observation === "absent" &&
      at - episode.lastConfirmAt >= this.config.heartbeatMs
    ) {
      episode.lastConfirmAt = at;
      effects.push({ type: "CONFIRM_ALERT", episodeId: episode.id });
    }
  }

  private cancelEpisode(effects: PresenceEffect[], reason: CancelReason | "idle"): void {
    if (!this.episode) return;
    const cancelReason: CancelReason = reason === "idle" ? "RETURNED" : reason;
    effects.push({
      type: "CANCEL_ALERT",
      episodeId: this.episode.id,
      reason: cancelReason,
    });
    this.episode = null;
    this.returningSince = null;
  }

  private reset(): void {
    this.everPresent = false;
    this.presentSince = null;
    this.absentSince = null;
    this.episode = null;
    this.returningSince = null;
  }
}
