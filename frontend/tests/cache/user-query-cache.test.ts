import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearUserCache,
  DEFAULT_USER_CACHE_TTL_MS,
  invalidateUserCacheKey,
  readUserCache,
  readUserCacheWithStale,
  USER_CACHE_STORAGE_PREFIX,
  writeUserCache,
} from "@/lib/cache/user-query-cache";

describe("user-query-cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-25T10:00:00Z"));
    clearUserCache();
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  afterEach(() => {
    clearUserCache();
    window.sessionStorage.clear();
    window.localStorage.clear();
    vi.useRealTimers();
  });

  it("partitions cached values strictly by userId in memory and sessionStorage", () => {
    writeUserCache("user-a", "dashboard-summary", {
      profileName: "Phụ huynh A",
      children: [{ id: "c1", alias: "Bé A" }],
    });

    expect(
      window.sessionStorage.getItem(
        `${USER_CACHE_STORAGE_PREFIX}user-a:dashboard-summary`,
      ),
    ).not.toBeNull();

    expect(
      readUserCache<{ profileName: string }>("user-a", "dashboard-summary"),
    ).toEqual({
      profileName: "Phụ huynh A",
      children: [{ id: "c1", alias: "Bé A" }],
    });
    expect(readUserCache("user-b", "dashboard-summary")).toBeNull();
    expect(readUserCache(null, "dashboard-summary")).toBeNull();
    expect(readUserCache("   ", "dashboard-summary")).toBeNull();
  });

  it("returns deep clones so external mutations cannot poison cached state", () => {
    writeUserCache("user-a", "children", [{ id: "c1", alias: "Bé An" }]);
    const first = readUserCache<Array<{ id: string; alias: string }>>(
      "user-a",
      "children",
    );
    expect(first).not.toBeNull();
    first![0].alias = "Mutated";

    expect(
      readUserCache<Array<{ id: string; alias: string }>>("user-a", "children"),
    ).toEqual([{ id: "c1", alias: "Bé An" }]);
  });

  it("enforces TTL expiration and exposes staleness for SWR consumers", () => {
    writeUserCache("user-a", "dashboard-summary", { count: 2 });

    vi.advanceTimersByTime(DEFAULT_USER_CACHE_TTL_MS - 1_000);
    expect(readUserCache("user-a", "dashboard-summary")).toEqual({ count: 2 });
    expect(readUserCacheWithStale("user-a", "dashboard-summary")?.isStale).toBe(
      false,
    );

    vi.advanceTimersByTime(2_000);
    const staleEntry = readUserCacheWithStale("user-a", "dashboard-summary");
    expect(staleEntry).not.toBeNull();
    expect(staleEntry?.isStale).toBe(true);
    expect(staleEntry?.data).toEqual({ count: 2 });

    expect(readUserCache("user-a", "dashboard-summary")).toBeNull();
  });

  it("refuses to store auth tokens or private media URLs", () => {
    writeUserCache("user-a", "access_token", "secret-jwt");
    writeUserCache("user-a", "dashboard-summary", {
      access_token: "secret-jwt",
    });
    writeUserCache("user-a", "private-page", {
      image_url: "https://api.example/books/my-books/1/pages/2/image",
    });
    writeUserCache("user-a", "blob-preview", {
      url: "blob:https://viread.app/1234",
    });

    expect(readUserCache("user-a", "access_token")).toBeNull();
    expect(readUserCache("user-a", "dashboard-summary")).toBeNull();
    expect(readUserCache("user-a", "private-page")).toBeNull();
    expect(readUserCache("user-a", "blob-preview")).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("purges one user or all users on logout without touching unrelated sessionStorage keys", () => {
    window.sessionStorage.setItem("unrelated_key", "keep-me");
    writeUserCache("user-a", "dashboard-summary", { user: "a" });
    writeUserCache("user-a", "children", [{ id: "1" }]);
    writeUserCache("user-b", "dashboard-summary", { user: "b" });

    invalidateUserCacheKey("user-a", "children");
    expect(readUserCache("user-a", "children")).toBeNull();
    expect(readUserCache("user-a", "dashboard-summary")).toEqual({ user: "a" });

    clearUserCache("user-a");
    expect(readUserCache("user-a", "dashboard-summary")).toBeNull();
    expect(readUserCache("user-b", "dashboard-summary")).toEqual({ user: "b" });

    clearUserCache();
    expect(readUserCache("user-b", "dashboard-summary")).toBeNull();
    expect(window.sessionStorage.getItem("unrelated_key")).toBe("keep-me");
  });

  it("persists opted-in SWR entries across sessionStorage resets while preserving strict isolation and logout purge", () => {
    window.localStorage.setItem("keep_local_key", "stay");
    writeUserCache(
      "user-a",
      "dashboard-summary",
      { children: [{ id: "c1", alias: "Bé An" }] },
      { persist: "local" },
    );
    writeUserCache(
      "user-a",
      "private-storage",
      {
        url: "https://proj.supabase.co/storage/v1/object/sign/viread-private-books/book/1.png",
      },
      { persist: "local" },
    );

    expect(readUserCache("user-a", "private-storage")).toBeNull();

    // Simulate Android cold launch (memory + sessionStorage wiped, localStorage survives).
    const storageKey = `${USER_CACHE_STORAGE_PREFIX}user-a:dashboard-summary`;
    const persistedRaw = window.localStorage.getItem(storageKey);
    expect(persistedRaw).not.toBeNull();
    clearUserCache();
    window.sessionStorage.clear();
    window.localStorage.setItem(storageKey, persistedRaw!);

    expect(readUserCache("user-b", "dashboard-summary")).toBeNull();
    expect(readUserCache("user-a", "dashboard-summary")).toEqual({
      children: [{ id: "c1", alias: "Bé An" }],
    });

    clearUserCache("user-a");
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(window.localStorage.getItem("keep_local_key")).toBe("stay");
  });
});
