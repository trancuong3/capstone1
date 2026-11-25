export interface ShotTrajectory {
  readonly angle: number;
  readonly startX: number;
  readonly startY: number;
  readonly dx: number;
  readonly dy: number;
  readonly endX: number;
  readonly endY: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface StageGeometrySnapshot {
  readonly arenaLeft: number;
  readonly arenaTop: number;
  readonly muzzleX: number;
  readonly muzzleY: number;
  readonly targets: Map<string, Point>;
}

/**
 * Caches arena, cannon muzzle, and word-bubble center coordinates via
 * ResizeObserver + requestAnimationFrame so tapping a bubble computes the
 * cannon aim and GPU projectile vector in O(1) without forced synchronous
 * getBoundingClientRect() layout reflows on every click.
 */
export class StageLayoutCache {
  private arenaEl: HTMLElement | null = null;
  private cannonEl: HTMLElement | null = null;
  private tokenEls = new Map<string, HTMLElement>();
  private snapshot: StageGeometrySnapshot | null = null;
  private observer: ResizeObserver | null = null;
  private rafId: number | null = null;
  private scrollHandler: (() => void) | null = null;
  private resizeHandler: (() => void) | null = null;

  bindStage(arena: HTMLElement | null, cannon: HTMLElement | null): void {
    const changed = this.arenaEl !== arena || this.cannonEl !== cannon;
    this.arenaEl = arena;
    this.cannonEl = cannon;
    if (!changed) return;

    this.detachObservers();
    if (!arena) {
      this.snapshot = null;
      return;
    }

    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => {
        this.scheduleMeasure();
      });
      this.observer.observe(arena);
      if (cannon) this.observer.observe(cannon);
    }

    if (typeof window !== "undefined") {
      this.resizeHandler = () => this.scheduleMeasure();
      this.scrollHandler = () => this.scheduleMeasure();
      window.addEventListener("resize", this.resizeHandler, { passive: true });
      window.addEventListener("scroll", this.scrollHandler, {
        passive: true,
        capture: true,
      });
    }

    this.scheduleMeasure();
  }

  registerToken(tokenId: string, element: HTMLElement | null): void {
    const previous = this.tokenEls.get(tokenId);
    if (element) {
      if (previous !== element) {
        this.tokenEls.set(tokenId, element);
        if (!this.snapshot?.targets.has(tokenId)) {
          this.scheduleMeasure();
        }
      }
    } else if (previous) {
      this.tokenEls.delete(tokenId);
    }
  }

  scheduleMeasure(): void {
    if (this.rafId !== null || typeof window === "undefined") return;
    if (typeof window.requestAnimationFrame === "function") {
      this.rafId = window.requestAnimationFrame(() => {
        this.rafId = null;
        this.measureNow();
      });
    } else {
      this.measureNow();
    }
  }

  measureNow(): void {
    if (!this.arenaEl || !this.cannonEl) {
      this.snapshot = null;
      return;
    }
    const arenaRect = this.arenaEl.getBoundingClientRect();
    const cannonRect = this.cannonEl.getBoundingClientRect();
    const muzzleX = cannonRect.left + cannonRect.width / 2 - arenaRect.left;
    const muzzleY = cannonRect.top + cannonRect.height * 0.2 - arenaRect.top;
    const targets = new Map<string, Point>();
    for (const [tokenId, el] of this.tokenEls.entries()) {
      const rect = el.getBoundingClientRect();
      targets.set(tokenId, {
        x: rect.left + rect.width / 2 - arenaRect.left,
        y: rect.top + rect.height / 2 - arenaRect.top,
      });
    }
    this.snapshot = {
      arenaLeft: arenaRect.left,
      arenaTop: arenaRect.top,
      muzzleX,
      muzzleY,
      targets,
    };
  }

  getTrajectory(tokenId: string): ShotTrajectory | null {
    if (!this.snapshot || !this.snapshot.targets.has(tokenId)) {
      this.measureNow();
    }
    const snap = this.snapshot;
    if (!snap) return null;
    const target = snap.targets.get(tokenId);
    if (!target) return null;

    const dx = target.x - snap.muzzleX;
    const dy = target.y - snap.muzzleY;
    const rawAngle = (Math.atan2(dx, -dy) * 180) / Math.PI;
    const angle = Number.isFinite(rawAngle)
      ? Math.max(-58, Math.min(58, rawAngle))
      : 0;

    return {
      angle,
      startX: snap.muzzleX,
      startY: snap.muzzleY,
      dx,
      dy,
      endX: target.x,
      endY: target.y,
    };
  }

  clearTokens(): void {
    this.tokenEls.clear();
    this.snapshot?.targets.clear();
  }

  private detachObservers(): void {
    if (this.rafId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame?.(this.rafId);
      this.rafId = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    if (typeof window !== "undefined") {
      if (this.resizeHandler) {
        window.removeEventListener("resize", this.resizeHandler);
        this.resizeHandler = null;
      }
      if (this.scrollHandler) {
        window.removeEventListener("scroll", this.scrollHandler, {
          capture: true,
        });
        this.scrollHandler = null;
      }
    }
  }

  dispose(): void {
    this.detachObservers();
    this.tokenEls.clear();
    this.arenaEl = null;
    this.cannonEl = null;
    this.snapshot = null;
  }
}
