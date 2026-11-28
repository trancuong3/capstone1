import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoReadingRolePlayModal } from "@/components/reading/co-reading-roleplay-modal";
import type {
  CoReadingService,
  ParseScriptResponseDTO,
} from "@/lib/api/co-reading-service";

// ---------------------------------------------------------------------------
// Global mocks (must hoist before any imports that resolve the modules)
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      initialize: async () => ({ error: null }),
      getSession: async () => ({
        data: { session: { access_token: "test-token-feat2" } },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

vi.mock("@/lib/api/api-client", () => ({
  requestApi: vi.fn(),
  apiQuery: (params: Record<string, unknown>) =>
    "?" +
    Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join("&"),
  fetchAuthenticatedBlobUrl: vi.fn().mockResolvedValue("blob:fake-audio-url"),
  resolvePrivateApiMediaUrl: (url: string) => url,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHILD_ID = "child-feat2-test";
const BOOK_ID = "book-feat2-test";
const PAGE_ID = "page-feat2-test";

function makeScriptResponse(
  overrides: Partial<ParseScriptResponseDTO> = {},
): ParseScriptResponseDTO {
  return {
    child_id: CHILD_ID,
    book_id: BOOK_ID,
    page_id: PAGE_ID,
    total_turns: 2,
    turns: [
      {
        index: 0,
        role: "NARRATOR",
        speaker_label: "Người Dẫn Chuyện",
        text: "Ngày xửa ngày xưa, có một chú thỏ nhỏ.",
        words: ["Ngày", "xửa", "ngày", "xưa"],
        voice_id: "vi_female_teacher",
        voice_name: "Cô Lan",
        is_character_dialogue: false,
        turn_owner: "AI_OR_PARENT",
        coaching_prompt_vi: null,
        coaching_voice_id: "vi_female_teacher",
      },
      {
        index: 1,
        role: "CHARACTER_A",
        speaker_label: "Nhân Vật A",
        text: "Con thỏ nói: Tôi muốn đi chơi!",
        words: ["Con", "thỏ", "nói"],
        voice_id: "vi_male_child",
        voice_name: "Bé Nam",
        is_character_dialogue: true,
        turn_owner: "CHILD",
        coaching_prompt_vi: "Đến lượt con đọc câu tiếp theo nhé!",
        coaching_voice_id: "vi_female_teacher",
      },
    ],
    has_dialogue: true,
    narrator_voice_id: "vi_female_teacher",
    coaching_voice_id: "vi_female_teacher",
    character_voices: { CHARACTER_A: "vi_male_child" },
    has_parent_narration: false,
    ...overrides,
  };
}

function makeService(
  overrides: Partial<CoReadingService> = {},
): CoReadingService {
  return {
    parseScript: vi.fn().mockResolvedValue(makeScriptResponse()),
    uploadNarration: vi.fn().mockResolvedValue({
      id: "narr-1",
      parent_id: "parent-1",
      book_id: BOOK_ID,
      page_id: PAGE_ID,
      audio_format: "webm",
      content_type: "audio/webm",
      file_size_bytes: 10240,
      duration_ms: 3000,
      alignment_source: "syllable_duration_fallback",
      word_timings: [{ word: "Ngày", start_ms: 0, end_ms: 400 }],
      audio_endpoint:
        "/co-reading/my-books/book-feat2-test/pages/page-feat2-test/narration/audio",
      visibility: "PARENT_PRIVATE" as const,
      created_at: "2026-11-28T10:00:00Z",
      updated_at: "2026-11-28T10:00:00Z",
    }),
    getNarrationMeta: vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("Not found"), { status: 404 }),
      ),
    deleteNarration: vi
      .fn()
      .mockResolvedValue({ deleted: true, narration_id: "narr-1" }),
    createPostcard: vi.fn(),
    listPostcards: vi.fn(),
    deletePostcard: vi.fn(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CoReadingRolePlayModal", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders all turns with correct turn_owner labels", async () => {
    const service = makeService();
    render(
      <CoReadingRolePlayModal
        childId={CHILD_ID}
        bookId={BOOK_ID}
        pageId={PAGE_ID}
        pageText="Ngày xửa ngày xưa"
        service={service}
      />,
    );

    // Loading then content
    await waitFor(() =>
      expect(screen.getByTestId("turns-list")).toBeInTheDocument(),
    );

    // Turn 0: AI_OR_PARENT
    expect(screen.getByText(/Ba Mẹ \/ AI Đọc/)).toBeInTheDocument();
    // Turn 1: CHILD
    expect(screen.getByText(/Lượt Con/)).toBeInTheDocument();
    // Coaching prompt shown for child turn
    expect(
      screen.getByText(/Đến lượt con đọc câu tiếp theo nhé!/),
    ).toBeInTheDocument();

    expect(service.parseScript).toHaveBeenCalledWith(
      CHILD_ID,
      expect.objectContaining({ book_id: BOOK_ID, page_id: PAGE_ID }),
      expect.any(AbortSignal),
    );
  });

  it("displays narrator and character A cards with correct text", async () => {
    render(
      <CoReadingRolePlayModal childId={CHILD_ID} service={makeService()} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("turn-card-0")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/Ngày xửa ngày xưa, có một chú thỏ nhỏ\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Con thỏ nói: Tôi muốn đi chơi!/),
    ).toBeInTheDocument();
  });

  it("shows error state gracefully for 403 cross-parent isolation", async () => {
    const service = makeService({
      parseScript: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("Forbidden"), { status: 403 }),
        ),
    });
    render(
      <CoReadingRolePlayModal childId="other-parent-child" service={service} />,
    );
    await waitFor(() =>
      expect(screen.getByText(/Không thể tải dữ liệu/)).toBeInTheDocument(),
    );
  });

  it("delete narration button calls service.deleteNarration", async () => {
    const user = userEvent.setup();
    // Pre-populate narration meta so the recorder shows existing narration
    const narrationMeta = {
      id: "narr-1",
      parent_id: "parent-1",
      book_id: BOOK_ID,
      page_id: PAGE_ID,
      audio_format: "webm",
      content_type: "audio/webm",
      file_size_bytes: 10240,
      duration_ms: 3000,
      alignment_source: "syllable_duration_fallback",
      word_timings: [],
      audio_endpoint:
        "/co-reading/my-books/book-feat2-test/pages/page-feat2-test/narration/audio",
      visibility: "PARENT_PRIVATE" as const,
      created_at: "2026-11-28T10:00:00Z",
      updated_at: "2026-11-28T10:00:00Z",
    };
    const service = makeService({
      getNarrationMeta: vi.fn().mockResolvedValue(narrationMeta),
    });

    render(
      <CoReadingRolePlayModal
        childId={CHILD_ID}
        bookId={BOOK_ID}
        pageId={PAGE_ID}
        service={service}
      />,
    );
    await waitFor(() =>
      expect(screen.getByText(/Đã có giọng Ba Mẹ kể/)).toBeInTheDocument(),
    );

    const deleteBtn = screen.getByTestId("delete-narration-btn");
    await user.click(deleteBtn);

    await waitFor(() =>
      expect(service.deleteNarration).toHaveBeenCalledWith(BOOK_ID, PAGE_ID),
    );
  });

  it("audio endpoint uses private cache-control guard (PARENT_PRIVATE)", async () => {
    const { fetchAuthenticatedBlobUrl } = await import("@/lib/api/api-client");
    const narrationMeta = {
      id: "narr-2",
      parent_id: "parent-1",
      book_id: BOOK_ID,
      page_id: PAGE_ID,
      audio_format: "webm",
      content_type: "audio/webm",
      file_size_bytes: 20480,
      duration_ms: 5000,
      alignment_source: "wav_pcm_acoustic_envelope",
      word_timings: [{ word: "xưa", start_ms: 100, end_ms: 500 }],
      audio_endpoint:
        "/co-reading/my-books/book-feat2-test/pages/page-feat2-test/narration/audio",
      visibility: "PARENT_PRIVATE" as const,
      created_at: "2026-11-28T10:00:00Z",
      updated_at: "2026-11-28T10:00:00Z",
    };
    const service = makeService({
      getNarrationMeta: vi.fn().mockResolvedValue(narrationMeta),
    });

    render(
      <CoReadingRolePlayModal
        childId={CHILD_ID}
        bookId={BOOK_ID}
        pageId={PAGE_ID}
        service={service}
      />,
    );

    await waitFor(() =>
      expect(fetchAuthenticatedBlobUrl).toHaveBeenCalledWith(
        narrationMeta.audio_endpoint,
      ),
    );

    // Audio tag should use the blob URL (private, never a plain public URL)
    const audioEl = await screen.findByTestId("narration-audio");
    expect(audioEl).toBeInTheDocument();
    expect((audioEl as HTMLAudioElement).src).toContain("blob:");
  });

  it("dialog has role=dialog and aria-modal=true for accessibility", async () => {
    render(
      <CoReadingRolePlayModal childId={CHILD_ID} service={makeService()} />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });
});
