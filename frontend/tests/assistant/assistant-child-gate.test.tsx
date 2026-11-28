import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AuthRuntimeContext,
  type AuthRuntimeState,
} from "@/components/auth/auth-service-provider";
import {
  AppStoreProvider,
  useAppStore,
} from "@/components/providers/app-store-provider";
import * as readCacheModule from "@/lib/api/read-cache";
import {
  readAssistantChildContext,
  requiresAnyChildProfileForHref,
  requiresSelectedChildForHref,
  selectChildFromAssistant,
} from "@/lib/assistant/child-gate";
import {
  readSessionSelectedChildId,
  SELECTED_CHILD_LOCAL_EVENT,
  subscribeLocalSelectedChildChange,
  writeSessionSelectedChildId,
} from "@/lib/cache/selected-child-storage";
import { clearUserCache, writeUserCache } from "@/lib/cache/user-query-cache";
import { hydrateTeacherVoiceFromChildProfile } from "@/lib/reading/session-voice-lock";
import type { ChildProfileDTO } from "@/types/child";
import type { DashboardSummaryDTO } from "@/types/profile";

const { getSessionMock, listChildrenMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  listChildrenMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: getSessionMock,
    },
  }),
}));

vi.mock("@/lib/api/child-service", () => ({
  createChildService: () => ({
    list: listChildrenMock,
  }),
}));

vi.mock("@/lib/reading/session-voice-lock", () => ({
  hydrateTeacherVoiceFromChildProfile: vi.fn(),
}));

function makeChild(
  id: string,
  parentId: string,
  alias: string,
  grade = 2,
): ChildProfileDTO {
  return {
    id,
    parent_id: parentId,
    alias,
    grade,
    settings: { voice_preferences: { voice_id: "vi-north-1", speed: 0.9 } },
    created_at: "2026-10-01T00:00:00Z",
  };
}

function makeAuthRuntime(userId: string | null): AuthRuntimeState {
  return {
    hasProvider: true,
    initializationFailure: null,
    isPasswordRecovery: false,
    lastEvent: userId ? "SIGNED_IN" : "SIGNED_OUT",
    mode: "supabase",
    session: userId
      ? {
          expires_at: null,
          user: {
            id: userId,
            email: `${userId}@example.com`,
            display_name: userId,
          },
        }
      : null,
    status: "ready",
  };
}

function StoreProbe() {
  const { selectedChildId } = useAppStore();
  return (
    <output aria-label="Store child id">{selectedChildId ?? "none"}</output>
  );
}

