import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { createHash, webcrypto } from "node:crypto";
import { KaraokeWizardScreen } from "@/components/admin/karaoke/karaoke-wizard-screen";
import { KaraokeWorkspaceScreen } from "@/components/admin/karaoke/karaoke-workspace-screen";
import { KaraokeReviewPanel } from "@/components/admin/karaoke/karaoke-review-panel";
import { KaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";
import { KaraokeWizardController } from "@/lib/karaoke/wizard-controller";
import { prepareWizardLyrics } from "@/lib/karaoke/wizard-lyrics";
import { ServiceError } from "@/lib/api/service-error";
import {
  makeWizardFixture,
  wizardCapabilities,
} from "@/test/karaoke-wizard-fixture";
import {
  songDetail,
  syllableLyrics,
  previewDetail,
  versionId,
  lineId,
  songId,
} from "@/test/karaoke-fixtures";
import { processingJob, jobId } from "@/test/karaoke-processing-fixtures";
import type { AdminKaraokeService } from "@/lib/api/admin-karaoke-service";
import type { KaraokeLine } from "@/types/karaoke";
const { push, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));
vi.mock("@/components/karaoke/karaoke-player", () => ({
  KaraokePlayer: ({
    onPlayed,
    children,
    source,
  }: {
    onPlayed?: () => void;
    source: { audio_url: string };
    children?: (player: unknown) => React.ReactNode;
  }) => (
    <div data-testid="player" data-source={source.audio_url}>
      <button onClick={onPlayed}>Phát nhạc kiểm thử</button>
      {children?.({ pause: vi.fn(), ready: false, getCurrentMs: () => 0 })}
    </div>
  ),
}));
const controllers: KaraokeWizardController[] = [];
beforeEach(() => {
  push.mockReset();
  replace.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  controllers.forEach((c) => c.suspend());
  controllers.length = 0;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function error(status: number) {
  return new ServiceError({
    code: "NETWORK_ERROR",
    status,
    message: "safe test-only",
    retryable: false,
    request_id: "",
  });
}
function mountWizard(service: AdminKaraokeService) {
  return render(
    <StrictMode>
      <KaraokeServicesProvider service={service}>
        <KaraokeWizardScreen initial={null} capabilities={wizardCapabilities} />
      </KaraokeServicesProvider>
    </StrictMode>,
  );
}
function fillNew() {
  fireEvent.change(screen.getByLabelText("Bài hát có giọng (MP3)"), {
    target: {
      files: [
        new File(["fixture-only"], "Bài thử.mp3", { type: "audio/mpeg" }),
      ],
    },
  });
  fireEvent.change(screen.getByLabelText("Tên bài hát"), {
    target: { value: "Tên admin chọn" },
  });
  fireEvent.change(screen.getByLabelText("Lời bài hát"), {
    target: { value: "Bé hát, vui!" },
  });
}
describe("karaoke wizard rendering and explicit workflow", () => {
  it("expands repeat notation only after consent and supports explicit undo without creating a song", () => {
    const { service } = makeWizardFixture();
    mountWizard(service);
    const field = screen.getByLabelText("Lời bài hát");
    fireEvent.change(field, { target: { value: "Bé hát, vui! ×2" } });
    expect(field).toHaveValue("Bé hát, vui! ×2");
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Mở rộng câu lặp" }));
    expect(field).toHaveValue("Bé hát, vui! ×2");
    fireEvent.click(screen.getByRole("button", { name: "Mở rộng câu lặp" }));
    expect(field).toHaveValue("Bé hát, vui!\nBé hát, vui!");
    fireEvent.click(
      screen.getByRole("button", { name: "Hoàn tác mở rộng lời" }),
    );
    expect(field).toHaveValue("Bé hát, vui! ×2");
    expect(service.create).not.toHaveBeenCalled();
    expect(service.startProcessing).not.toHaveBeenCalled();
  });

  it("hides repeat undo once the admin edits the expanded text", () => {
    const { service } = makeWizardFixture();
    mountWizard(service);
    const field = screen.getByLabelText("Lời bài hát");
    fireEvent.change(field, { target: { value: "Bé hát ×2" } });
    fireEvent.click(screen.getByRole("button", { name: "Mở rộng câu lặp" }));
    fireEvent.change(field, { target: { value: "Lời mới của admin" } });
    expect(
      screen.queryByRole("button", { name: "Hoàn tác mở rộng lời" }),
    ).not.toBeInTheDocument();
  });

  it("mounts without POST, retains File after create, and requires separate apply/review/publish", async () => {
    const { service } = makeWizardFixture();
    mountWizard(service);
    expect(service.create).not.toHaveBeenCalled();
    fillNew();
    fireEvent.change(screen.getByLabelText("Nguồn nhạc và lời"), {
      target: { value: "Nguồn fixture riêng" },
    });
    fireEvent.change(screen.getByLabelText("Quyền sử dụng nội dung"), {
      target: { value: "Chỉ fixture kiểm thử" },
    });
    expect(screen.getByLabelText("Tên bài hát")).toHaveValue("Tên admin chọn");
    fireEvent.click(screen.getByRole("button", { name: "Tạo karaoke" }));
    await screen.findByRole("button", { name: "Nghe kết quả chưa áp dụng" });
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.upload).toHaveBeenCalledTimes(1);
    expect(service.upload.mock.calls[0][2].name).toBe("Bài thử.mp3");
    expect(service.save.mock.calls.at(-1)![1].lyrics).toMatchObject({
      format_version: 2,
    });
    expect(service.applyProcessing).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(
      screen
        .getByText("1. Nhạc và lời đã lưu — xem / chỉnh sửa")
        .closest("details"),
    ).not.toHaveAttribute("open");
    expect(
      screen
        .getByRole("list", { name: "Các bước tạo karaoke" })
        .querySelector('[aria-current="step"]'),
    ).toHaveTextContent("2. Xử lý");
    expect(
      screen.getByRole("link", { name: "Mở lại bài hát đã lưu" }),
    ).toHaveAttribute("href", `/admin/karaoke/${songId}/edit`);
    fireEvent.click(
      screen.getByRole("button", { name: "Nghe kết quả chưa áp dụng" }),
    );
    await screen.findByRole("region", { name: "Nghe kết quả chưa áp dụng" });
    expect(service.publish).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Dùng kết quả này trong bản nháp" }),
    );
    await screen.findByRole("region", { name: "Nghe và duyệt bản nháp" });
    await waitFor(() => expect(service.validate).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Phát nhạc kiểm thử" }));
    expect(service.confirmReview).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Xuất bản bài hát" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Tôi đã nghe nhạc nền/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Tôi đã nghe và duyệt" }),
      ).toBeEnabled(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Tôi đã nghe và duyệt" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Xuất bản bài hát" }),
      ).toBeEnabled(),
    );
    expect(service.confirmReview.mock.calls[0][1]).toMatchObject({
      confirmed_listened: true,
      content_fingerprint: "c".repeat(64),
    });
    fireEvent.click(screen.getByRole("button", { name: "Xuất bản bài hát" }));
    await screen.findByText("Bài hát đã xuất bản");
    expect(service.publish).toHaveBeenCalledTimes(1);
  });
  it("suggests title only when empty, validates files locally and preserves text on errors", () => {
    const { service } = makeWizardFixture();
    mountWizard(service);
    fillNew();
    fireEvent.change(screen.getByLabelText("Bài hát có giọng (MP3)"), {
      target: { files: [new File(["fixture"], "Other.mp3")] },
    });
    expect(screen.getByLabelText("Tên bài hát")).toHaveValue("Tên admin chọn");
    fireEvent.change(screen.getByLabelText("Bài hát có giọng (MP3)"), {
      target: { files: [new File(["fixture"], "bad.wav")] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("MP3");
    expect(screen.getByLabelText("Lời bài hát")).toHaveValue("Bé hát, vui!");
    expect(service.upload).not.toHaveBeenCalled();
  });
  it.each([401, 403])(
    "does not turn capabilities %s into a manual-support fallback",
    async (status) => {
      const { service } = makeWizardFixture();
      service.getProcessingCapabilities.mockRejectedValue(error(status));
      render(
        <KaraokeServicesProvider service={service}>
          <KaraokeWorkspaceScreen />
        </KaraokeServicesProvider>,
      );
      await screen.findByRole("alert");
      expect(
        screen.queryByRole("button", { name: "Tạo karaoke" }),
      ).not.toBeInTheDocument();
      expect(service.create).not.toHaveBeenCalled();
    },
  );
  it("falls back to manual on old-backend 404 without creating a draft", async () => {
    const { service } = makeWizardFixture();
    service.getProcessingCapabilities.mockRejectedValue(error(404));
    render(
      <KaraokeServicesProvider service={service}>
        <KaraokeWorkspaceScreen />
      </KaraokeServicesProvider>,
    );
    await screen.findByText(/Tự động tạo karaoke chưa sẵn sàng/);
    expect(service.startProcessing).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
  });
  it("does not clone a published song on GET/mount", async () => {
    const { service, setData, data } = makeWizardFixture();
    const published = data();
    published.published = { ...published.draft!, state: "PUBLISHED" };
    published.draft = null;
    setData(published);
    render(
      <KaraokeServicesProvider service={service}>
        <KaraokeWorkspaceScreen songId={songId} />
      </KaraokeServicesProvider>,
    );
    await screen.findByRole("button", { name: "Tạo bản nháp để chỉnh sửa" });
    expect(service.createDraft).not.toHaveBeenCalled();
  });
  it("blocks navigation while files/text are not saved, without cancelling a server job", () => {
    const { service } = makeWizardFixture();
    mountWizard(service);
    fillNew();
    vi.mocked(window.confirm).mockReturnValue(false);
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });
    const allowed = screen
      .getByRole("link", { name: "Danh sách bài hát" })
      .dispatchEvent(event);
    expect(allowed).toBe(false);
    expect(service.cancelProcessing).not.toHaveBeenCalled();
  });
});
describe("wizard controller recovery and input identity", () => {
  function controller(initial: ReturnType<typeof songDetail> | null = null) {
    const fixture = makeWizardFixture();
    if (initial) fixture.setData(initial);
    const model = new KaraokeWizardController(
      fixture.service,
      wizardCapabilities,
      initial,
    );
    controllers.push(model);
    model.activate();
    return { ...fixture, model };
  }
  it("preserves repeated line IDs and null timings without distributing timestamps", () => {
    const first = prepareWizardLyrics(
      "Bé hát, vui!\nBé hát, vui!",
      { format_version: 2, lines: [] },
      20000,
    );
    const second = prepareWizardLyrics(
      "Bé hát, vui!\nCâu mới\nBé hát, vui!",
      first,
      20000,
    );
    expect(second.lines[0].id).toBe(first.lines[0].id);
    expect(second.lines[2].id).toBe(first.lines[1].id);
    expect(
      second.lines
        .flatMap((l) => l.syllables!)
        .every((s) => s.start_ms === null && s.end_ms === null),
    ).toBe(true);
    expect(
      prepareWizardLyrics(
        "Be\u0301 ha\u0301t, vui!\nBé hát, vui!",
        first,
        20000,
      ).lines[0].id,
    ).toBe(first.lines[0].id);
  });
  it("retries lost create with the same intent/body, then saves newer edits to the recovered draft", async () => {
    const { model, service } = controller();
    service.create.mockRejectedValueOnce(error(0));
    model.setMetadata({ ...songDetail().draft!, title: "Original" });
    model.setRawLyrics("Bé hát, vui!");
    model.chooseFile("audio", new File(["fixture"], "song.mp3"));
    await model.createAndProcess();
    const intent = structuredClone(service.create.mock.calls[0][0]);
    model.setMetadata({ ...model.getSnapshot().metadata, title: "Newer" });
    await model.createAndProcess();
    expect(service.create.mock.calls[1][0]).toEqual(intent);
    expect(service.save.mock.calls.at(-1)![1].title).toBe("Newer");
    expect(service.upload).toHaveBeenCalledTimes(1);
  });
  it("does not convert legacy lyrics or enqueue on mount/metadata-only save", async () => {
    const data = songDetail();
    const { model, service } = controller(data);
    model.setMetadata({ ...data.draft!, author: "Edited author" });
    await model.flush();
    expect(service.save.mock.calls[0][1].lyrics).toEqual(data.draft!.lyrics);
    expect(service.startProcessing).not.toHaveBeenCalled();
  });
  it("resumes APPLIED read-only and never adopts GET into newer typed content", async () => {
    const initial = songDetail();
    initial.processing_summary = {
      job_id: jobId,
      draft_version_id: versionId,
      status: "APPLIED",
      stage: "COMPLETE",
      safe_error_code: null,
      retry_policy: "NONE",
      updated_at: initial.updated_at,
    };
    const { model, service } = controller(initial);
    service.getProcessing.mockResolvedValue(
      processingJob({ status: "APPLIED", applied_revision: 1 }),
    );
    model.setMetadata({ ...initial.draft!, title: "Local typing" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(model.getSnapshot().metadata.title).toBe("Local typing");
    expect(service.applyProcessing).not.toHaveBeenCalled();
    expect(service.preview).not.toHaveBeenCalled();
  });
  it("does not retry a failed upload automatically or create another draft", async () => {
    const { model, service } = controller();
    service.upload.mockRejectedValue(error(415));
    model.setRawLyrics("Bé hát, vui!");
    model.chooseFile("audio", new File(["fixture"], "song.mp3"));
    await model.createAndProcess();
    await model.createAndProcess();
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.upload).toHaveBeenCalledTimes(1);
    expect(model.getSnapshot().file?.name).toBe("song.mp3");
    expect(service.startProcessing).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "recovers a lost upload only when server hash and CAS prove the write (match=%s)",
    async (matches) => {
      vi.stubGlobal("crypto", webcrypto);
      const { model, service, data, setData } = controller();
      const bytes = new TextEncoder().encode("test-only audio bytes");
      const file = new File([bytes], "recover.mp3");
      file.arrayBuffer = async () => bytes.buffer;
      service.upload.mockImplementationOnce(async () => {
        const saved = data();
        saved.revision++;
        saved.draft = {
          ...saved.draft!,
          has_audio: true,
          duration_ms: 20000,
          audio_sha256: matches
            ? createHash("sha256").update(bytes).digest("hex")
            : "f".repeat(64),
        };
        setData(saved);
        throw error(0);
      });
      model.setRawLyrics("Bé hát, vui!");
      model.chooseFile("audio", file);
      await model.createAndProcess();
      expect(service.get).toHaveBeenCalledTimes(1);
      expect(service.upload).toHaveBeenCalledTimes(1);
      expect(service.create).toHaveBeenCalledTimes(1);
      if (matches) {
        expect(model.getSnapshot().file).toBeNull();
        expect(service.startProcessing).toHaveBeenCalledTimes(1);
      } else {
        expect(model.getSnapshot().file).toBe(file);
        expect(service.startProcessing).not.toHaveBeenCalled();
        expect(model.getSnapshot().save?.state).toBe("error");
      }
    },
  );
  it.each([false, true])(
    "a replacement after rejected MP3 preserves input and requires an unchanged server draft (changed=%s)",
    async (changed) => {
      const { model, service, data, setData } = controller();
      service.upload.mockRejectedValueOnce(error(415));
      model.setRawLyrics("Bé hát, vui!");
      model.chooseFile("audio", new File(["bad codec"], "bad.mp3"));
      await model.createAndProcess();
      model.setMetadata({
        ...model.getSnapshot().metadata,
        title: "Newer typed title",
      });
      if (changed) {
        const remote = data();
        remote.revision++;
        remote.draft!.title = "Other admin";
        setData(remote);
      }
      const replacement = new File(["new valid fixture"], "replacement.mp3");
      model.chooseFile("audio", replacement);
      await model.createAndProcess();
      expect(service.create).toHaveBeenCalledTimes(1);
      expect(service.get).toHaveBeenCalledTimes(1);
      expect(model.getSnapshot().rawLyrics).toBe("Bé hát, vui!");
      if (changed) {
        expect(service.upload).toHaveBeenCalledTimes(1);
        expect(model.getSnapshot().file).toBe(replacement);
        expect(model.getSnapshot().error).toContain("máy chủ đã đổi");
      } else {
        expect(service.upload).toHaveBeenCalledTimes(2);
        expect(service.save.mock.calls.at(-1)![1].title).toBe(
          "Newer typed title",
        );
        expect(service.startProcessing).toHaveBeenCalledTimes(1);
      }
    },
  );
  it("keeps old marks while replacement uploads, then clears marks only after ACK without changing lyric IDs", async () => {
    const initial = songDetail();
    initial.draft!.lyrics = syllableLyrics();
    const { model, service } = controller(initial);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalUpload = service.upload.getMockImplementation()!;
    service.upload.mockImplementationOnce(async (...args) => {
      await waiting;
      return originalUpload(...args);
    });
    model.chooseFile("audio", new File(["replacement fixture"], "new.mp3"));
    const task = model.createAndProcess();
    await waitFor(() => expect(service.upload).toHaveBeenCalledTimes(1));
    expect(model.getSnapshot().lyrics.lines[0].syllables![0].start_ms).toBe(
      1000,
    );
    release();
    await task;
    const saved: KaraokeLine =
      service.save.mock.calls.at(-1)![1].lyrics.lines[0];
    expect(saved.id).toBe(lineId);
    expect(saved.start_ms).toBeNull();
    expect(saved.end_ms).toBeNull();
    expect(saved.syllables!.map((s) => s.id)).toEqual(
      initial.draft!.lyrics.lines[0].syllables!.map((s) => s.id),
    );
    expect(
      saved.syllables!.every((s) => s.start_ms === null && s.end_ms === null),
    ).toBe(true);
    expect(service.startProcessing.mock.calls[0][1].source_kind).toBe(
      "DRAFT_AUDIO",
    );
  });
  it("retains the timing editor preview through autosave but invalidates review until a fresh read", async () => {
    const initial = songDetail();
    initial.draft!.lyrics = syllableLyrics();
    const { model } = controller(initial);
    await model.loadDraftPreview();
    const preview = model.getSnapshot().preview;
    const lyrics = structuredClone(model.getSnapshot().lyrics);
    lyrics.lines[0].syllables![0].start_ms = 1100;
    model.setTimedLyrics(lyrics);
    expect(model.getSnapshot().preview).toBe(preview);
    expect(model.getSnapshot().validation).toBeNull();
    await model.flush();
    expect(model.getSnapshot().preview).toBe(preview);
    expect(model.getSnapshot().lyrics.lines[0].syllables![0].start_ms).toBe(
      1100,
    );
    expect(model.canPublish()).toBe(false);
    await model.loadDraftPreview();
    const savedPreview = model.getSnapshot().preview;
    if (savedPreview?.kind !== "draft")
      throw new Error("Expected draft preview");
    expect(savedPreview.source.revision).toBe(
      model.getSnapshot().detail?.revision,
    );
  });
  it("keeps the saved draft and backing preview when reference is absent (422)", async () => {
    const initial = songDetail();
    initial.processing_review = {
      required: true,
      reviewed: false,
      reviewed_at: null,
      current_content_fingerprint: "c".repeat(64),
      quality_flags: [],
    };
    const { model, service } = controller(initial);
    await model.loadDraftPreview();
    const preview = model.getSnapshot().preview;
    service.getDraftReferencePreview.mockRejectedValueOnce(error(422));
    await model.loadReference();
    expect(model.getSnapshot().preview).toBe(preview);
    expect(model.getSnapshot().referenceError).toContain(
      "chưa có bản hát đối chiếu",
    );
    expect(model.getSnapshot().detail?.revision).toBe(1);
    expect(service.getProcessingPreview).not.toHaveBeenCalled();
    expect(service.confirmReview).not.toHaveBeenCalled();
  });
  it("does not infer lost-upload success from an already-present hash and an unrelated revision", async () => {
    vi.stubGlobal("crypto", webcrypto);
    const bytes = new TextEncoder().encode("same existing fixture bytes");
    const initial = songDetail();
    initial.draft!.audio_sha256 = createHash("sha256")
      .update(bytes)
      .digest("hex");
    const { model, service, data, setData } = controller(initial);
    const file = new File([bytes], "same.mp3");
    file.arrayBuffer = async () => bytes.buffer;
    service.upload.mockImplementationOnce(async () => {
      const remote = data();
      remote.revision++;
      remote.draft!.lyrics.lines[0].text = "Other admin lyrics";
      setData(remote);
      throw error(0);
    });
    model.chooseFile("audio", file);
    await model.createAndProcess();
    expect(model.getSnapshot().file).toBe(file);
    expect(service.startProcessing).not.toHaveBeenCalled();
    expect(service.save).not.toHaveBeenCalled();
    expect(model.getSnapshot().rawLyrics).toBe(
      initial.draft!.lyrics.lines[0].text,
    );
  });
  it("does not publish a legacy draft without the explicit listening confirmation", async () => {
    const { model, service } = controller(songDetail());
    await model.loadDraftPreview();
    await model.publish();
    expect(service.publish).not.toHaveBeenCalled();
    expect(model.getSnapshot().error).toContain("duyệt đúng bản nháp");
  });
});
describe("review flags and identity", () => {
  it("switches from reference to backing before focusing an editable flagged syllable", () => {
    const data = songDetail();
    data.draft!.lyrics = syllableLyrics();
    const line = data.draft!.lyrics.lines[0];
    // jsdom does not implement scrolling; the browser suite verifies navigation.
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    const marked = line.syllables![1];
    data.processing_review = {
      required: true,
      reviewed: false,
      reviewed_at: null,
      current_content_fingerprint: "c".repeat(64),
      quality_flags: [
        {
          id: jobId,
          line_id: line.id,
          syllable_ids: [marked.id],
          codes: ["HELD_NOTE_UNCERTAIN"],
          message_key: "HELD_NOTE_UNCERTAIN",
          affected_syllable_count: 1,
        },
      ],
    };
    const confirm = vi.fn();
    render(
      <KaraokeReviewPanel
        preview={{
          kind: "draft",
          source: { ...previewDetail(), lyrics: data.draft!.lyrics },
        }}
        detail={data}
        validation={null}
        busy={false}
        dirty={false}
        lyrics={data.draft!.lyrics}
        reference={{
          song_id: songId,
          draft_version_id: versionId,
          revision: 1,
          content_fingerprint: "c".repeat(64),
          reference_audio_url: "https://media.example.test/ref.mp3",
          reference_audio_url_expires_at: "2099-01-01T00:00:00Z",
        }}
        referenceError=""
        onReference={vi.fn()}
        onReload={vi.fn()}
        onApply={vi.fn()}
        onConfirm={confirm}
        onChangeLyrics={vi.fn()}
        onSave={vi.fn()}
        onPublish={vi.fn()}
        canPublish={false}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Nghe bản hát đối chiếu" }),
    );
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-source",
      "https://media.example.test/ref.mp3",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Kiểm tra câu được đánh dấu" }),
    );
    expect(screen.getByLabelText("Nội dung tiếng đang chọn")).toBeEnabled();
    expect(screen.getByLabelText("Nội dung tiếng đang chọn")).toHaveValue(
      marked.text,
    );
    expect(
      screen.getByRole("button", { name: `Chọn tiếng 2: ${marked.text}` }),
    ).toHaveFocus();
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-source",
      previewDetail().audio_url,
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("refreshes the selected reference without switching to backing or fetching a staging job", () => {
    const data = songDetail();
    const onReference = vi.fn(),
      onReload = vi.fn();
    render(
      <KaraokeReviewPanel
        preview={{ kind: "draft", source: previewDetail() }}
        detail={data}
        validation={null}
        busy={false}
        dirty={false}
        lyrics={data.draft!.lyrics}
        reference={{
          song_id: songId,
          draft_version_id: versionId,
          revision: 1,
          content_fingerprint: "c".repeat(64),
          reference_audio_url: "https://media.example.test/ref.mp3",
          reference_audio_url_expires_at: "2099-01-01T00:00:00Z",
        }}
        referenceError=""
        onReference={onReference}
        onReload={onReload}
        onApply={vi.fn()}
        onConfirm={vi.fn()}
        onChangeLyrics={vi.fn()}
        onSave={vi.fn()}
        onPublish={vi.fn()}
        canPublish={false}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Nghe bản hát đối chiếu" }),
    );
    const oldPlayer = screen.getByTestId("player");
    fireEvent.click(
      screen.getByRole("button", { name: "Làm mới bản hát đối chiếu" }),
    );
    expect(onReference).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();
    expect(screen.getByTestId("player")).not.toBe(oldPlayer);
    expect(screen.getByTestId("player")).toHaveAttribute(
      "data-source",
      "https://media.example.test/ref.mp3",
    );
  });
  it("keeps deleted-line warnings for acknowledgment and never treats play as review", () => {
    const data = songDetail();
    data.draft!.lyrics = syllableLyrics();
    data.processing_review = {
      required: true,
      current_content_fingerprint: "c".repeat(64),
      reviewed: false,
      reviewed_at: null,
      quality_flags: [
        {
          id: lineId,
          line_id: songId,
          syllable_ids: [],
          codes: ["HELD_NOTE_UNCERTAIN"],
          message_key: "HELD_NOTE_UNCERTAIN",
          affected_syllable_count: 1,
        },
      ],
    };
    const confirm = vi.fn();
    render(
      <KaraokeReviewPanel
        preview={{
          kind: "draft",
          source: { ...previewDetail(), lyrics: data.draft!.lyrics },
        }}
        detail={data}
        validation={{
          valid: false,
          revision: 1,
          draft_version_id: versionId,
          issues: [
            {
              code: "PROCESSING_REVIEW_REQUIRED",
              field: "review",
              line_id: null,
            },
          ],
        }}
        busy={false}
        dirty={false}
        lyrics={data.draft!.lyrics}
        reference={null}
        referenceError=""
        onReference={vi.fn()}
        onReload={vi.fn()}
        onApply={vi.fn()}
        onConfirm={confirm}
        onChangeLyrics={vi.fn()}
        onSave={vi.fn()}
        onPublish={vi.fn()}
        canPublish={false}
      />,
    );
    expect(screen.getByText(/câu gốc đã đổi/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Kiểm tra câu được đánh dấu" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Phát nhạc kiểm thử" }));
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Tôi đã nghe nhạc nền/ }),
    );
    expect(
      screen.getByRole("button", { name: "Tôi đã nghe và duyệt" }),
    ).toBeDisabled();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Tôi đã kiểm tra và xử lý cảnh báo này.",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Tôi đã nghe và duyệt" }),
    );
    expect(confirm).toHaveBeenCalledWith([lineId], true);
  });
});
