import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdminBookAiBatchReview,
  clearAdminBookAiBatchSessions,
} from "@/components/admin/admin-book-ai-batch-review";
import { AdminBookDetailScreen } from "@/components/admin/admin-book-detail-screen";
import { AdminFlow2CandidatesPanel } from "@/components/admin/admin-flow2-candidates-panel";
import { AdminLayout } from "@/components/admin/admin-layout";
import { AdminOcrReviewScreen } from "@/components/admin/admin-ocr-review-screen";
import { AdminVireadTrainingScreen } from "@/components/admin/admin-viread-training-screen";
import { BookCover } from "@/components/books/book-cover";
import { AuthenticatedImage } from "@/components/common/authenticated-image";
import { Modal } from "@/components/common/modal";
import { PictureDescriptionScreen } from "@/components/entertainment/picture-description/picture-description-screen";
import { BookPageViewer } from "@/components/reading/book-page-viewer";
import { useKaraokePlayer } from "@/hooks/use-karaoke-player";
import type { AdminBookContentQualityService } from "@/lib/api/admin-book-content-quality-service";
import type { SpeechService } from "@/lib/api/speech-service";
import type { VireadTrainingOverview } from "@/lib/api/viread-training-service";
import { createCameraPresenceSource } from "@/lib/reading/presence-camera";
import {
  ADMIN_BOOK_ID,
  ADMIN_PAGE_ID,
  adminR2Fixture,
  createAdminServiceFixture,
  withAdminFixture,
} from "@/test/fixtures/admin-service-fixture";
import type { AdminPageListItemUI } from "@/types/admin";
import type { AdminFlow2CandidatePageDTO } from "@/types/parent-private-book";
import type {
  PictureCatalogDTO,
  PictureSessionDTO,
} from "@/types/picture-description";
import type { ReadingPageDTO } from "@/types/reading";

const mocks = vi.hoisted(() => ({
  fetchAuthenticatedBlobUrl:
    vi.fn<(url: string, signal?: AbortSignal) => Promise<string>>(),
  clearPrivateMediaMemoryCache: vi.fn<() => void>(),
  resetApiReadCacheForActorSwitch: vi.fn<() => void>(),
  pathname: "/admin/books",
  routerPush: vi.fn(),
  routerReplace: vi.fn(),
  routerRefresh: vi.fn(),
  pictureService: {
    getCatalog: vi.fn(),
    listSessions: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn(),
    evaluate: vi.fn(),
  },
  speechService: {
    synthesize: vi.fn(),
    transcribe: vi.fn(),
  } as unknown as SpeechService & {
    synthesize: ReturnType<typeof vi.fn>;
    transcribe: ReturnType<typeof vi.fn>;
  },
  speechPlayer: {
    play: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    isPlaying: false,
  },
  recorder: {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    cancel: vi.fn(),
    isRecording: false,
    isSpeaking: false,
    audioLevel: 0,
  },
}));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();
  return {
    ...actual,
    usePathname: () => mocks.pathname,
    useRouter: () => ({
      push: mocks.routerPush,
      replace: mocks.routerReplace,
      refresh: mocks.routerRefresh,
    }),
    useSearchParams: () => new URLSearchParams(),
  };
});

vi.mock("@/lib/api/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/api-client")>();
  return {
    ...actual,
    fetchAuthenticatedBlobUrl: (...args: [string, AbortSignal?]) =>
      mocks.fetchAuthenticatedBlobUrl(...args),
    clearPrivateMediaMemoryCache: () => {
      mocks.clearPrivateMediaMemoryCache();
      actual.clearPrivateMediaMemoryCache();
    },
  };
});

vi.mock("@/lib/api/read-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/read-cache")>();
  return {
    ...actual,
    resetApiReadCacheForActorSwitch: () => {
      mocks.resetApiReadCacheForActorSwitch();
      actual.resetApiReadCacheForActorSwitch();
    },
  };
});

vi.mock("@/components/admin/admin-page-uploader", () => ({
  AdminPageUploader: ({ onUploaded }: { onUploaded: () => void }) => (
    <button onClick={onUploaded} type="button">
      Trigger refresh pages
    </button>
  ),
}));

vi.mock("@/components/admin/admin-page-image-preview", () => ({
  AdminPageImagePreview: () => <div data-testid="admin-page-preview" />,
}));

