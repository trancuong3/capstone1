import type {
  SentenceShooterShotDTO,
  SentenceShooterTokenDTO,
} from "@/types/sentence-shooter";

export const MAX_QUEUED_SHOTS = 6;

export interface QueuedShot {
  readonly clientShotId: string;
  readonly roundEpoch: number;
  readonly sessionId: string;
  readonly roundId: string;
  readonly token: SentenceShooterTokenDTO;
  readonly enqueuedAtMs: number;
}

export interface PendingRetryShot {
  readonly roundId: string;
  readonly tokenId: string;
  readonly clientShotId: string;
}

export interface ShotQueueSnapshot {
  readonly pending: readonly QueuedShot[];
  readonly activeShotId: string | null;
}

export type ShotExecutor = (
  shot: QueuedShot,
  signal: AbortSignal,
) => Promise<SentenceShooterShotDTO>;

export interface ShotQueueHandlers {
  readonly onQueueChange: (snapshot: ShotQueueSnapshot) => void;
  readonly onShotResolved: (
    shot: QueuedShot,
    response: SentenceShooterShotDTO,
  ) => void;
  readonly onShotError: (shot: QueuedShot, error: unknown) => void;
}

/**
 * Bounded strictly-ordered FIFO server-validation queue keyed by
 * (roundEpoch, clientShotId).
 *
 * - Allows immediate non-blocking rapid taps on distinct word bubbles.
 * - Prevents duplicate concurrent taps on the same bubble (in-flight guard).
 * - Dispatches HTTP validation strictly 1-by-1 in FIFO order so server
 *   NextExpectedPosition stays deterministic.
 * - Safely discards stale responses whenever roundEpoch changes.
 */
export class OrderedShotQueue {
  private epoch = 0;
  private drainToken = 0;
  private queue: QueuedShot[] = [];
  private activeShot: QueuedShot | null = null;
  private activeController: AbortController | null = null;
  private draining = false;
  private pendingRetry: PendingRetryShot | null = null;
  private readonly execute: ShotExecutor;
  private readonly handlers: ShotQueueHandlers;

  constructor(execute: ShotExecutor, handlers: ShotQueueHandlers) {
    this.execute = execute;
    this.handlers = handlers;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  getSnapshot(): ShotQueueSnapshot {
    const items = this.activeShot
      ? [this.activeShot, ...this.queue]
      : [...this.queue];
    return {
      pending: items,
      activeShotId: this.activeShot?.clientShotId ?? null,
    };
  }

  isTokenInFlight(tokenId: string): boolean {
    if (this.activeShot?.token.id === tokenId) return true;
    return this.queue.some((item) => item.token.id === tokenId);
  }

  pendingCount(): number {
    return (this.activeShot ? 1 : 0) + this.queue.length;
  }

  /**
   * Advances roundEpoch, aborts any in-flight HTTP validation, and drops all
   * queued shots from the prior epoch so stale responses can never mutate state.
   */
  resetEpoch(): number {
    this.epoch += 1;
    this.drainToken += 1;
    this.queue = [];
    this.activeShot = null;
    this.pendingRetry = null;
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
    this.draining = false;
    this.emit();
    return this.epoch;
  }

  /**
   * Enqueues a shot synchronously (<1ms) and triggers FIFO draining without
   * blocking the UI thread or subsequent taps on other bubbles.
   */
  enqueue(input: {
    sessionId: string;
    roundId: string;
    token: SentenceShooterTokenDTO;
  }): QueuedShot | null {
    if (this.isTokenInFlight(input.token.id)) {
      return null;
    }
    if (this.pendingCount() >= MAX_QUEUED_SHOTS) {
      return null;
    }

    const retry = this.pendingRetry;
    const clientShotId =
      retry &&
      retry.roundId === input.roundId &&
      retry.tokenId === input.token.id
        ? retry.clientShotId
        : crypto.randomUUID();

    // Clear retry once consumed or when the child switches to a different token.
    this.pendingRetry = null;

    const shot: QueuedShot = {
      clientShotId,
      roundEpoch: this.epoch,
      sessionId: input.sessionId,
      roundId: input.roundId,
      token: input.token,
      enqueuedAtMs:
        typeof performance !== "undefined" ? performance.now() : Date.now(),
    };

    this.queue.push(shot);
    this.emit();
    void this.drain();
    return shot;
  }

  private emit(): void {
    this.handlers.onQueueChange(this.getSnapshot());
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    const myDrainToken = ++this.drainToken;
    this.draining = true;

    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        if (next.roundEpoch !== this.epoch) {
          continue;
        }
        this.activeShot = next;
        const controller = new AbortController();
        this.activeController = controller;
        this.emit();

        try {
          const response = await this.execute(next, controller.signal);
          if (next.roundEpoch !== this.epoch) {
            // Stale epoch: discard silently without touching UI state.
            continue;
          }

          this.activeShot = null;
          this.activeController = null;

          if (response.round_completed) {
            // Authoritative round completion invalidates any trailing queued shots
            // so we never send shots against a completed round.
            this.epoch += 1;
            this.queue = [];
            this.pendingRetry = null;
          }

          this.emit();
          this.handlers.onShotResolved(next, response);
        } catch (error) {
          if (next.roundEpoch !== this.epoch || controller.signal.aborted) {
            continue;
          }

          // Preserve idempotent clientShotId for retrying this exact bubble,
          // and return any queued trailing bubbles back to the tray cleanly.
          this.pendingRetry = {
            roundId: next.roundId,
            tokenId: next.token.id,
            clientShotId: next.clientShotId,
          };
          this.activeShot = null;
          this.activeController = null;
          this.queue = [];
          this.emit();
          this.handlers.onShotError(next, error);
          break;
        }
      }
    } finally {
      if (this.drainToken === myDrainToken) {
        this.draining = false;
        if (this.activeShot === null && this.queue.length > 0) {
          void this.drain();
        }
      }
    }
  }
}
