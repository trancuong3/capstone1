import fs from "node:fs";
import path from "node:path";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n/i18n-provider";
import { OfflinePackControls } from "@/components/offline/offline-pack-controls";
import { wipeOfflineAccountData } from "@/lib/offline/offline-hygiene";
import { resolveOfflineReadingSessionFallback } from "@/lib/offline/offline-reading-bridge";
import {
  drainOfflineSessionOutbox,
  enqueueOfflineSessionEvent,
  getOfflineOutboxStatusSnapshot,
  installOfflineOutboxReconnectAutoDrain,
  listPendingOutboxEvents,
  resetOfflineOutboxForTests,
  type OfflineOutboxTransport,
} from "@/lib/offline/offline-session-outbox";
import {
  OFFLINE_CACHE_STORAGE_PREFIX,
  deleteOfflineBookPack,
  downloadWeeklyReadingPlanPacks,
  getOfflineBookPack,
  getOfflinePageMediaBlob,
  listOfflineBookPacks,
  resetOfflinePackStoreForTests,
  saveOfflineBookPack,
  saveOfflineSessionDescriptor,
  type OfflineReadingPackManifestDTO,
} from "@/lib/offline/reading-pack-store";
import { createSupabaseAuthService } from "@/lib/supabase/auth-service";
import { viMessages } from "@/messages/vi";
import type { ReadingPlanDTO } from "@/types/reading-management";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const PARENT_A = "11111111-1111-4111-8111-111111111111";
const CHILD_A1 = "aaaaaaaa-1111-4111-8111-111111111111";
const CHILD_A2 = "aaaaaaaa-2222-4222-8222-222222222222";
const PARENT_B = "22222222-2222-4222-8222-222222222222";
const CHILD_B1 = "bbbbbbbb-1111-4111-8111-111111111111";

function makeManifest(overrides: {
  parentId?: string;
  childId?: string;
  bookId?: string;
  title?: string;
  visibilityScope?: "CATALOG" | "PARENT_PRIVATE";
  inlineAudioBase64?: string | null;
}): OfflineReadingPackManifestDTO {
  const parentId = overrides.parentId ?? PARENT_A;
  const childId = overrides.childId ?? CHILD_A1;
  const bookId = overrides.bookId ?? "33333333-3333-4333-8333-333333333333";
  const pageId = "44444444-4444-4444-8444-444444444444";
  const revId = "55555555-5555-4555-8555-555555555555";
  const wordId = "66666666-6666-4666-8666-666666666666";

  return {
    manifest_version: 1,
    parent_account_id: parentId,
    child_profile_id: childId,
    book_id: bookId,
    title: overrides.title ?? "Chú Mèo Con Đi Học",
    author: "Nguyễn Nhật Ánh",
    grade: 1,
    min_grade: 1,
    max_grade: 2,
    visibility_scope: overrides.visibilityScope ?? "CATALOG",
    cover_url: null,
    voice_id: "local_north_truc_ly",
    estimated_bytes: 180_000,
    tts_budget_bytes: 8 * 1024 * 1024,
    generated_at: "2026-11-28T07:00:00Z",
    pages: [
      {
        page_id: pageId,
        page_number: 1,
        page_revision_id: revId,
        width: 800,
        height: 1000,
        verified_text: "Mèo con đi học",
        words: [
          {
            word_id: wordId,
            word_index: 0,
            line_index: 0,
            text: "Mèo",
            normalized_text: "mèo",
            bbox: [0.1, 0.2, 0.18, 0.06],
          },
        ],
        phonics_keyterms: ["mèo"],
        image_url: "https://cdn.example.test/p1.webp",
        tts_audio: {
          cached: Boolean(overrides.inlineAudioBase64),
          cache_scope:
            overrides.visibilityScope === "PARENT_PRIVATE"
              ? "PRIVATE"
              : "CATALOG",
          voice_id: "local_north_truc_ly",
          model_version: "vieneu-v3",
          speed: 1.0,
          audio_format: "audio/mpeg",
          byte_size: overrides.inlineAudioBase64 ? 16 : 0,
          duration_seconds: 1.4,
          audio_url: null,
          inline_audio_base64: overrides.inlineAudioBase64 ?? null,
          word_timings: [{ index: 0, start: 0.0, end: 0.5 }],
        },
      },
    ],
  };
}

