import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OcrServiceStatusBanner } from "@/components/common/ocr-service-status-banner";
import { useOcrWorkerStatus } from "@/hooks/use-ocr-worker-status";
import { fetchOcrWorkerHealth } from "@/lib/api/page-match-service";
import {
  apiFetchFixture,
  installApiFetchFixture,
} from "@/test/fixtures/api-test-fixture";

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));

beforeEach(() => {
  installApiFetchFixture();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchOcrWorkerHealth", () => {
  it("maps ready, unavailable, probe_degraded, missing ocr, 503, and network errors accurately", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({
        status: "ok",
        ocr: {
          mode: "remote_worker",
          ready: false,
          workers: [{ worker_id: "win-1", online: true }],
          queue: { queued: 3 },
        },
      }),
    );
    expect(await fetchOcrWorkerHealth()).toEqual({
      status: "ready",
      mode: "remote_worker",
      ready: false,
      workerOnline: true,
      queuedCount: 3,
      queueDepth: 3,
      probeDegraded: false,
    });

    apiFetchFixture.mockResolvedValueOnce(
      Response.json({
        status: "ok",
        ocr: {
          mode: "remote_worker",
          ready: false,
          workers: [],
          queue: { queued: 2 },
        },
      }),
    );
    expect(await fetchOcrWorkerHealth()).toEqual({
      status: "unavailable",
      mode: "remote_worker",
      ready: false,
      workerOnline: false,
      queuedCount: 2,
      queueDepth: 2,
      probeDegraded: false,
    });

    apiFetchFixture.mockResolvedValueOnce(
      Response.json({
        status: "ok",
        ocr: {
          mode: "remote_worker",
          ready: false,
          probe_degraded: true,
          workers: [],
          queue: { queued: 1 },
        },
      }),
    );
    expect(await fetchOcrWorkerHealth()).toEqual({
      status: "unreachable",
      mode: "remote_worker",
      ready: false,
      workerOnline: false,
      queuedCount: 1,
      queueDepth: 1,
      probeDegraded: true,
    });

    // Missing ocr payload MUST NOT default to ready
    apiFetchFixture.mockResolvedValueOnce(Response.json({ status: "ok" }));
    expect(await fetchOcrWorkerHealth()).toMatchObject({
      status: "unreachable",
      workerOnline: false,
      ready: false,
    });

    // Non-OK status -> unreachable
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({ detail: "Service Unavailable" }, { status: 503 }),
    );
    expect(await fetchOcrWorkerHealth()).toMatchObject({
      status: "unreachable",
      workerOnline: false,
      ready: false,
    });

    // Network error -> unreachable
    apiFetchFixture.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect(await fetchOcrWorkerHealth()).toMatchObject({
      status: "unreachable",
      workerOnline: false,
      ready: false,
    });
  });
});

describe("useOcrWorkerStatus", () => {
  it("polls while offline, pauses when tab hidden, triggers onRecovered + justRecovered on offline -> ready, and stops polling once ready", async () => {
    vi.useFakeTimers();
    let ready = false;
    let healthCalls = 0;
    const onRecovered = vi.fn();

    apiFetchFixture.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/health") {
        healthCalls += 1;
        return Response.json({
          status: "ok",
          ocr: {
            mode: "remote_worker",
            ready,
            workers: ready ? [{ online: true }] : [],
            queue: { queued: ready ? 0 : 4 },
          },
        });
      }
      throw new Error(`Unexpected ${path}`);
    });

    const { result } = renderHook(() =>
      useOcrWorkerStatus({ pollIntervalMs: 12_000, onRecovered }),
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe("unavailable");
    expect(result.current.isUnavailable).toBe(true);
    expect(result.current.isReady).toBe(false);
    expect(result.current.queueDepth).toBe(4);
    expect(result.current.justRecovered).toBe(false);
    expect(onRecovered).not.toHaveBeenCalled();
    expect(healthCalls).toBe(1);

    // Pause when tab becomes hidden -> advancing timers MUST NOT poll
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(25_000);
    });
    expect(healthCalls).toBe(1);

    // Tab becomes visible -> immediately probes (still offline), then polls after 12s and recovers!
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(healthCalls).toBe(2);

    ready = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.isReady).toBe(true);
    expect(result.current.justRecovered).toBe(true);
    expect(onRecovered).toHaveBeenCalledTimes(1);

    // Dismiss recovered notice
    act(() => {
      result.current.dismissRecoveredNotice();
    });
    expect(result.current.justRecovered).toBe(false);

    // Once ready, advancing timers does NOT keep polling /health
    const callsAtReady = healthCalls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(36_000);
    });
    expect(healthCalls).toBe(callsAtReady);
  });

  it("does not trigger onRecovered on initial healthy mount and supports manual recheckNow()", async () => {
    const onRecovered = vi.fn();
    let ready = true;
    apiFetchFixture.mockImplementation(async () =>
      Response.json({
        status: "ok",
        ocr: { mode: "remote_worker", ready, workers: [] },
      }),
    );

    const { result } = renderHook(() => useOcrWorkerStatus({ onRecovered }));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.justRecovered).toBe(false);
    expect(onRecovered).not.toHaveBeenCalled();

    ready = false;
    let nextState = "checking";
    await act(async () => {
      nextState = await result.current.recheckNow();
    });
    expect(nextState).toBe("unavailable");
    expect(result.current.status).toBe("unavailable");

    ready = true;
    await act(async () => {
      nextState = await result.current.recheckNow();
    });
    expect(nextState).toBe("ready");
    expect(result.current.justRecovered).toBe(true);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });
});

describe("OcrServiceStatusBanner", () => {
  it("renders parent & admin offline variants, queued badge, recheck button, and dismissible recovery banner", async () => {
    const user = userEvent.setup();
    const onRecheck = vi.fn();
    const onDismiss = vi.fn();

    const { rerender } = render(
      <OcrServiceStatusBanner
        onRecheck={onRecheck}
        queuedCount={3}
        status="unavailable"
        variant="parent"
      />,
    );

    const parentBanner = screen.getByTestId("ocr-worker-offline-banner");
    expect(parentBanner).toHaveTextContent(
      /Chức năng nhận diện chữ \(OCR\) hiện chưa sẵn sàng/i,
    );
    expect(parentBanner).toHaveTextContent(/tạm nghỉ/i);
    expect(
      screen.getByTestId("ocr-worker-offline-banner-queue-badge"),
    ).toHaveTextContent("Hàng chờ: 3");

    await user.click(screen.getByRole("button", { name: "Kiểm tra lại ngay" }));
    expect(onRecheck).toHaveBeenCalledTimes(1);

    rerender(<OcrServiceStatusBanner status="unavailable" variant="admin" />);
    expect(
      screen.getByTestId("admin-ocr-worker-offline-banner"),
    ).toHaveTextContent(/Dịch vụ xử lý OCR hiện đang ngoại tuyến/i);

    rerender(
      <OcrServiceStatusBanner
        justRecovered
        onDismissRecovered={onDismiss}
        status="ready"
        variant="parent"
      />,
    );
    const recoveredBanner = screen.getByTestId("ocr-worker-recovered-banner");
    expect(recoveredBanner).toHaveTextContent(/đã hoạt động trở lại/i);
    await user.click(
      screen.getByRole("button", { name: "Đóng thông báo khôi phục OCR" }),
    );
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
