"use client";

import { createChildService } from "@/lib/api/child-service";
import {
  broadcastChildSelection,
  dispatchLocalSelectedChildChange,
  readSessionSelectedChildId,
} from "@/lib/cache/selected-child-storage";
import { readUserCacheWithStale } from "@/lib/cache/user-query-cache";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";
import type { ChildProfileDTO } from "@/types/child";
import type { DashboardSummaryDTO } from "@/types/profile";

export const CHILD_REQUIRED_ASSISTANT_PATHS = new Set<string>([
  "/books",
  "/book-scanner",
  "/reading-preparation",
  "/entertainment",
  "/entertainment/memory-game",
  "/entertainment/sentence-shooter",
  "/entertainment/picture-description",
  "/karaoke",
  "/achievements",
  "/learning-train",
]);

export const CHILD_BENEFICIAL_ASSISTANT_PATHS = new Set<string>([
  "/reports",
  "/reports/difficult-words",
  "/sessions",
  "/reading-management",
]);

export interface AssistantChildContextSnapshot {
  readonly userId: string | null;
  readonly selectedChildId: string | null;
  readonly children: readonly ChildProfileDTO[];
  readonly selectedChild: ChildProfileDTO | null;
  readonly loadFailed?: boolean;
}

function normalizeAssistantPath(
  href: string | null | undefined,
): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return null;
  }
  const withoutQueryOrHash = trimmed.split(/[?#]/, 1)[0] ?? "";
  if (!withoutQueryOrHash) return null;
  const normalized =
    withoutQueryOrHash.length > 1
      ? withoutQueryOrHash.replace(/\/+$/, "")
      : withoutQueryOrHash;
  return normalized || "/";
}

function matchesAssistantPathSet(
  href: string | null | undefined,
  paths: ReadonlySet<string>,
): boolean {
  const normalized = normalizeAssistantPath(href);
  if (!normalized) return false;
  if (paths.has(normalized)) return true;
  for (const base of paths) {
    if (normalized.startsWith(`${base}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * Returns `true` when navigating to `href` requires an active child profile
 * to be selected first.
 */
export function requiresSelectedChildForHref(
  href: string | null | undefined,
): boolean {
  return matchesAssistantPathSet(href, CHILD_REQUIRED_ASSISTANT_PATHS);
}

/**
 * Returns `true` when `href` either requires a selected child or benefits
 * from at least one child profile in the family account.
 */
export function requiresAnyChildProfileForHref(
  href: string | null | undefined,
): boolean {
  return (
    requiresSelectedChildForHref(href) ||
    matchesAssistantPathSet(href, CHILD_BENEFICIAL_ASSISTANT_PATHS)
  );
}

function readCachedChildrenForUser(userId: string): ChildProfileDTO[] | null {
  const summary = readUserCacheWithStale<DashboardSummaryDTO>(
    userId,
    "dashboard-summary",
  );
  if (summary?.data && Array.isArray(summary.data.children)) {
    const filtered = summary.data.children.filter(
      (child) => child.parent_id === userId,
    );
    if (filtered.length > 0) {
      return filtered;
    }
  }

  const cachedChildren = readUserCacheWithStale<ChildProfileDTO[]>(
    userId,
    "children",
  );
  if (cachedChildren && Array.isArray(cachedChildren.data)) {
    const filtered = cachedChildren.data.filter(
      (child) => child.parent_id === userId,
    );
    if (filtered.length > 0) {
      return filtered;
    }
  }

  return null;
}

/**
 * Reads the current parent's child-selection context without exposing auth tokens
 * or throwing on unexpected network/auth errors.
 */
export async function readAssistantChildContext(options?: {
  readonly forceRefresh?: boolean;
}): Promise<AssistantChildContextSnapshot> {
  let userId: string | null = null;
  try {
    const supabase = createBrowserSupabaseClient();
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      return {
        userId: null,
        selectedChildId: null,
        children: [],
        selectedChild: null,
        loadFailed: true,
      };
    }
    userId = data.session?.user?.id ?? null;
  } catch {
    return {
      userId: null,
      selectedChildId: null,
      children: [],
      selectedChild: null,
      loadFailed: true,
    };
  }

  if (!userId) {
    return {
      userId: null,
      selectedChildId: null,
      children: [],
      selectedChild: null,
    };
  }

  const storedSelectedChildId = readSessionSelectedChildId(userId);
  try {
    let children = options?.forceRefresh
      ? null
      : readCachedChildrenForUser(userId);
    if (!children) {
      const listed = await createChildService().list();
      children = listed.filter((child) => child.parent_id === userId);
    }

    const selectedChild = storedSelectedChildId
      ? (children.find((child) => child.id === storedSelectedChildId) ?? null)
      : null;

    return {
      userId,
      selectedChildId: selectedChild ? selectedChild.id : null,
      children,
      selectedChild,
    };
  } catch {
    return {
      userId,
      selectedChildId: null,
      children: [],
      selectedChild: null,
      loadFailed: true,
    };
  }
}

/**
 * Applies a child selection chosen inside the assistant across the current tab,
 * cross-tab sync channels, and the child's teacher voice preferences.
 */
export function selectChildFromAssistant(
  userId: string,
  child: ChildProfileDTO,
): void {
  if (!userId || !child?.id) return;
  dispatchLocalSelectedChildChange(userId, child.id);
  broadcastChildSelection(userId, child.id);
  hydrateTeacherVoiceFromChildProfile(child);
}
