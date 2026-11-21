import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppServicesContext,
  type AppServices,
} from "@/components/providers/app-services-provider";
import { ReadingAutomationSettings } from "@/components/reading/reading-automation-settings";
import type { ReadingPresenceService } from "@/lib/api/reading-presence-service";
import {
  getAutomationPreferences,
  getCoachingStyle,
  resetAutomationPreferencesCache,
  setAutomationPreferences,
} from "@/lib/reading/automation-preferences";
import { subscribePresenceOptIn } from "@/lib/reading/presence-opt-in";

function fakePresence(initial = false): ReadingPresenceService & {
  setEmailEnabled: ReturnType<typeof vi.fn>;
} {
  let enabled = initial;
  return {
    getSettings: vi.fn(async () => ({ emailEnabled: enabled })),
    setEmailEnabled: vi.fn(async (next: boolean) => {
      enabled = next;
      return { emailEnabled: next };
    }),
    armAlert: vi.fn(),
    confirmAlert: vi.fn(),
    cancelAlert: vi.fn(),
  } as never;
}

function renderSettings(presence?: ReadingPresenceService) {
  const services = presence
    ? ({ readingPresenceService: presence } as unknown as AppServices)
    : null;
  return render(
    <AppServicesContext.Provider value={services}>
      <ReadingAutomationSettings />
    </AppServicesContext.Provider>,
  );
}

function stubCamera(result: "granted" | "denied") {
  const stop = vi.fn();
  const getUserMedia = vi.fn(async () => {
    if (result === "denied") throw new DOMException("no", "NotAllowedError");
    return { getTracks: () => [{ stop }] } as unknown as MediaStream;
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return { getUserMedia, stop };
}

beforeEach(() => {
  window.localStorage.clear();
  resetAutomationPreferencesCache();
});
afterEach(() => {
  Reflect.deleteProperty(navigator, "mediaDevices");
});

describe("automation preferences", () => {
  it("default to the existing automatic behaviour and each toggles on its own", () => {
    expect(getAutomationPreferences()).toEqual({
      assist: true,
      autoAdvance: true,
    });
    setAutomationPreferences({ assist: false });
    expect(getAutomationPreferences()).toEqual({
      assist: false,
      autoAdvance: true,
    });
    setAutomationPreferences({ autoAdvance: false });
    expect(getAutomationPreferences()).toEqual({
      assist: false,
      autoAdvance: false,
    });
    resetAutomationPreferencesCache();
    expect(getAutomationPreferences()).toEqual({
      assist: false,
      autoAdvance: false,
    });
  });

  it("ignores corrupt storage", () => {
    window.localStorage.setItem(
      "viread.automation-preferences.v1",
      "{not json",
    );
    resetAutomationPreferencesCache();
    expect(getAutomationPreferences()).toEqual({
      assist: true,
      autoAdvance: true,
    });
    window.localStorage.setItem(
      "viread.automation-preferences.v1",
      JSON.stringify({ assist: "no", autoAdvance: false }),
    );
    resetAutomationPreferencesCache();
    expect(getAutomationPreferences()).toEqual({
      assist: true,
      autoAdvance: false,
    });
  });
});

describe("ReadingAutomationSettings (G14: three independent parent switches)", () => {
  it("shows assist and auto-advance on, and no email switch without the service", () => {
    renderSettings();
    expect(
      screen.getByRole("switch", { name: /Hỗ trợ tự động/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: /Tự chuyển trang/ }),
    ).toBeChecked();
    expect(screen.queryByRole("switch", { name: /email/i })).toBeNull();
  });

  it("turns assist and auto-advance off independently and remembers them", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("switch", { name: /Hỗ trợ tự động/ }));
    expect(
      screen.getByRole("switch", { name: /Hỗ trợ tự động/ }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("switch", { name: /Tự chuyển trang/ }),
    ).toBeChecked();
    expect(getAutomationPreferences()).toEqual({
      assist: false,
      autoAdvance: true,
    });
    await user.click(screen.getByRole("switch", { name: /Tự chuyển trang/ }));
    expect(getAutomationPreferences()).toEqual({
      assist: false,
      autoAdvance: false,
    });
  });

  it("keeps the email reminder off until a parent turns it on, after camera permission", async () => {
    const user = userEvent.setup();
    const camera = stubCamera("granted");
    const presence = fakePresence(false);
    const announced: boolean[] = [];
    const unsubscribe = subscribePresenceOptIn((value) =>
      announced.push(value),
    );
    renderSettings(presence);
    const email = await screen.findByRole("switch", {
      name: /Nhắc ba mẹ qua email/,
    });
    await waitFor(() => expect(email).toBeEnabled());
    expect(email).not.toBeChecked();
    expect(presence.setEmailEnabled).not.toHaveBeenCalled();

    await user.click(email);
    await waitFor(() => expect(email).toBeChecked());
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1);
    expect(camera.stop).toHaveBeenCalled(); // permission probe only, never kept open
    expect(presence.setEmailEnabled).toHaveBeenCalledWith(true);
    expect(announced).toEqual([true]);

    await user.click(email);
    await waitFor(() => expect(email).not.toBeChecked());
    expect(presence.setEmailEnabled).toHaveBeenLastCalledWith(false);
    expect(camera.getUserMedia).toHaveBeenCalledTimes(1); // no camera to switch off
    expect(announced).toEqual([true, false]);
    unsubscribe();
  });

  it("does not enable the email reminder when the camera is refused", async () => {
    const user = userEvent.setup();
    stubCamera("denied");
    const presence = fakePresence(false);
    renderSettings(presence);
    const email = await screen.findByRole("switch", {
      name: /Nhắc ba mẹ qua email/,
    });
    await waitFor(() => expect(email).toBeEnabled());
    await user.click(email);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /cho phép camera/,
    );
    expect(email).not.toBeChecked();
    expect(presence.setEmailEnabled).not.toHaveBeenCalled();
  });

  it("shows the stored server setting and surfaces a failed save", async () => {
    const user = userEvent.setup();
    stubCamera("granted");
    const presence = fakePresence(true);
    renderSettings(presence);
    const email = await screen.findByRole("switch", {
      name: /Nhắc ba mẹ qua email/,
    });
    await waitFor(() => expect(email).toBeChecked());
    presence.setEmailEnabled.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await user.click(email);
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      /Chưa lưu được/,
    );
  });

  it("lets parents switch coaching style between Dịu dàng chi tiết (Lớp 1) and Ngắn gọn (Đọc thạo) without altering the 3 independent switches (G28)", async () => {
    const user = userEvent.setup();
    renderSettings();
    const gentleBtn = screen.getByRole("button", {
      name: /Dịu dàng chi tiết \(Lớp 1\)/i,
    });
    const conciseBtn = screen.getByRole("button", {
      name: /Ngắn gọn \(Đọc thạo\)/i,
    });
    expect(gentleBtn).toHaveAttribute("aria-pressed", "true");
    expect(getCoachingStyle()).toBe("gentle");

    await user.click(conciseBtn);
    expect(conciseBtn).toHaveAttribute("aria-pressed", "true");
    expect(getCoachingStyle()).toBe("concise");
    expect(getAutomationPreferences()).toEqual({
      assist: true,
      autoAdvance: true,
    });
  });
});
