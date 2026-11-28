import { expect, type Locator, type Page } from "@playwright/test";

export async function waitForRouteSettled(page: Page): Promise<void> {
  await page.waitForLoadState("load");
  try {
    await page.waitForLoadState("networkidle", { timeout: 4000 });
  } catch {
    // Allow routes with continuous background refresh (e.g. /studio/tasks)
    // to settle visibly without exhausting the multi-route test timeout.
  }
  await expect(page.locator("h1, main").first()).toBeVisible();
}

export async function assertZeroHorizontalOverflow(
  page: Page,
  label: string,
  tolerance = 0,
): Promise<void> {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    metrics.scrollWidth,
    `[${label}] Horizontal overflow (${metrics.scrollWidth} > ${metrics.innerWidth} + ${tolerance})`,
  ).toBeLessThanOrEqual(metrics.innerWidth + tolerance);
}

export async function assertLoadedImages(
  page: Page,
  label: string,
): Promise<void> {
  const brokenImages = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("img"))
      .filter((img) => {
        const style = window.getComputedStyle(img);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) {
          return false;
        }
        const rect = img.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          return false;
        }
        const src = img.getAttribute("src") ?? "";
        return src.length > 0 && img.complete && img.naturalWidth === 0;
      })
      .map(
        (img) => img.getAttribute("alt") || img.getAttribute("src") || "img",
      );
  });
  expect(brokenImages, `[${label}] Broken visible images`).toEqual([]);
}

interface BoxWithLabel {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function assertTouchTargetsAndNoOverlap(
  page: Page,
  locators: readonly Locator[],
  label: string,
  minSize = 44,
): Promise<void> {
  const boxes: BoxWithLabel[] = [];

  for (let i = 0; i < locators.length; i += 1) {
    const locator = locators[i];
    await expect(
      locator,
      `[${label}] Control #${i} should be visible`,
    ).toBeVisible();
    const box = await locator.boundingBox();
    expect(box, `[${label}] Control #${i} missing bounding box`).not.toBeNull();

    const controlName = await locator.evaluate((el) => {
      return (
        el.getAttribute("aria-label") ||
        el.textContent?.trim().slice(0, 40) ||
        el.tagName
      );
    });

    expect(
      Math.round(box!.height),
      `[${label}] "${controlName}" height ${box!.height}px < ${minSize}px`,
    ).toBeGreaterThanOrEqual(minSize);
    expect(
      Math.round(box!.width),
      `[${label}] "${controlName}" width ${box!.width}px < ${minSize}px`,
    ).toBeGreaterThanOrEqual(minSize);

    boxes.push({
      label: controlName,
      x: box!.x,
      y: box!.y,
      width: box!.width,
      height: box!.height,
    });
  }

  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX =
        Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY =
        Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      const hasSignificantOverlap = overlapX > 2 && overlapY > 2;
      expect(
        hasSignificantOverlap,
        `[${label}] Controls "${a.label}" and "${b.label}" overlap (${overlapX.toFixed(1)}x${overlapY.toFixed(1)}px)`,
      ).toBe(false);
    }
  }

  // Scan document.body so fixed/sticky bars inside <main> (e.g. /reading-preparation z-[45])
  // are checked against MobileBottomNav (z-40) outside <main>, as well as normal-flow siblings.
  const siblingOverlaps = await page.evaluate(() => {
    const isFloating = (node: HTMLElement): boolean => {
      let cur: HTMLElement | null = node;
      while (cur && cur !== document.body) {
        const pos = window.getComputedStyle(cur).position;
        if (pos === "fixed" || pos === "sticky") return true;
        cur = cur.parentElement;
      }
      return false;
    };

    const elements = Array.from(
      document.body.querySelectorAll<HTMLElement>(
        'button, a[href], [role="button"], [role="tab"]',
      ),
    ).filter((el) => {
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.opacity === "0"
      ) {
        return false;
      }
      if (el.getClientRects().length === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width >= 8 && rect.height >= 8;
    });

    const conflicts: string[] = [];
    for (let i = 0; i < elements.length; i += 1) {
      const elA = elements[i];
      const rectA = elA.getBoundingClientRect();
      const floatA = isFloating(elA);
      for (let j = i + 1; j < elements.length; j += 1) {
        const elB = elements[j];
        if (elA.contains(elB) || elB.contains(elA)) continue;
        const floatB = isFloating(elB);
        if (floatA !== floatB) continue;
        const rectB = elB.getBoundingClientRect();
        const ox =
          Math.min(rectA.right, rectB.right) - Math.max(rectA.left, rectB.left);
        const oy =
          Math.min(rectA.bottom, rectB.bottom) - Math.max(rectA.top, rectB.top);
        if (ox > 4 && oy > 4) {
          const nameA =
            elA.getAttribute("aria-label") ||
            elA.textContent?.trim().slice(0, 24) ||
            elA.tagName;
          const nameB =
            elB.getAttribute("aria-label") ||
            elB.textContent?.trim().slice(0, 24) ||
            elB.tagName;
          conflicts.push(`"${nameA}" overlaps "${nameB}"`);
        }
      }
    }
    return conflicts;
  });

  expect(
    siblingOverlaps,
    `[${label}] Overlapping interactive controls`,
  ).toEqual([]);
}

