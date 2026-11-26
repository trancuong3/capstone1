import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { KaraokeEditorScreen } from "@/components/admin/karaoke/karaoke-editor-screen";
import { KaraokeLibraryScreen } from "@/components/admin/karaoke/karaoke-library-screen";
import { LyricTimingEditor } from "@/components/admin/karaoke/lyric-timing-editor";
import { KaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";
import { ServiceError } from "@/lib/api/service-error";
import type { AdminKaraokeService } from "@/lib/api/admin-karaoke-service";
import type {
  AdminKaraokeDetail,
  AdminKaraokeList,
  KaraokeLyrics,
} from "@/types/karaoke";
import {
  lineId,
  previewDetail,
  songDetail,
  songId,
  versionId,
} from "@/test/karaoke-fixtures";

const { replace } = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
// Audio mechanics are exercised separately against native-event test doubles.
// This component stub exposes only the user-gesture review callback here.
vi.mock("@/components/karaoke/karaoke-player", () => ({
  KaraokePlayer: ({
    onPlayed,
    children,
  }: {
    onPlayed?: () => void;
    children?: (p: unknown) => unknown;
  }) => (
    <div>
      <button onClick={onPlayed}>Phát nghe thử kiểm tra</button>
      {children?.(undefined) as React.ReactNode}
    </div>
  ),
}));

function makeService() {
  return {
    getProcessingCapabilities: vi.fn(),
    uploadReference: vi.fn(),
    removeReference: vi.fn(),
    startProcessing: vi.fn(),
    listProcessing: vi.fn(),
    getProcessing: vi.fn(),
    cancelProcessing: vi.fn(),
    retryProcessing: vi.fn(),
    getProcessingPreview: vi.fn(),
    getDraftReferencePreview: vi.fn(),
    applyProcessing: vi.fn(),
    confirmReview: vi.fn(),
    list: vi
      .fn()
      .mockResolvedValue({ items: [], total: 0, limit: 12, offset: 0 }),
    get: vi.fn().mockResolvedValue(songDetail()),
    create: vi.fn().mockResolvedValue(songDetail()),
    createDraft: vi.fn().mockResolvedValue(songDetail()),
    save: vi.fn().mockResolvedValue({ ...songDetail(), revision: 2 }),
    upload: vi.fn().mockResolvedValue({ ...songDetail(), revision: 2 }),
    validate: vi.fn().mockResolvedValue({
      valid: true,
      revision: 1,
      draft_version_id: versionId,
      issues: [],
    }),
    preview: vi.fn().mockResolvedValue(previewDetail()),
    publish: vi.fn().mockImplementation(async () => {
      const data = songDetail();
      return {
        ...data,
        status: "PUBLISHED",
        revision: 2,
        draft: null,
        published: { ...data.draft!, state: "PUBLISHED" },
      };
    }),
    visibility: vi.fn().mockResolvedValue(songDetail()),
  } satisfies AdminKaraokeService;
}
function editor(service: AdminKaraokeService, id: string | undefined = songId) {
  return render(
    <KaraokeServicesProvider service={service}>
      <KaraokeEditorScreen songId={id} />
    </KaraokeServicesProvider>,
  );
}
beforeEach(() => {
  replace.mockReset();
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());
async function waitEditor() {
  await screen.findByRole("button", { name: "Lưu bản nháp" });
}

describe("karaoke admin editor", () => {
  it("loads detail with abortable GET, never creates drafts from render", async () => {
    const service = makeService();
    const { unmount } = editor(service);
    await waitEditor();
    expect(service.get).toHaveBeenCalledWith(songId, expect.any(AbortSignal));
    expect(service.createDraft).not.toHaveBeenCalled();
    expect(service.create).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Tên bài hát")).toHaveValue("Bài hát của bé");
    unmount();
    expect(service.get.mock.calls[0][1].aborted).toBe(true);
  });
  it("creates new content only on an explicit click", async () => {
    const service = makeService();
    render(
      <KaraokeServicesProvider service={service}>
        <KaraokeEditorScreen />
      </KaraokeServicesProvider>,
    );
    fireEvent.change(screen.getByLabelText("Tên bài hát"), {
      target: { value: "Bé hát vui" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Tạo bản nháp" }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(`/admin/karaoke/${songId}/edit`),
    );
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Bé hát vui" }),
      expect.any(AbortSignal),
    );
    expect(service.get).not.toHaveBeenCalled();
  });
  it("keeps input on failure and blocks media uploads until edits are saved", async () => {
    const service = makeService();
    service.save.mockRejectedValueOnce(new Error("private SQL"));
    editor(service);
    await waitEditor();
    fireEvent.change(screen.getByLabelText("Tên bài hát"), {
      target: { value: "Tên đang sửa" },
    });
    expect(
      screen.getByRole("button", { name: "Thay nhạc MP3" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Lưu bản nháp" }));
    await screen.findByText(/Chưa hoàn tất yêu cầu/);
    expect(screen.getByLabelText("Tên bài hát")).toHaveValue("Tên đang sửa");
    expect(screen.queryByText("private SQL")).not.toBeInTheDocument();
    expect(service.save).toHaveBeenCalledWith(
      songId,
      expect.objectContaining({
        expected_revision: 1,
        draft_version_id: versionId,
        title: "Tên đang sửa",
      }),
      expect.any(AbortSignal),
    );
  });
  it("blocks stale edits after 409, keeps text, requires explicit reload", async () => {
    const service = makeService();
    service.save.mockRejectedValueOnce(
      new ServiceError({
        code: "CONTENT_INACTIVE",
        status: 409,
        message: "secret",
        request_id: "",
        retryable: false,
      }),
    );
    editor(service);
    await waitEditor();
    fireEvent.change(screen.getByLabelText("Tên bài hát"), {
      target: { value: "Không được mất" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Lưu bản nháp" }));
    await screen.findByText(/Bài hát vừa thay đổi/);
    expect(screen.getByLabelText("Tên bài hát")).toHaveValue("Không được mất");
    expect(screen.getByRole("button", { name: "Lưu bản nháp" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Tải lại từ máy chủ" }));
    const cancelDialog = screen.getByRole("alertdialog");
    fireEvent.click(within(cancelDialog).getByRole("button", { name: "Hủy" }));
    expect(service.get).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Tải lại từ máy chủ" }));
    const confirmDialog = screen.getByRole("alertdialog");
    fireEvent.click(
      within(confirmDialog).getByRole("button", { name: "Tải lại bản lưu" }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Tên bài hát")).toHaveValue(
        "Bài hát của bé",
      ),
    );
  });
  it("does not overwrite a published version until an explicit draft is requested", async () => {
    const service = makeService();
    const data = songDetail();
    service.get.mockResolvedValue({
      ...data,
      draft: null,
      status: "PUBLISHED",
      published: { ...data.draft!, state: "PUBLISHED" },
    });
    editor(service);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Tạo bản nháp từ bản xuất bản",
      }),
    );
    await waitEditor();
    expect(service.createDraft).toHaveBeenCalledWith(
      songId,
      1,
      expect.any(AbortSignal),
    );
  });
  it("requires valid saved revision and manual preview before publishing", async () => {
    const service = makeService();
    editor(service);
    await waitEditor();
    const publish = screen.getByRole("button", { name: "Xuất bản bài hát" });
    expect(publish).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Kiểm tra điều kiện xuất bản" }),
    );
    await screen.findByText("Bản nháp hợp lệ");
    expect(publish).toBeDisabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Tải bản nghe thử / Căn thời gian" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Phát nghe thử kiểm tra" }),
    );
    expect(publish).toBeEnabled();
    fireEvent.click(publish);
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Xác nhận xuất bản",
      }),
    );
    await screen.findByText("Đã xuất bản bài hát.");
    expect(service.publish).toHaveBeenCalledWith(
      songId,
      1,
      versionId,
      expect.any(AbortSignal),
    );
  });
  it("invalidates validation/review when lyrics change, not only metadata", async () => {
    const service = makeService();
    editor(service);
    await waitEditor();
    fireEvent.click(
      screen.getByRole("button", { name: "Kiểm tra điều kiện xuất bản" }),
    );
    await screen.findByText("Bản nháp hợp lệ");
    fireEvent.click(
      screen.getByRole("button", { name: "Tải bản nghe thử / Căn thời gian" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Phát nghe thử kiểm tra" }),
    );
    fireEvent.change(screen.getByLabelText("Lời dòng 1"), {
      target: { value: "Lời mới" },
    });
    expect(screen.queryByText("Bản nháp hợp lệ")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Xuất bản bài hát" }),
    ).toBeDisabled();
  });
  it("asks before replacing audio and applies cleared server timings", async () => {
    const service = makeService();
    const response = songDetail();
    response.revision = 2;
    response.draft!.lyrics.lines[0].start_ms = null;
    response.draft!.lyrics.lines[0].end_ms = null;
    service.upload.mockResolvedValue(response);
    editor(service);
    await waitEditor();
    const file = new File(["test-only bytes"], "song.mp3", {
      type: "audio/mpeg",
    });
    fireEvent.change(screen.getByLabelText("File nhạc MP3"), {
      target: { files: [file] },
    });
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Hủy",
      }),
    );
    expect(service.upload).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("File nhạc MP3"), {
      target: { files: [file] },
    });
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Thay nhạc",
      }),
    );
    await screen.findByText(/Đã tải nhạc; các mốc/);
    expect(service.upload).toHaveBeenCalledWith(
      songId,
      "audio",
      file,
      1,
      versionId,
      expect.any(AbortSignal),
    );
    expect(screen.getByLabelText("Bắt đầu dòng 1 (ms)")).toHaveValue(null);
  });
  it("blocks duplicate saves while request is pending and aborts on unmount", async () => {
    const service = makeService();
    let resolve!: (data: AdminKaraokeDetail) => void;
    service.save.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { unmount } = editor(service);
    await waitEditor();
    const save = screen.getByRole("button", { name: "Lưu bản nháp" });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(service.save).toHaveBeenCalledOnce();
    const signal = service.save.mock.calls[0][2];
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(songDetail()));
  });
  it("warns on unsaved navigation and before tab close", async () => {
    const service = makeService();
    editor(service);
    await waitEditor();
    fireEvent.change(screen.getByLabelText("Tên bài hát"), {
      target: { value: "Sửa" },
    });
    expect(
      fireEvent.click(
        screen.getByRole("link", { name: "Về danh sách bài hát" }),
      ),
    ).toBe(false);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Hủy",
      }),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("karaoke admin library", () => {
  it("shows empty state and no fake songs", async () => {
    const service = makeService();
    render(
      <KaraokeServicesProvider service={service}>
        <KaraokeLibraryScreen />
      </KaraokeServicesProvider>,
    );
    expect(
      await screen.findByText(/Chưa có bài hát phù hợp/),
    ).toBeInTheDocument();
    expect(service.list).toHaveBeenCalledWith(
      { search: "", status: undefined, offset: 0 },
      expect.any(AbortSignal),
    );
  });
  it("filters, paginates and hides published content with the expected revision", async () => {
    const service = makeService();
    const detail = songDetail();
    const item: AdminKaraokeList["items"][number] = {
      ...detail.draft!,
      song_id: songId,
      status: "PUBLISHED",
      revision: 4,
      draft_version_id: null,
      published_version_id: versionId,
    };
    service.list.mockResolvedValue({
      items: [item],
      total: 15,
      limit: 12,
      offset: 0,
    });
    render(
      <KaraokeServicesProvider service={service}>
        <KaraokeLibraryScreen />
      </KaraokeServicesProvider>,
    );
    await screen.findByRole("heading", { name: "Bài hát của bé" });
    fireEvent.change(screen.getByLabelText("Tìm bài hát"), {
      target: { value: "Bé" },
    });
    fireEvent.change(screen.getByLabelText("Trạng thái"), {
      target: { value: "PUBLISHED" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Áp dụng" }));
    await waitFor(() =>
      expect(service.list).toHaveBeenLastCalledWith(
        { search: "Bé", status: "PUBLISHED", offset: 0 },
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Trang sau" }));
    await waitFor(() =>
      expect(service.list).toHaveBeenLastCalledWith(
        { search: "Bé", status: "PUBLISHED", offset: 12 },
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Ẩn bài hát" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Xác nhận ẩn bài hát" }),
    );
    await waitFor(() =>
      expect(service.visibility).toHaveBeenCalledWith(
        songId,
        4,
        false,
        expect.any(AbortSignal),
      ),
    );
  });
  it("shows retryable read errors", async () => {
    const service = makeService();
    service.list.mockRejectedValueOnce(new Error("private"));
    render(
      <KaraokeServicesProvider service={service}>
        <KaraokeLibraryScreen />
      </KaraokeServicesProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Thử tải lại" }));
    expect(
      await screen.findByText(/Chưa có bài hát phù hợp/),
    ).toBeInTheDocument();
  });
});

describe("timing editor", () => {
  it("bounds the visible form while preserving all 300 lines across edits and pages", () => {
    const lyrics: KaraokeLyrics = {
      format_version: 1,
      lines: Array.from({ length: 300 }, (_, index) => ({
        id: crypto.randomUUID(),
        text: `Dòng ${index + 1}`,
        start_ms: index * 50,
        end_ms: (index + 1) * 50,
      })),
    };
    const saved = vi.fn();
    function Harness() {
      const [value, setValue] = useState(lyrics);
      return (
        <LyricTimingEditor
          lyrics={value}
          duration={20000}
          disabled={false}
          onChange={(next) => {
            saved(next);
            setValue(next);
          }}
        />
      );
    }
    render(<Harness />);
    expect(screen.getByLabelText("Lời dòng 1")).toHaveValue("Dòng 1");
    expect(screen.queryByLabelText("Lời dòng 26")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Trang chỉnh lời"), {
      target: { value: "11" },
    });
    fireEvent.change(screen.getByLabelText("Lời dòng 300"), {
      target: { value: "Dòng cuối đã sửa" },
    });
    const result: KaraokeLyrics = saved.mock.lastCall![0];
    expect(result.lines).toHaveLength(300);
    expect(result.lines[0]).toEqual(lyrics.lines[0]);
    expect(result.lines[299]).toEqual({
      ...lyrics.lines[299],
      text: "Dòng cuối đã sửa",
    });
    expect(
      screen.getByRole("button", { name: "Thêm dòng lời" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Xóa dòng 300" }));
    fireEvent.click(screen.getByRole("button", { name: "Thêm dòng lời" }));
    expect(screen.getByLabelText("Lời dòng 300")).toHaveValue("");
    expect(saved.mock.lastCall![0].lines).toHaveLength(300);
    fireEvent.change(screen.getByLabelText("Trang chỉnh lời"), {
      target: { value: "0" },
    });
    expect(screen.getByLabelText("Lời dòng 1")).toHaveValue("Dòng 1");
  });
  it("rejects bad imports without replacing the current lines", () => {
    const onChange = vi.fn();
    render(
      <LyricTimingEditor
        lyrics={songDetail().draft!.lyrics}
        duration={20000}
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Dán lời thuần văn bản"), {
      target: { value: "a".repeat(301) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Nhập lời đã dán" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Cần 1–300 dòng/);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Lời dòng 1")).toHaveValue(
      "Em vui đến trường",
    );
  });
  it("keeps null times distinct from zero and supports editing/removing lines", () => {
    const onChange = vi.fn();
    render(
      <LyricTimingEditor
        lyrics={songDetail().draft!.lyrics}
        duration={20000}
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Bắt đầu dòng 1 (ms)"), {
      target: { value: "" },
    });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        lines: [expect.objectContaining({ id: lineId, start_ms: null })],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Xóa dòng 1" }));
    expect(onChange).toHaveBeenLastCalledWith({ format_version: 1, lines: [] });
  });
  it("ignores a late file after lyrics change and clears its loading state", async () => {
    const onChange = vi.fn();
    let resolve!: (value: ArrayBuffer) => void;
    const file = new File([], "words.txt");
    file.arrayBuffer = () =>
      new Promise((done) => {
        resolve = done;
      });
    const lyrics = songDetail().draft!.lyrics;
    const { rerender } = render(
      <LyricTimingEditor
        lyrics={lyrics}
        duration={20000}
        disabled={false}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("File lời bài hát"), {
      target: { files: [file] },
    });
    const changed: KaraokeLyrics = {
      ...lyrics,
      lines: [{ ...lyrics.lines[0], text: "Đã thay đổi" }],
    };
    rerender(
      <LyricTimingEditor
        lyrics={changed}
        duration={20000}
        disabled={false}
        onChange={onChange}
      />,
    );
    await act(async () =>
      resolve(new TextEncoder().encode("Lời cũ từ file").buffer),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Đang đọc file lời…")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Lời dòng 1")).toHaveValue("Đã thay đổi");
  });
});