describe("assistant child-gate & local selection sync bridge", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    clearUserCache();
    getSessionMock.mockReset();
    listChildrenMock.mockReset();
    vi.mocked(hydrateTeacherVoiceFromChildProfile).mockReset();
  });

  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    clearUserCache();
    vi.restoreAllMocks();
  });

  it("matches child-required and child-beneficial routes with query and trailing-slash normalization", () => {
    expect(requiresSelectedChildForHref("/books")).toBe(true);
    expect(requiresSelectedChildForHref("/books/")).toBe(true);
    expect(requiresSelectedChildForHref("/books?grade=2")).toBe(true);
    expect(requiresSelectedChildForHref("/books/book-123")).toBe(true);
    expect(requiresSelectedChildForHref("/book-scanner")).toBe(true);
    expect(requiresSelectedChildForHref("/reading-preparation")).toBe(true);
    expect(requiresSelectedChildForHref("/entertainment")).toBe(true);
    expect(requiresSelectedChildForHref("/entertainment/memory-game")).toBe(
      true,
    );
    expect(
      requiresSelectedChildForHref("/entertainment/sentence-shooter"),
    ).toBe(true);
    expect(
      requiresSelectedChildForHref("/entertainment/picture-description"),
    ).toBe(true);
    expect(requiresSelectedChildForHref("/karaoke/song-1")).toBe(true);

    expect(requiresSelectedChildForHref("/reports")).toBe(false);
    expect(requiresSelectedChildForHref("/reports/difficult-words")).toBe(
      false,
    );
    expect(requiresSelectedChildForHref("/sessions")).toBe(false);
    expect(requiresSelectedChildForHref("/reading-management")).toBe(false);
    expect(requiresSelectedChildForHref("/settings")).toBe(false);
    expect(requiresSelectedChildForHref(null)).toBe(false);
    expect(requiresSelectedChildForHref("//evil.example/books")).toBe(false);

    expect(requiresAnyChildProfileForHref("/reports")).toBe(true);
    expect(requiresAnyChildProfileForHref("/reports/difficult-words/")).toBe(
      true,
    );
    expect(requiresAnyChildProfileForHref("/sessions?page=2")).toBe(true);
    expect(requiresAnyChildProfileForHref("/reading-management")).toBe(true);
    expect(requiresAnyChildProfileForHref("/books")).toBe(true);
    expect(requiresAnyChildProfileForHref("/settings")).toBe(false);
    expect(requiresAnyChildProfileForHref("/children/new")).toBe(false);
  });

  it("reads child context from per-user cache first, filters by parent_id, and treats stale selectedChildId as unselected", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: { user: { id: "parent-1" } } },
      error: null,
    });

    const ownChild = makeChild("child-1", "parent-1", "Bé An", 2);
    const foreignChild = makeChild("child-other", "parent-2", "Bé Khác", 3);
    const summary: DashboardSummaryDTO = {
      profile: null,
      children: [ownChild, foreignChild],
      latest_sessions_by_child: {},
      source: "dashboard-summary",
    };
    writeUserCache("parent-1", "dashboard-summary", summary);
    writeSessionSelectedChildId("parent-1", "child-1");

    const ctx = await readAssistantChildContext();
    expect(ctx.userId).toBe("parent-1");
    expect(ctx.children).toEqual([ownChild]);
    expect(ctx.selectedChildId).toBe("child-1");
    expect(ctx.selectedChild).toEqual(ownChild);
    expect(ctx.loadFailed).toBeUndefined();
    expect(listChildrenMock).not.toHaveBeenCalled();

    // Stale selectedChildId not present in filtered children must be treated as unselected.
    writeSessionSelectedChildId("parent-1", "deleted-child-id");
    const staleCtx = await readAssistantChildContext();
    expect(staleCtx.selectedChild).toBeNull();
    expect(staleCtx.selectedChildId).toBeNull();
    expect(staleCtx.children).toEqual([ownChild]);
  });

  it("falls back to children cache or childService.list(), supports forceRefresh, and handles auth/network errors safely", async () => {
    // 1. Unauthenticated session returns empty context without loadFailed.
    getSessionMock.mockResolvedValueOnce({
      data: { session: null },
      error: null,
    });
    const anonCtx = await readAssistantChildContext();
    expect(anonCtx).toEqual({
      userId: null,
      selectedChildId: null,
      children: [],
      selectedChild: null,
    });

    // 2. Falls back to "children" cache when dashboard-summary is absent.
    getSessionMock.mockResolvedValue({
      data: { session: { user: { id: "parent-1" } } },
      error: null,
    });
    const cachedChild = makeChild("child-c", "parent-1", "Bé Chi", 1);
    writeUserCache("parent-1", "children", [cachedChild]);
    const fromChildrenCache = await readAssistantChildContext();
    expect(fromChildrenCache.children).toEqual([cachedChild]);
    expect(listChildrenMock).not.toHaveBeenCalled();

    // 3. forceRefresh bypasses cache and calls createChildService().list().
    const freshChild = makeChild("child-f", "parent-1", "Bé Phúc", 4);
    listChildrenMock.mockResolvedValueOnce([
      freshChild,
      makeChild("child-x", "parent-9", "Other", 1),
    ]);
    writeSessionSelectedChildId("parent-1", "child-f");
    const refreshed = await readAssistantChildContext({ forceRefresh: true });
    expect(listChildrenMock).toHaveBeenCalledTimes(1);
    expect(refreshed.children).toEqual([freshChild]);
    expect(refreshed.selectedChildId).toBe("child-f");
    expect(refreshed.selectedChild).toEqual(freshChild);

    // 4. list() failure returns loadFailed: true without throwing.
    listChildrenMock.mockRejectedValueOnce(new Error("Network error"));
    const failedCtx = await readAssistantChildContext({ forceRefresh: true });
    expect(failedCtx.loadFailed).toBe(true);
    expect(failedCtx.children).toEqual([]);
    expect(failedCtx.selectedChild).toBeNull();

    // 5. getSession() error returns loadFailed: true without throwing.
    getSessionMock.mockResolvedValueOnce({
      data: { session: null },
      error: new Error("Auth error"),
    });
    const authErrCtx = await readAssistantChildContext();
    expect(authErrCtx.loadFailed).toBe(true);
  });

  it("bridges selectChildFromAssistant to AppStoreProvider via local event, clears read cache, broadcasts signal, and hydrates voice", () => {
    const clearCacheSpy = vi.spyOn(readCacheModule, "clearApiReadCache");
    const setStorageSpy = vi.spyOn(Storage.prototype, "setItem");
    const localHandler = vi.fn();
    const unsubscribe = subscribeLocalSelectedChildChange(localHandler);
    const rawEventHandler = vi.fn();
    window.addEventListener(SELECTED_CHILD_LOCAL_EVENT, rawEventHandler);

    render(
      <AuthRuntimeContext.Provider value={makeAuthRuntime("user-1")}>
        <AppStoreProvider>
          <StoreProbe />
        </AppStoreProvider>
      </AuthRuntimeContext.Provider>,
    );

    expect(screen.getByLabelText("Store child id")).toHaveTextContent("none");

    // Different user event must be ignored by activeUserId === "user-1".
    const otherChild = makeChild("child-other", "user-2", "Bé Hai", 3);
    act(() => {
      selectChildFromAssistant("user-2", otherChild);
    });
    expect(screen.getByLabelText("Store child id")).toHaveTextContent("none");

    // Matching user updates sessionStorage, AppStoreProvider, cache invalidation, storage signal, and voice hydration.
    const childB = makeChild("child-b", "user-1", "Bé Bông", 2);
    act(() => {
      selectChildFromAssistant("user-1", childB);
    });

    expect(screen.getByLabelText("Store child id")).toHaveTextContent(
      "child-b",
    );
    expect(readSessionSelectedChildId("user-1")).toBe("child-b");
    expect(localHandler).toHaveBeenCalledWith({
      userId: "user-1",
      childId: "child-b",
    });
    expect(rawEventHandler).toHaveBeenCalledTimes(2);
    expect(clearCacheSpy).toHaveBeenCalledTimes(1);
    expect(hydrateTeacherVoiceFromChildProfile).toHaveBeenCalledWith(childB);
    expect(
      setStorageSpy.mock.calls.some(([key, value]) => {
        if (key !== "viread:selected-child-signal") return false;
        const parsed = JSON.parse(value) as {
          userId: string;
          childId: string | null;
        };
        return parsed.userId === "user-1" && parsed.childId === "child-b";
      }),
    ).toBe(true);

    window.removeEventListener(SELECTED_CHILD_LOCAL_EVENT, rawEventHandler);
    unsubscribe();
  });
});