export async function assertUnobstructedReadingCanvas(
  page: Page,
  label: string,
  options: {
    readonly isMobile?: boolean;
    readonly skipMobileTopChromeCheck?: boolean;
  } = {},
): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport, `[${label}] Missing viewport size`).not.toBeNull();

  const controls = page.locator("[data-reading-controls]");
  await expect(controls, `[${label}] Reading controls visible`).toBeVisible();
  const controlsBox = await controls.boundingBox();
  expect(
    controlsBox,
    `[${label}] Missing reading controls bounding box`,
  ).not.toBeNull();
  expect(
    controlsBox!.x,
    `[${label}] Controls left >= 0`,
  ).toBeGreaterThanOrEqual(0);
  expect(
    controlsBox!.x + controlsBox!.width,
    `[${label}] Controls right within viewport (${controlsBox!.x + controlsBox!.width} <= ${viewport!.width + 2})`,
  ).toBeLessThanOrEqual(viewport!.width + 2);
  expect(controlsBox!.y, `[${label}] Controls top >= 0`).toBeGreaterThanOrEqual(
    0,
  );
  expect(
    controlsBox!.y + controlsBox!.height,
    `[${label}] Controls bottom within viewport (${controlsBox!.y + controlsBox!.height} <= ${viewport!.height + 2})`,
  ).toBeLessThanOrEqual(viewport!.height + 2);

  const scrollContainer = page.locator(
    '[data-reading-scroll-container="true"]',
  );
  await expect(
    scrollContainer,
    `[${label}] Reading scroll container visible`,
  ).toBeVisible();
  const scrollMetrics = await scrollContainer.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      clientHeight: el.clientHeight,
    };
  });
  expect(
    scrollMetrics.clientHeight,
    `[${label}] Reading scroll container height >= 140px`,
  ).toBeGreaterThanOrEqual(140);

  if (options.isMobile && !options.skipMobileTopChromeCheck) {
    // Requirement R2 / TEST_INFRA.md: compact top header footprint < 110px on mobile (< 768px)
    // so story text dominates the viewport without multi-row top header stacks.
    const topChromeHeight = await page.evaluate(() => {
      const container = document.querySelector(
        '[data-reading-scroll-container="true"]',
      );
      if (!container) return 9999;
      return Math.round(container.getBoundingClientRect().top);
    });
    expect(
      topChromeHeight,
      `[${label}] Mobile reading top chrome (${topChromeHeight}px) must be compact (< 110px)`,
    ).toBeLessThan(110);
  }

  // Sample visible words across top, middle, and bottom of the scroll container
  // without forcing scrollIntoViewIfNeeded() so bottom overlays are never masked.
  const wordAudit = await page.evaluate(() => {
    const container = document.querySelector(
      '[data-reading-scroll-container="true"]',
    );
    if (!container) {
      return {
        totalCount: 0,
        visibleCount: 0,
        obscured: ["missing-container"],
      };
    }
    const cRect = container.getBoundingClientRect();
    const visibleTop = Math.max(0, cRect.top) + 2;
    const visibleBottom = Math.min(window.innerHeight, cRect.bottom) - 2;
    const visibleLeft = Math.max(0, cRect.left) + 2;
    const visibleRight = Math.min(window.innerWidth, cRect.right) - 2;

    const allWords = Array.from(
      container.querySelectorAll<HTMLElement>("[data-word-id]"),
    );
    const visibleWords = allWords.filter((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      return (
        cx >= visibleLeft &&
        cx <= visibleRight &&
        cy >= visibleTop &&
        cy <= visibleBottom
      );
    });

    const sampleIndices = new Set<number>();
    const pushRange = (start: number, end: number) => {
      for (let i = start; i < end; i += 1) {
        if (i >= 0 && i < visibleWords.length) sampleIndices.add(i);
      }
    };
    pushRange(0, Math.min(6, visibleWords.length));
    const midStart = Math.max(0, Math.floor(visibleWords.length / 2) - 3);
    pushRange(midStart, Math.min(visibleWords.length, midStart + 6));
    pushRange(Math.max(0, visibleWords.length - 6), visibleWords.length);

    const obscured: string[] = [];
    for (const idx of sampleIndices) {
      const el = visibleWords[idx];
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || !el.contains(hit)) {
        const hitTag = hit
          ? `${hit.tagName}${hit.getAttribute("data-testid") ? `[data-testid=${hit.getAttribute("data-testid")}]` : ""}`
          : "null";
        obscured.push(
          `word[${idx}] "${el.textContent?.trim() ?? ""}" at (${Math.round(cx)},${Math.round(cy)}) hit=${hitTag}`,
        );
      }
    }

    return {
      totalCount: allWords.length,
      visibleCount: visibleWords.length,
      obscured,
    };
  });

  expect(
    wordAudit.totalCount,
    `[${label}] Should render reading words`,
  ).toBeGreaterThan(0);
  expect(
    wordAudit.visibleCount,
    `[${label}] Should have visible words inside reading scroll container`,
  ).toBeGreaterThan(0);
  expect(
    wordAudit.obscured,
    `[${label}] Visible story words obscured by overlay`,
  ).toEqual([]);
}

