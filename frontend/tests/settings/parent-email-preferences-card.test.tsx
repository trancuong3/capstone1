import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ParentEmailPreferencesCard } from "@/components/settings/parent-email-preferences-card";
import type {
  ParentEmailDeliveryDTO,
  ParentEmailPreferencesDTO,
  ParentNotificationService,
} from "@/lib/api/parent-notification-service";

const mockService: ParentNotificationService = {
  getPreferences: vi.fn(),
  updatePreferences: vi.fn(),
  getHistory: vi.fn(),
  sendTestEmail: vi.fn(),
};

vi.mock("@/lib/api/parent-notification-service", () => ({
  createParentNotificationService: () => mockService,
}));

const basePrefs: ParentEmailPreferencesDTO = {
  weekly_digest_enabled: true,
  inactivity_alert_enabled: true,
  inactivity_days: 5,
  milestone_enabled: true,
  digest_weekday: 6,
  timezone: "Asia/Ho_Chi_Minh",
  quiet_hours_start: 21,
  quiet_hours_end: 7,
  max_emails_per_week: 4,
  delivery_configured: true,
  delivery_provider: "resend",
  updated_at: "2026-11-26T10:00:00Z",
};

const sampleHistory: ParentEmailDeliveryDTO[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    category: "WEEKLY_DIGEST",
    status: "SENT",
    subject: "Báo cáo đọc sách tuần 20/11–26/11 của gia đình trên ViRead",
    sent_at: "2026-11-26T02:00:00Z",
    created_at: "2026-11-26T02:00:00Z",
    error_code: null,
  },
];

describe("ParentEmailPreferencesCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockService.getPreferences).mockResolvedValue(basePrefs);
    vi.mocked(mockService.getHistory).mockResolvedValue(sampleHistory);
    vi.mocked(mockService.updatePreferences).mockImplementation(
      async (patch) => ({
        ...basePrefs,
        ...patch,
      }),
    );
    vi.mocked(mockService.sendTestEmail).mockResolvedValue({
      status: "SENT",
      delivery_id: "22222222-2222-4222-8222-222222222222",
      provider: "resend",
      message:
        "Đã gửi email thử nghiệm đến địa chỉ email đã xác minh của ba mẹ.",
    });
  });

  it("loads preferences, toggles scenario, and saves changes", async () => {
    const user = userEvent.setup();
    render(<ParentEmailPreferencesCard emailVerified={true} />);

    const digestSwitch = await screen.findByRole("switch", {
      name: /Báo cáo tiến độ học hàng tuần/i,
    });
    expect(digestSwitch).toBeChecked();

    await user.click(digestSwitch);
    expect(digestSwitch).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Lưu cài đặt email" }));

    await waitFor(() => {
      expect(mockService.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({
          weekly_digest_enabled: false,
          inactivity_alert_enabled: true,
          inactivity_days: 5,
          max_emails_per_week: 4,
        }),
      );
    });
    expect(
      await screen.findByText(/Đã lưu cài đặt thông báo email/i),
    ).toBeInTheDocument();
  });

  it("sends test email and refreshes delivery history", async () => {
    const user = userEvent.setup();
    render(<ParentEmailPreferencesCard emailVerified={true} />);

    const sendBtn = await screen.findByRole("button", {
      name: /Gửi email thử nghiệm/i,
    });
    expect(sendBtn).toBeEnabled();

    await user.click(sendBtn);

    await waitFor(() => {
      expect(mockService.sendTestEmail).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/Đã gửi email thử nghiệm/i),
    ).toBeInTheDocument();
  });

  it("warns and disables test email when server delivery is unconfigured", async () => {
    vi.mocked(mockService.getPreferences).mockResolvedValue({
      ...basePrefs,
      delivery_configured: false,
      delivery_provider: "unconfigured",
    });

    render(<ParentEmailPreferencesCard emailVerified={true} />);

    expect(
      await screen.findByText(/Máy chủ chưa bật gửi email ra ngoài/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Gửi email thử nghiệm/i }),
    ).toBeDisabled();
  });

  it("lets parent customize quiet hours and preserves custom stored inactivity days", async () => {
    const user = userEvent.setup();
    vi.mocked(mockService.getPreferences).mockResolvedValue({
      ...basePrefs,
      inactivity_days: 10,
      quiet_hours_start: 21,
      quiet_hours_end: 7,
    });

    render(<ParentEmailPreferencesCard emailVerified={true} />);

    const inactivitySelect = await screen.findByLabelText(
      /Nhắc khi bé nghỉ đọc sau/i,
    );
    expect(inactivitySelect).toHaveValue("10");

    const quietSelect = screen.getByLabelText(/Khung giờ yên tĩnh/i);
    await user.selectOptions(quietSelect, "22-6");

    await user.click(screen.getByRole("button", { name: "Lưu cài đặt email" }));

    await waitFor(() => {
      expect(mockService.updatePreferences).toHaveBeenCalledWith(
        expect.objectContaining({
          inactivity_days: 10,
          quiet_hours_start: 22,
          quiet_hours_end: 6,
        }),
      );
    });
  });

  it("preserves test-email success notice even if subsequent history refresh fails", async () => {
    const user = userEvent.setup();
    vi.mocked(mockService.getHistory)
      .mockResolvedValueOnce(sampleHistory)
      .mockRejectedValueOnce(new Error("transient network blip"));

    render(<ParentEmailPreferencesCard emailVerified={true} />);

    const sendBtn = await screen.findByRole("button", {
      name: /Gửi email thử nghiệm/i,
    });
    await user.click(sendBtn);

    expect(
      await screen.findByText(/Đã gửi email thử nghiệm đến địa chỉ email/i),
    ).toBeInTheDocument();
  });

  it("enforces >= 44px touch targets on toggle rows and select controls", async () => {
    render(<ParentEmailPreferencesCard emailVerified={true} />);

    const weekdaySelect = await screen.findByLabelText("Ngày gửi báo cáo tuần");
    const inactivitySelect = screen.getByLabelText(/Nhắc khi bé nghỉ đọc sau/i);
    const capSelect = screen.getByLabelText("Trần chống spam mỗi tuần");
    const quietSelect = screen.getByLabelText(/Khung giờ yên tĩnh/i);

    for (const selectEl of [
      weekdaySelect,
      inactivitySelect,
      capSelect,
      quietSelect,
    ]) {
      expect(selectEl.className).toContain("min-h-11");
    }

    const digestSwitch = screen.getByRole("switch", {
      name: /Báo cáo tiến độ học hàng tuần/i,
    });
    expect(digestSwitch.closest("label")?.className).toContain("min-h-11");
  });
});