vi.mock("@/components/admin/admin-viread-drive-panel", () => ({
  AdminVireadDrivePanel: () => null,
}));

vi.mock("@/components/admin/admin-viread-flow1-replacement", () => ({
  AdminVireadFlow1Replacement: () => null,
  AdminVireadReliabilityPanel: () => null,
}));

vi.mock("@/hooks/use-validated-selected-child", () => ({
  useValidatedSelectedChild: () => ({
    state: {
      status: "ready" as const,
      child: {
        id: "child-1",
        name: "Bé An",
        grade: 2,
        avatar_url: null,
        birth_year: 2018,
      },
    },
    retry: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-picture-description-service", () => ({
  usePictureDescriptionService: () => mocks.pictureService,
}));

vi.mock("@/hooks/use-speech-player", () => ({
  useSpeechPlayer: () => mocks.speechPlayer,
}));

vi.mock("@/hooks/use-speech-recorder", () => ({
  useSpeechRecorder: () => mocks.recorder,
}));

vi.mock("@/lib/api/speech-service", () => ({
  createSpeechService: () => mocks.speechService,
}));

function makeTrainingOverview(): VireadTrainingOverview {
  return {
    outbox: [],
    samples: [],
    jobs: [],
    runs: [],
    benchmarks: [],
    active_model: {
      model_family: "vietocr",
      checkpoint_sha256: "a".repeat(64),
      storage_path: null,
      profile: "ORIGINAL",
      decision_id: null,
      updated_at: "2026-11-26T00:00:00Z",
    },
  };
}

function makePictureSession(
  sessionId: string,
  title: string,
): PictureSessionDTO {
  return {
    session_id: sessionId,
    child_id: "child-1",
    child_grade: 2,
    source_type: "SAMPLE",
    sample_key: sessionId,
    book_id: null,
    book_page_id: null,
    image_url: "/samples/pic.png",
    scene_title: title,
    status: "ACTIVE",
    best_stars: 0,
    best_score: 0,
    attempts_count: 0,
    guide: {
      is_child_safe: true,
      scene_title: title,
      scene_summary: "Tranh công viên buổi sáng.",
      guiding_questions: ["Ai đang chơi trong tranh?"],
      suggested_vocabulary: [{ word: "công viên", hint: "nơi vui chơi" }],
      model_sample_sentences: ["Các bạn nhỏ đang chơi ở công viên."],
    },
    attempts: [],
    created_at: "2026-11-26T00:00:00Z",
    updated_at: "2026-11-26T00:00:00Z",
  };
}

function makeAdminPageItem(
  pageNumber: number,
  pageId: string,
  textPreview: string,
): AdminPageListItemUI {
  return {
    book_id: ADMIN_BOOK_ID,
    page_number: pageNumber,
    text_preview: textPreview,
    processing: {
      page_id: pageId,
      page_revision_id: `${pageId}-rev`,
      revision_no: 1,
      verification_status: "NEEDS_REVIEW",
      lifecycle_status: "ACTIVE",
      ocr_preview_metadata: {},
      verified_at: null,
      current_verified_revision_id: null,
    },
  };
}

describe("Wave 2 & Wave 3 Admin / Media / UI / Games fixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearAdminBookAiBatchSessions();
    mocks.pathname = "/admin/books";
    mocks.fetchAuthenticatedBlobUrl.mockResolvedValue("blob:mock-image");
    mocks.recorder.start.mockResolvedValue(undefined);
    mocks.recorder.stop.mockResolvedValue(
      new Blob(["audio"], { type: "audio/webm" }),
    );
    mocks.speechService.transcribe.mockResolvedValue({
      text: "Các bạn đang chơi ở công viên",
      language_code: "vi",
      language_probability: 0.98,
      words: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
  });

  describe("Modal document Escape listener", () => {
    it("closes on Escape even when focus is outside the dialog inner element", () => {
      const onClose = vi.fn();
      render(
        <div>
          <button type="button">Outside trigger</button>
          <Modal isOpen onClose={onClose} title="Hộp thoại">
            <p>Nội dung</p>
          </Modal>
        </div>,
      );

      const outsideBtn = screen.getByRole("button", {
        name: "Outside trigger",
      });
      outsideBtn.focus();
      expect(outsideBtn).toHaveFocus();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("does not close on document Escape when closeOnEscape is false", () => {
      const onClose = vi.fn();
      render(
        <Modal closeOnEscape={false} isOpen onClose={onClose} title="Khóa">
          <p>Đang xử lý</p>
        </Modal>,
      );

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("Protocol-relative URL rejection (BookCover & BookPageViewer)", () => {
    it("rejects // protocol-relative cover URLs in BookCover and allows single-slash paths", () => {
      const book = {
        id: "book-1",
        title: "Chú mèo đi hia",
        author: "Charles Perrault",
        min_grade: 1,
        max_grade: 2,
        lifecycle_status: "ACTIVE" as const,
      };

      const { container, rerender } = render(
        <BookCover book={book} coverUrl="//evil.example/cover.png" />,
      );
      expect(container.querySelector("img")).toBeNull();
      expect(
        container.querySelector('[data-cover-source="METADATA_RENDER"]'),
      ).not.toBeNull();

      rerender(<BookCover book={book} coverUrl="/valid-covers/cat.webp" />);
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      expect(img).toHaveAttribute("src", "/valid-covers/cat.webp");
    });

    it("rejects // protocol-relative illustrationUrl in BookPageViewer", () => {
      const page: ReadingPageDTO = {
        page_id: "33333333-3333-4333-8333-333333333333",
        page_revision_id: "44444444-4444-4444-8444-444444444444",
        page_number: 1,
        confidence: 0.99,
        width: 800,
        height: 1000,
        image_url: null,
        text: "Bé đọc sách.",
        words: [],
      };

      const { container } = render(
        <BookPageViewer
          currentWordId={null}
          illustrationTextFree
          illustrationUrl="//evil.example/illustration.png"
          page={page}
        />,
      );

      expect(
        container.querySelector('[data-testid="storybook-illustration-card"]'),
      ).toBeNull();
      expect(container.querySelector("article")).toHaveAttribute(
        "data-reading-mode",
        "TEXT",
      );
    });
  });

  describe("Presence camera post-play() generation guard", () => {
    it("stops stream tracks and returns unavailable when stopped while video.play() is pending", async () => {
      vi.useFakeTimers();
      const trackStop = vi.fn();
      const mockTrack = {
        stop: trackStop,
        addEventListener: vi.fn(),
      } as unknown as MediaStreamTrack;
      const mockStream = {
        getTracks: () => [mockTrack],
        getVideoTracks: () => [mockTrack],
      } as unknown as MediaStream;

      const originalMediaDevices = navigator.mediaDevices;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: vi.fn().mockResolvedValue(mockStream),
        },
      });

      let resolvePlay!: () => void;
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, "play")
        .mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              resolvePlay = resolve;
            }),
        );
      vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
        () => undefined,
      );

      try {
        const onSample = vi.fn();
        const source = createCameraPresenceSource({
          allowPrompt: true,
          intervalMs: 50,
        });

        const startPromise = source.start(onSample);
        await Promise.resolve();
        await Promise.resolve();
        expect(playSpy).toHaveBeenCalledTimes(1);

        source.stop();
        resolvePlay();

        const result = await startPromise;
        expect(result).toBe("unavailable");
        expect(trackStop).toHaveBeenCalled();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(250);
        });
        expect(onSample).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: originalMediaDevices,
        });
      }
    });
  });

  describe("useKaraokePlayer state reset on source change", () => {
    it("resets blocked ref, error, ready, and playback state when url changes", async () => {
      class FakeAudio extends EventTarget {
        preload = "";
        volume = 1;
        playbackRate = 1;
        preservesPitch = true;
        muted = false;
        src = "";
        currentTime = 0;
        duration = Number.NaN;
        paused = true;
        ended = false;
        load = vi.fn();
        pause = vi.fn(() => {
          this.paused = true;
        });
        play = vi.fn(async () => {
          this.paused = false;
        });
        removeAttribute = vi.fn((name: string) => {
          if (name === "src") this.src = "";
        });
      }

      const instances: FakeAudio[] = [];
      const OriginalAudio = globalThis.Audio;
      globalThis.Audio = vi.fn(function FakeAudioCtor() {
        const audio = new FakeAudio();
        instances.push(audio);
        return audio;
      }) as unknown as typeof Audio;

      let latest!: ReturnType<typeof useKaraokePlayer>;
      function Harness({ url }: { url: string }) {
        const player = useKaraokePlayer(
          url,
          10_000,
          new Date(Date.now() + 60_000).toISOString(),
        );
        latest = player;
        return (
          <div>
            <span data-testid="ready">{String(player.ready)}</span>
            <span data-testid="error">{player.error}</span>
          </div>
        );
      }

      try {
        const { rerender } = render(<Harness url="https://cdn.test/a.mp3" />);
        expect(instances).toHaveLength(1);

        act(() => {
          instances[0].dispatchEvent(new Event("error"));
        });
        expect(screen.getByTestId("error")).not.toHaveTextContent(/^$/);
        expect(screen.getByTestId("ready")).toHaveTextContent("false");

        await act(async () => {
          await latest.play();
        });
        expect(instances[0].play).not.toHaveBeenCalled();

        rerender(<Harness url="https://cdn.test/b.mp3" />);
        expect(instances).toHaveLength(2);
        expect(screen.getByTestId("error")).toHaveTextContent(/^$/);
        expect(screen.getByTestId("ready")).toHaveTextContent("false");

        act(() => {
          instances[1].duration = 10;
          instances[1].dispatchEvent(new Event("loadedmetadata"));
        });
        expect(screen.getByTestId("ready")).toHaveTextContent("true");

        await act(async () => {
          await latest.play();
        });
        expect(instances[1].play).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.Audio = OriginalAudio;
      }
    });
  });

  describe("AdminFlow2CandidatesPanel All and VERIFIED filters", () => {
    it("supports All ('') and VERIFIED status filters with accurate summary counts", async () => {
      const services = createAdminServiceFixture();
      const pageDto: AdminFlow2CandidatePageDTO = {
        items: [],
        total: 0,
        limit: 50,
        offset: 0,
        summary: {
          PENDING_VERIFICATION: 2,
          VERIFIED: 3,
          SYNC_QUEUED: 1,
        },
      };
      const listFlow2Candidates = vi.fn().mockResolvedValue(pageDto);
      services.bookContentQuality = {
        ...services.bookContentQuality,
        listFlow2Candidates,
      } as unknown as AdminBookContentQualityService &
        typeof services.bookContentQuality;

      render(withAdminFixture(<AdminFlow2CandidatesPanel />, services));

      const allBtn = await screen.findByRole("button", {
        name: "Tất cả (6)",
      });
      const verifiedBtn = screen.getByRole("button", {
        name: "Đã xác minh (3)",
      });

      fireEvent.click(allBtn);
      await waitFor(() =>
        expect(listFlow2Candidates).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "" }),
        ),
      );

      fireEvent.click(verifiedBtn);
      await waitFor(() =>
        expect(listFlow2Candidates).toHaveBeenLastCalledWith(
          expect.objectContaining({ status: "VERIFIED" }),
        ),
      );
    });
  });

  describe("PictureDescriptionScreen STT abort, session fencing & copy", () => {
    it("aborts in-flight STT on session exit/unmount, fences stale transcripts, and uses no ElevenLabs copy", async () => {
      const catalog: PictureCatalogDTO = {
        samples: [
          {
            sample_key: "park-1",
            title: "Công viên buổi sáng",
            theme: "Thiên nhiên",
            description: "Các bạn nhỏ vui chơi.",
            image_url: "/samples/park.png",
          },
          {
            sample_key: "zoo-2",
            title: "Sở thú cuối tuần",
            theme: "Động vật",
            description: "Bé thăm các loài thú.",
            image_url: "/samples/zoo.png",
          },
        ],
        book_pages: [],
      };
      const session1 = makePictureSession("session-1", "Công viên buổi sáng");
      const session2 = makePictureSession("session-2", "Sở thú cuối tuần");
      mocks.pictureService.getCatalog.mockResolvedValue(catalog);
      mocks.pictureService.listSessions.mockResolvedValue([]);
      mocks.pictureService.createSession
        .mockResolvedValueOnce(session1)
        .mockResolvedValueOnce(session2);

      let capturedSignal: AbortSignal | undefined;
      let resolveStt!: (value: {
        text: string;
        language_code: string | null;
        language_probability: number | null;
        words: null;
      }) => void;
      mocks.speechService.transcribe.mockImplementationOnce(
        (_audio: Blob, opts?: { signal?: AbortSignal }) => {
          capturedSignal = opts?.signal;
          return new Promise((resolve) => {
            resolveStt = resolve;
          });
        },
      );

      const { unmount } = render(<PictureDescriptionScreen />);

      const exploreButtons = await screen.findAllByRole("button", {
        name: /Khám phá tranh này/i,
      });
      fireEvent.click(exploreButtons[0]);

      const micButton = await screen.findByRole("button", {
        name: /Nói bằng Micro/i,
      });
      fireEvent.click(micButton);

      const stopButton = await screen.findByRole("button", {
        name: /Dừng ghi âm/i,
      });
      fireEvent.click(stopButton);

      await waitFor(() =>
        expect(mocks.speechService.transcribe).toHaveBeenCalledTimes(1),
      );
      expect(document.body.textContent).not.toContain("ElevenLabs");
      expect(capturedSignal?.aborted).toBe(false);

      // Exit current session & open second session while first STT is still in-flight
      fireEvent.click(
        screen.getByRole("button", { name: /Chọn bức tranh khác/i }),
      );
      expect(capturedSignal?.aborted).toBe(true);
      expect(mocks.recorder.cancel).toHaveBeenCalled();

      const nextExploreButtons = await screen.findAllByRole("button", {
        name: /Khám phá tranh này/i,
      });
      fireEvent.click(nextExploreButtons[1]);
      await screen.findByLabelText("Nội dung bé mô tả bức tranh");

      // Late resolution from session-1 MUST NOT pollute session-2 descriptionText
      await act(async () => {
        resolveStt({
          text: "Văn bản cũ từ phiên trước",
          language_code: "vi",
          language_probability: 0.9,
          words: null,
        });
      });
      expect(screen.getByLabelText("Nội dung bé mô tả bức tranh")).toHaveValue(
        "",
      );

      // Also verify unmount aborts an active STT request cleanly
      let secondSignal: AbortSignal | undefined;
      mocks.speechService.transcribe.mockImplementationOnce(
        (_audio: Blob, opts?: { signal?: AbortSignal }) => {
          secondSignal = opts?.signal;
          return new Promise(() => undefined);
        },
      );
      fireEvent.click(screen.getByRole("button", { name: /Nói bằng Micro/i }));
      fireEvent.click(
        await screen.findByRole("button", { name: /Dừng ghi âm/i }),
      );
      await waitFor(() =>
        expect(mocks.speechService.transcribe).toHaveBeenCalledTimes(2),
      );
      expect(secondSignal?.aborted).toBe(false);

      unmount();
      expect(secondSignal?.aborted).toBe(true);
    });
  });

  describe("AuthenticatedImage ref-stable onImageError", () => {
    it("does not re-trigger fetchAuthenticatedBlobUrl when inline onImageError changes", async () => {
      const privateSrc = "/books/my-books/book-1/pages/page-1/image";
      const { rerender } = render(
        <AuthenticatedImage
          alt="Trang riêng tư"
          onImageError={() => undefined}
          src={privateSrc}
        />,
      );

      await waitFor(() =>
        expect(mocks.fetchAuthenticatedBlobUrl).toHaveBeenCalledTimes(1),
      );

      rerender(
        <AuthenticatedImage
          alt="Trang riêng tư"
          onImageError={() => undefined}
          src={privateSrc}
        />,
      );
      rerender(
        <AuthenticatedImage
          alt="Trang riêng tư"
          onImageError={() => undefined}
          src={privateSrc}
        />,
      );

      expect(mocks.fetchAuthenticatedBlobUrl).toHaveBeenCalledTimes(1);
    });
  });

  describe("AdminBookDetailScreen refreshPages fencing", () => {
    it("drops stale refreshPages responses so older results cannot overwrite newer pages", async () => {
      const services = createAdminServiceFixture();
      const initialPage = makeAdminPageItem(1, "page-1", "Nội dung ban đầu");
      let resolveFirstRefresh!: (pages: AdminPageListItemUI[]) => void;
      let resolveSecondRefresh!: (pages: AdminPageListItemUI[]) => void;

      services.pages.list
        .mockResolvedValueOnce([initialPage])
        .mockImplementationOnce(
          () =>
            new Promise<AdminPageListItemUI[]>((resolve) => {
              resolveFirstRefresh = resolve;
            }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<AdminPageListItemUI[]>((resolve) => {
              resolveSecondRefresh = resolve;
            }),
        );

      render(
        withAdminFixture(
          <AdminBookDetailScreen bookId={ADMIN_BOOK_ID} />,
          services,
        ),
      );

      await screen.findByText("Nội dung ban đầu");

      const refreshBtn = screen.getByRole("button", {
        name: "Trigger refresh pages",
      });
      fireEvent.click(refreshBtn);
      fireEvent.click(refreshBtn);

      await waitFor(() => expect(services.pages.list).toHaveBeenCalledTimes(3));

      await act(async () => {
        resolveSecondRefresh([
          makeAdminPageItem(1, "page-1", "Bản mới nhất từ lượt 2"),
        ]);
      });
      expect(
        await screen.findByText("Bản mới nhất từ lượt 2"),
      ).toBeInTheDocument();

      await act(async () => {
        resolveFirstRefresh([
          makeAdminPageItem(1, "page-1", "Bản cũ từ lượt 1"),
        ]);
      });
      expect(screen.getByText("Bản mới nhất từ lượt 2")).toBeInTheDocument();
      expect(screen.queryByText("Bản cũ từ lượt 1")).not.toBeInTheDocument();
    });
  });

  describe("AdminVireadTrainingScreen visibility-paused polling & fencing", () => {
    it("pauses 30s polling while document.hidden is true and resumes when visible", async () => {
      vi.useFakeTimers();
      let hiddenState = false;
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => hiddenState,
      });

      const services = createAdminServiceFixture();
      const overview = vi.fn().mockResolvedValue(makeTrainingOverview());
      const servicesWithTraining = {
        ...services,
        vireadTraining: {
          overview,
          decide: vi.fn(),
          retry: vi.fn(),
          deleteJob: vi.fn(),
          requestEvaluation: vi.fn(),
          discardMismatchedCandidate: vi.fn(),
          closeUnbenchmarkedCandidate: vi.fn(),
        },
      } as unknown as Parameters<typeof withAdminFixture>[1];

      const { unmount } = render(
        withAdminFixture(<AdminVireadTrainingScreen />, servicesWithTraining),
      );

      // Flush initial setTimeout(0) load
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(overview).toHaveBeenCalledTimes(1);

      // Advance 30s while visible -> polls once
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(overview).toHaveBeenCalledTimes(2);

      // Hide tab -> advancing 90s must NOT poll
      hiddenState = true;
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(90_000);
      });
      expect(overview).toHaveBeenCalledTimes(2);

      // Show tab again -> advancing 30s resumes polling
      hiddenState = false;
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(overview).toHaveBeenCalledTimes(3);

      unmount();
    });
  });

  describe("AdminLayout sign-out cleanup, OCR review filter, and AI batch completedRunId", () => {
    it("clears private media cache and resets API read cache on AdminLayout sign-out", async () => {
      const services = createAdminServiceFixture();
      render(
        withAdminFixture(
          <AdminLayout>
            <p>Admin content</p>
          </AdminLayout>,
          services,
        ),
      );

      fireEvent.click(screen.getByRole("button", { name: "Đăng xuất" }));

      await waitFor(() => expect(services.auth.signOut).toHaveBeenCalledOnce());
      expect(mocks.clearPrivateMediaMemoryCache).toHaveBeenCalledOnce();
      expect(mocks.resetApiReadCacheForActorSwitch).toHaveBeenCalledOnce();
    });

    it("switches OCR word filter to 'all' when clicking a green word hidden under 'review' filter", async () => {
      const services = createAdminServiceFixture();
      services.ocr.getRevision.mockResolvedValue({
        ...adminR2Fixture,
        verification_status: "NEEDS_REVIEW",
        draft_text: "Mèo con",
        words: [
          {
            word_index: 0,
            line_index: 0,
            text: "Mèo",
            normalized_text: "mèo",
            bbox: [0.1, 0.1, 0.2, 0.05],
            ocr_confidence: 0.99,
            ocr_review_status: "verified",
            review_color_group: "green",
          },
          {
            word_index: 1,
            line_index: 0,
            text: "con",
            normalized_text: "con",
            bbox: [0.35, 0.1, 0.2, 0.05],
            ocr_confidence: 0.5,
            ocr_review_status: "needs_review",
            review_color_group: "yellow",
          },
        ],
      });

      render(
        withAdminFixture(
          <AdminOcrReviewScreen
            bookId={ADMIN_BOOK_ID}
            pageId={ADMIN_PAGE_ID}
          />,
          services,
        ),
      );

      const reviewFilterBtn = await screen.findByRole("button", {
        name: /Cần xem \(1\)/i,
      });
      fireEvent.click(reviewFilterBtn);
      expect(reviewFilterBtn).toHaveAttribute("aria-pressed", "true");

      // Click the green word ("Từ 1: Mèo") on the image while filtered to "review"
      const greenWordBox = screen.getByRole("button", {
        name: /^Từ 1: Mèo\./,
      });
      fireEvent.click(greenWordBox);

      const allFilterBtn = screen.getByRole("button", {
        name: /Tất cả \(2\)/i,
      });
      expect(allFilterBtn).toHaveAttribute("aria-pressed", "true");
    });

    it("invokes onCompleted once per completed batch run and does not re-fire on remount", async () => {
      const services = createAdminServiceFixture();
      const pageItem = makeAdminPageItem(1, ADMIN_PAGE_ID, "Mèo con");
      services.ocr.getRevision.mockResolvedValue({
        ...adminR2Fixture,
        page_revision_id: pageItem.processing.page_revision_id,
        verification_status: "NEEDS_REVIEW",
        draft_text: "Mèo",
        words: [
          {
            word_index: 0,
            line_index: 0,
            text: "Mèo",
            normalized_text: "mèo",
            bbox: [0.1, 0.1, 0.2, 0.05],
            ocr_confidence: 0.9,
            ocr_review_status: "needs_review",
          },
        ],
      });
      services.ocr.runCombinedWorkflow.mockResolvedValue({
        workflow_id: "85000000-0000-4000-8000-000000000011",
        page_id: ADMIN_PAGE_ID,
        book_id: ADMIN_BOOK_ID,
        page_revision_id: pageItem.processing.page_revision_id,
        status: "READY_FOR_ADMIN_REVIEW",
        stage: "READY_FOR_ADMIN_REVIEW",
        progress: { completed_chunks: 1, total_chunks: 1 },
        attempts: 1,
        error_code: null,
        original_ocr_hash: "a".repeat(64),
        admin_input_hash: "b".repeat(64),
        proofread_text: "Mèo",
        proofread_output_hash: "c".repeat(64),
        corrections: [],
        uncertain_word_indices: [],
        proofread_metadata: {},
        safety_metadata: {},
        candidate_history: [],
        safety_history: [],
        review_history: [],
        candidate_text: "Mèo",
        candidate_hash: "c".repeat(64),
        candidate_version: 1,
        safety_input_hash: "c".repeat(64),
        hash_match: true,
        suitability: "SUITABLE",
        safety_status: "PROVISIONAL",
        findings: [],
        provider_events: [],
        ocr_approved_at: null,
        final_approved_text_hash: null,
        created_at: "2026-11-26T00:00:00Z",
        updated_at: "2026-11-26T00:00:00Z",
      });
      services.ocr.saveDraft.mockResolvedValue({
        ...adminR2Fixture,
        page_revision_id: pageItem.processing.page_revision_id,
        verification_status: "NEEDS_REVIEW",
        draft_text: "Mèo",
      });

      const onCompleted = vi.fn();
      const { unmount } = render(
        withAdminFixture(
          <AdminBookAiBatchReview
            bookId={ADMIN_BOOK_ID}
            items={[pageItem]}
            onCompleted={onCompleted}
          />,
          services,
        ),
      );

      fireEvent.click(
        screen.getByRole("button", { name: /Chạy AI đề xuất sửa 1 trang/i }),
      );

      await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1));
      unmount();

      // Remounting with an already-completed batch session must NOT fire duplicate onCompleted
      const onCompletedAfterRemount = vi.fn();
      render(
        withAdminFixture(
          <AdminBookAiBatchReview
            bookId={ADMIN_BOOK_ID}
            items={[pageItem]}
            onCompleted={onCompletedAfterRemount}
          />,
          services,
        ),
      );
      expect(onCompletedAfterRemount).not.toHaveBeenCalled();
    });
  });
});