export async function assert200PercentZoomReachable(
  page: Page,
  label: string,
): Promise<void> {
  const viewport = page.viewportSize();
  expect(viewport, `[${label}] Missing viewport size`).not.toBeNull();

  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });

  const overflowInfo = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyWidth: document.body.getBoundingClientRect().width,
  }));

  expect(
    overflowInfo.scrollWidth,
    `[${label}] 200% zoom scrollWidth (${overflowInfo.scrollWidth}) > clientWidth (${overflowInfo.clientWidth}) + 2`,
  ).toBeLessThanOrEqual(overflowInfo.clientWidth + 2);
  expect(
    overflowInfo.bodyWidth,
    `[${label}] 200% zoom bodyWidth (${overflowInfo.bodyWidth}) > viewport (${viewport!.width}) + 1`,
  ).toBeLessThanOrEqual(viewport!.width + 1);

  const controls = page.getByRole("navigation", {
    name: "Điều khiển buổi đọc",
  });
  await expect(controls).toBeVisible();
  const buttons = await controls.getByRole("button").all();
  for (const button of buttons) {
    if (!(await button.isVisible())) continue;
    const spanLabel = button.locator("span").last();
    if ((await spanLabel.count()) === 0) continue;
    const labelMetrics = await spanLabel.evaluate((el) => {
      const style = window.getComputedStyle(el);
      return {
        text: el.textContent?.trim() ?? "",
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        textOverflow: style.textOverflow,
      };
    });
    expect(
      labelMetrics.textOverflow,
      `[${label}] Control "${labelMetrics.text}" uses ellipsis at 200% zoom`,
    ).not.toBe("ellipsis");
    expect(
      labelMetrics.scrollWidth,
      `[${label}] Control "${labelMetrics.text}" horizontal clip (${labelMetrics.scrollWidth} > ${labelMetrics.clientWidth})`,
    ).toBeLessThanOrEqual(labelMetrics.clientWidth);
    expect(
      labelMetrics.scrollHeight,
      `[${label}] Control "${labelMetrics.text}" vertical clip (${labelMetrics.scrollHeight} > ${labelMetrics.clientHeight})`,
    ).toBeLessThanOrEqual(labelMetrics.clientHeight);
  }

  const words = page.locator("[data-word-id]");
  const wordCount = await words.count();
  expect(wordCount).toBeGreaterThan(0);
  for (let i = 0; i < Math.min(wordCount, 5); i += 1) {
    const word = words.nth(i);
    await word.scrollIntoViewIfNeeded();
    await expect(word).toBeVisible();
    expect(await word.innerText()).not.toBe("");
  }
}

export async function assertResponsiveLayoutSeparation(
  page: Page,
  label: string,
  isMobile: boolean,
): Promise<void> {
  const mobileBottomNav = page.getByTestId("mobile-bottom-nav");
  const desktopNavLinks = page.locator(".parent-nav-links");
  const isDashboard = new URL(page.url()).pathname === "/dashboard";

  if (isMobile) {
    await expect(
      mobileBottomNav,
      `[${label}] Mobile bottom nav should be visible on < 768px`,
    ).toBeVisible();
    await expect(
      desktopNavLinks,
      `[${label}] Desktop parent nav links should be hidden on < 768px`,
    ).toBeHidden();
    if (isDashboard) {
      await expect(
        page.locator("section.family-dashboard"),
        `[${label}] Desktop family-dashboard section should be hidden/absent on < 768px`,
      ).toBeHidden();
    }
  } else {
    await expect(
      desktopNavLinks,
      `[${label}] Desktop parent nav links should be visible on >= 768px`,
    ).toBeVisible();
    await expect(
      mobileBottomNav,
      `[${label}] Mobile bottom nav should be hidden on >= 768px`,
    ).toBeHidden();
    if (isDashboard) {
      await expect(
        page.locator("section.family-dashboard"),
        `[${label}] Desktop family-dashboard section should be visible on >= 768px`,
      ).toBeVisible();
    }
  }
}