class MemoryCacheBucket {
  private readonly entries = new Map<string, Response>();

  async put(req: RequestInfo | URL, res: Response): Promise<void> {
    const key = typeof req === "string" ? req : req.toString();
    this.entries.set(key, res);
  }

  async keys(): Promise<readonly Request[]> {
    return Array.from(this.entries.keys()).map((u) => new Request(u));
  }

  async delete(req: RequestInfo | URL): Promise<boolean> {
    const key =
      req instanceof Request
        ? req.url
        : typeof req === "string"
          ? req
          : req.toString();
    return this.entries.delete(key);
  }
}

function installFakeCaches() {
  const buckets = new Map<string, MemoryCacheBucket>();
  const fakeCaches = {
    async open(name: string) {
      let bucket = buckets.get(name);
      if (!bucket) {
        bucket = new MemoryCacheBucket();
        buckets.set(name, bucket);
      }
      return bucket;
    },
    async keys() {
      return Array.from(buckets.keys());
    },
    async delete(name: string) {
      return buckets.delete(name);
    },
    _buckets: buckets,
  };
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    writable: true,
    value: fakeCaches,
  });
  return fakeCaches;
}

describe("Feature #8 Offline Reading Pack Store, Outbox & Logout Hygiene", () => {
  let fakeCaches: ReturnType<typeof installFakeCaches>;
  const originalOnLine = Object.getOwnPropertyDescriptor(
    window.navigator,
    "onLine",
  );

  const setNavigatorOnline = (online: boolean) => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => online,
    });
  };

  beforeEach(() => {
    resetOfflinePackStoreForTests();
    resetOfflineOutboxForTests();
    fakeCaches = installFakeCaches();
    setNavigatorOnline(true);
  });

  afterEach(() => {
    cleanup();
    resetOfflinePackStoreForTests();
    resetOfflineOutboxForTests();
    if (originalOnLine) {
      Object.defineProperty(window.navigator, "onLine", originalOnLine);
    }
  });

  it("strictly isolates packs, images, and PRIVATE TTS clips by (parent, child) partition", async () => {
    const inlineAudioB64 = Buffer.from("ID3-private-clip").toString("base64");
    const privManifest = makeManifest({
      parentId: PARENT_A,
      childId: CHILD_A1,
      bookId: "77777777-7777-4777-8777-777777777777",
      title: "Sách Riêng Của Bé An",
      visibilityScope: "PARENT_PRIVATE",
      inlineAudioBase64: inlineAudioB64,
    });

    const summary = await saveOfflineBookPack({
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
      manifest: privManifest,
      pageImages: {
        [privManifest.pages[0].page_id]: new Uint8Array([1, 2, 3, 4, 5]),
      },
    });

    expect(summary.visibilityScope).toBe("PARENT_PRIVATE");
    expect(summary.hasCachedTts).toBe(true);

    // PARENT_PRIVATE packs MUST NEVER enter Cache Storage
    expect(await fakeCaches.keys()).toEqual([]);

    // Owner (PARENT_A, CHILD_A1) can load pack & binary TTS/image blobs
    const loadedOwner = await getOfflineBookPack(
      PARENT_A,
      CHILD_A1,
      privManifest.book_id,
    );
    expect(loadedOwner?.book.title).toBe("Sách Riêng Của Bé An");
    expect(loadedOwner?.pages[0].text).toBe("Mèo con đi học");

    const ttsBlob = await getOfflinePageMediaBlob(
      PARENT_A,
      CHILD_A1,
      privManifest.book_id,
      privManifest.pages[0].page_id,
      "tts",
    );
    expect(ttsBlob).not.toBeNull();
    expect(ttsBlob?.size).toBe(16);

    // Sibling child (PARENT_A, CHILD_A2) and another parent (PARENT_B, CHILD_B1) see ZERO data
    expect(
      await getOfflineBookPack(PARENT_A, CHILD_A2, privManifest.book_id),
    ).toBeNull();
    expect(
      await getOfflineBookPack(PARENT_B, CHILD_B1, privManifest.book_id),
    ).toBeNull();
    expect(await listOfflineBookPacks(PARENT_B, CHILD_B1)).toEqual([]);

    // Cross-parent write of PARENT_A's manifest into PARENT_B's partition is blocked
    await expect(
      saveOfflineBookPack({
        parentAccountId: PARENT_B,
        childProfileId: CHILD_B1,
        manifest: privManifest,
      }),
    ).rejects.toThrow(/Cross-parent offline pack write blocked/i);
  });

  it("saves, loads, deletes single & weekly plan packs (capped at 3 books) and hydrates offline session", async () => {
    const downloadedIds: string[] = [];
    const summaries = await downloadWeeklyReadingPlanPacks({
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
      bookIds: ["book-1", "book-2", "book-3", "book-4", "book-5"],
      fetchManifest: async (childId, bookId) => {
        downloadedIds.push(bookId);
        return makeManifest({
          parentId: PARENT_A,
          childId,
          bookId,
          title: `Sách ${bookId}`,
          visibilityScope: "CATALOG",
        });
      },
      fetchBinary: async () => new Blob([new Uint8Array([9, 8, 7])], { type: "image/webp" }),
    });

    // Weekly plan download is strictly bounded to at most 3 books
    expect(downloadedIds).toEqual(["book-1", "book-2", "book-3"]);
    expect(summaries).toHaveLength(3);
    expect(await fakeCaches.keys()).toEqual([
      `${OFFLINE_CACHE_STORAGE_PREFIX}${encodeURIComponent(PARENT_A)}:${encodeURIComponent(CHILD_A1)}`,
    ]);

    // Save offline session descriptor & verify Airplane Mode bootstrap
    setNavigatorOnline(false);
    await saveOfflineSessionDescriptor({
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
      sessionId: "offline-session-abc",
      clientSessionId: "88888888-8888-4888-8888-888888888888",
      bookId: "book-2",
      child: {
        id: CHILD_A1,
        parent_id: PARENT_A,
        alias: "Bé An",
        grade: 1,
        settings: {},
        created_at: "2026-11-28T07:00:00Z",
      },
      startPageId: null,
      endPageId: null,
      currentPageId: null,
    });

    const bootstrap = await resolveOfflineReadingSessionFallback({
      sessionId: "offline-session-abc",
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
    });
    expect(bootstrap).not.toBeNull();
    expect(bootstrap?.book.title).toBe("Sách book-2");
    expect(bootstrap?.currentPage.text).toBe("Mèo con đi học");

    // Delete single pack removes only book-2
    const deleted = await deleteOfflineBookPack(PARENT_A, CHILD_A1, "book-2");
    expect(deleted).toBe(true);
    expect(await getOfflineBookPack(PARENT_A, CHILD_A1, "book-2")).toBeNull();
    expect((await listOfflineBookPacks(PARENT_A, CHILD_A1)).map((p) => p.bookId).sort()).toEqual([
      "book-1",
      "book-3",
    ]);
  });

  it("queues offline attempts per partition and auto-drains with Idempotency-Key on reconnect", async () => {
    setNavigatorOnline(false);
    const sessionUuid = "99999999-9999-4999-8999-999999999999";

    const evA = await enqueueOfflineSessionEvent({
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
      clientSessionId: sessionUuid,
      bookId: "33333333-3333-4333-8333-333333333333",
      pageId: "44444444-4444-4444-8444-444444444444",
      pageRevisionId: "55555555-5555-4555-8555-555555555555",
      eventKind: "WORD_ATTEMPT",
      wordText: "Mèo",
      transcript: "mèo",
      isCorrect: true,
    });
    await enqueueOfflineSessionEvent({
      parentAccountId: PARENT_B,
      childProfileId: CHILD_B1,
      clientSessionId: "abababab-abab-4bab-8bab-abababababab",
      bookId: "33333333-3333-4333-8333-333333333333",
      pageId: "44444444-4444-4444-8444-444444444444",
      pageRevisionId: "55555555-5555-4555-8555-555555555555",
      eventKind: "SESSION_FINISH",
      score: 95,
    });

    expect(evA.payload.client_event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(await listPendingOutboxEvents(PARENT_A, CHILD_A1)).toHaveLength(1);
    expect(await listPendingOutboxEvents(PARENT_B, CHILD_B1)).toHaveLength(1);
    expect(getOfflineOutboxStatusSnapshot(PARENT_A, CHILD_A1).state).toBe(
      "pending",
    );

    const transportCalls: Array<{
      childId: string;
      count: number;
      idemKey: string;
    }> = [];
    const mockTransportImpl: OfflineOutboxTransport = async (
      childId,
      events,
      idemKey,
    ) => {
      transportCalls.push({ childId, count: events.length, idemKey });
      return {
        child_id: childId,
        batch_idempotency_key: idemKey,
        total_received: events.length,
        applied_count: events.length,
        deduplicated_count: 0,
        reconciled_stale_count: 0,
        session_ids: [sessionUuid],
        results: events.map((e) => ({
          client_event_id: e.client_event_id,
          client_session_id: e.client_session_id,
          server_session_id: sessionUuid,
          applied: true,
          deduplicated: false,
          stale_revision_reconciled: false,
        })),
      };
    };
    const mockTransport: OfflineOutboxTransport = vi.fn(mockTransportImpl);

    const cleanupAutoDrain = installOfflineOutboxReconnectAutoDrain(
      () => ({ parentAccountId: PARENT_A, childProfileId: CHILD_A1 }),
      mockTransport,
    );

    // Reconnect triggers auto-drain for active (PARENT_A, CHILD_A1)
    setNavigatorOnline(true);
    window.dispatchEvent(new Event("online"));

    await waitFor(async () => {
      expect(await listPendingOutboxEvents(PARENT_A, CHILD_A1)).toHaveLength(0);
    });
    expect(transportCalls).toHaveLength(1);
    expect(transportCalls[0].childId).toBe(CHILD_A1);
    expect(transportCalls[0].idemKey).toContain("outbox:");
    expect(getOfflineOutboxStatusSnapshot(PARENT_A, CHILD_A1).state).toBe(
      "synced",
    );
    // PARENT_B's partition remains untouched until PARENT_B drains
    expect(await listPendingOutboxEvents(PARENT_B, CHILD_B1)).toHaveLength(1);

    cleanupAutoDrain();
  });

  it("completely purges offline packs, Cache Storage, and outbox on logout and inactive profile", async () => {
    await saveOfflineBookPack({
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
      manifest: makeManifest({ parentId: PARENT_A, childId: CHILD_A1 }),
      pageImages: {
        "44444444-4444-4444-8444-444444444444": new Uint8Array([1, 2, 3]),
      },
    });
    await enqueueOfflineSessionEvent({
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
      clientSessionId: "99999999-9999-4999-8999-999999999999",
      bookId: "33333333-3333-4333-8333-333333333333",
      pageId: "44444444-4444-4444-8444-444444444444",
      pageRevisionId: "55555555-5555-4555-8555-555555555555",
    });

    expect(await listOfflineBookPacks(PARENT_A, CHILD_A1)).toHaveLength(1);
    expect(await listPendingOutboxEvents(PARENT_A, CHILD_A1)).toHaveLength(1);
    expect((await fakeCaches.keys()).length).toBeGreaterThan(0);

    // Sign out through Supabase AuthService -> triggers wipeOfflineAccountData()
    const signOutSpy = vi.fn().mockResolvedValue({ error: null });
    const fakeSupabase = {
      auth: {
        signOut: signOutSpy,
        getUser: vi.fn().mockResolvedValue({
          data: { user: { id: PARENT_A } },
          error: null,
        }),
      },
      from: vi.fn(() => ({
        select: () => ({
          eq: () => ({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { role: "parent", active: 0 }, // Inactive account!
              error: null,
            }),
          }),
        }),
      })),
    };
    const authService = createSupabaseAuthService(fakeSupabase as never);
    await authService.signOut();

    expect(signOutSpy).toHaveBeenCalled();
    expect(await listOfflineBookPacks(PARENT_A, CHILD_A1)).toEqual([]);
    expect(await listPendingOutboxEvents(PARENT_A, CHILD_A1)).toEqual([]);
    expect(await fakeCaches.keys()).toEqual([]);

    // Repopulate and verify inactive profile detection (`active === 0`) also purges offline data
    await saveOfflineBookPack({
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
      manifest: makeManifest({ parentId: PARENT_A, childId: CHILD_A1 }),
    });
    expect(await listOfflineBookPacks(PARENT_A, CHILD_A1)).toHaveLength(1);

    await expect(authService.getCurrentRole()).rejects.toThrow();
    await waitFor(async () => {
      expect(await listOfflineBookPacks(PARENT_A, CHILD_A1)).toEqual([]);
    });

    // Direct wipe helper verification
    const directRes = await wipeOfflineAccountData({ reason: "logout" });
    expect(directRes.reason).toBe("logout");
  });

  it("renders OfflinePackControls (single & weekly-plan), sync pill, delete button, and CSP-safe sw.js", async () => {
    const user = userEvent.setup();
    const manifest = makeManifest({
      parentId: PARENT_A,
      childId: CHILD_A1,
      bookId: "book-ui-1",
    });

    const plans: ReadingPlanDTO[] = [
      {
        id: "plan-1",
        child_id: CHILD_A1,
        book_id: "book-ui-1",
        book_title: "Chú Mèo Con Đi Học",
        title: "Kế hoạch tuần 1",
        target_minutes: 15,
        weekdays: [0, 2, 4],
        starts_on: "2026-11-24",
        ends_on: null,
        timezone: "Asia/Ho_Chi_Minh",
        status: "ACTIVE",
        scheduled_days_this_week: 3,
        completed_days_this_week: 1,
        progress_percent: 33,
        completed_at: null,
        created_at: "2026-11-24T00:00:00Z",
        updated_at: "2026-11-24T00:00:00Z",
      },
    ];

    await enqueueOfflineSessionEvent({
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
      clientSessionId: "99999999-9999-4999-8999-999999999999",
      bookId: "book-ui-1",
      pageId: manifest.pages[0].page_id,
      pageRevisionId: manifest.pages[0].page_revision_id,
    });

    const i18nProps: React.ComponentProps<typeof I18nProvider> = {
      initialLocale: "vi",
      initialMessages: viMessages,
      children: React.createElement(
        "div",
        null,
        React.createElement(OfflinePackControls, {
          bookId: "book-ui-1",
          parentAccountId: PARENT_A,
          childProfileId: CHILD_A1,
          fetchManifest: async () => manifest,
          fetchBinary: async () => null,
        }),
        React.createElement(OfflinePackControls, {
          mode: "weekly-plan",
          plans,
          parentAccountId: PARENT_A,
          childProfileId: CHILD_A1,
          fetchManifest: async () => manifest,
          fetchBinary: async () => null,
        }),
      ),
    };
    render(React.createElement(I18nProvider, i18nProps));

    expect(
      screen.getByRole("button", { name: /Tải đọc ngoại tuyến/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Tải gói đọc tuần này/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("offline-wasm-stt-status").length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getAllByTestId("offline-outbox-status-pill")[0],
    ).toHaveTextContent(/Chờ mạng để đồng bộ/i);

    await user.click(
      screen.getByRole("button", { name: /Tải đọc ngoại tuyến/i }),
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("offline-pack-delete-btn").length).toBeGreaterThan(
        0,
      );
    });

    // Drain outbox -> pill updates to "Đã đồng bộ xong"
    await drainOfflineSessionOutbox({
      parentAccountId: PARENT_A,
      childProfileId: CHILD_A1,
      transport: async (cid, events, idemKey) => ({
        child_id: cid,
        batch_idempotency_key: idemKey,
        total_received: events.length,
        applied_count: events.length,
        deduplicated_count: 0,
        reconciled_stale_count: 0,
        session_ids: ["99999999-9999-4999-8999-999999999999"],
        results: events.map((e) => ({
          client_event_id: e.client_event_id,
          client_session_id: e.client_session_id,
          server_session_id: "99999999-9999-4999-8999-999999999999",
          applied: true,
          deduplicated: false,
          stale_revision_reconciled: false,
        })),
      }),
    });

    await waitFor(() => {
      expect(
        screen.getAllByTestId("offline-outbox-status-pill")[0],
      ).toHaveTextContent("Đã đồng bộ xong");
    });

    // Delete pack via button
    await user.click(screen.getAllByTestId("offline-pack-delete-btn")[0]);
    await waitFor(async () => {
      expect(await listOfflineBookPacks(PARENT_A, CHILD_A1)).toEqual([]);
    });

    // Verify CSP-safe Service Worker file
    const swPath = path.resolve(process.cwd(), "public", "sw.js");
    const swSource = fs.readFileSync(swPath, "utf-8");
    expect(swSource).not.toContain("eval(");
    expect(swSource).toContain("/books/my-books");
    expect(swSource).toContain("VIREAD_PURGE_ACCOUNT_CACHE");
  });
});
