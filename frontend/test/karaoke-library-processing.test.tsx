import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KaraokeLibraryScreen } from "@/components/admin/karaoke/karaoke-library-screen";
import { KaraokeServicesProvider } from "@/components/karaoke/karaoke-services-provider";
import { makeWizardFixture } from "@/test/karaoke-wizard-fixture";
import { jobId } from "@/test/karaoke-processing-fixtures";
import {
  songDetail,
  songId,
  versionId,
  lineId,
  stamp,
} from "@/test/karaoke-fixtures";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("shows job state separately from published visibility and polls only the visible list", async () => {
  vi.useFakeTimers();
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const fixture = makeWizardFixture();
  const item = {
    ...songDetail().draft!,
    song_id: songId,
    status: "PUBLISHED",
    revision: 3,
    draft_version_id: versionId,
    published_version_id: lineId,
    processing_summary: {
      job_id: jobId,
      draft_version_id: versionId,
      status: "RUNNING",
      stage: "ALIGNING_LYRICS",
      safe_error_code: null,
      retry_policy: "NONE",
      updated_at: stamp,
    },
  };
  const service = {
    ...fixture.service,
    list: vi
      .fn()
      .mockResolvedValue({ items: [item], total: 1, limit: 12, offset: 0 }),
  };
  const { unmount } = render(
    <KaraokeServicesProvider service={service}>
      <KaraokeLibraryScreen />
    </KaraokeServicesProvider>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(
    screen.getByText("Đang hiển thị · Có bản đang sửa"),
  ).toBeInTheDocument();
  expect(screen.getByText("Xử lý: Đang tạo karaoke")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Tiếp tục tạo" })).toHaveAttribute(
    "href",
    `/admin/karaoke/${songId}/edit`,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(service.list).toHaveBeenCalledTimes(2);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(service.list).toHaveBeenCalledTimes(2);
  hidden = false;
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
  expect(service.list).toHaveBeenCalledTimes(3);
  expect(service.getProcessing).not.toHaveBeenCalled();
  unmount();
  await vi.advanceTimersByTimeAsync(15000);
  expect(service.list).toHaveBeenCalledTimes(3);
});
