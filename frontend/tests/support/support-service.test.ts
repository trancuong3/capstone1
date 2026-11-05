import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSupportService,
  SupportFeedbackError,
} from "@/lib/api/support-service";

const { getSessionMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: { getSession: getSessionMock },
  }),
}));

vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "https://api.example.test",
}));

const fetchMock = vi.fn();

const request = {
  category: "technical_issue" as const,
  subject: "Không thể mở sách",
  message: "Tôi gặp lỗi khi bắt đầu đọc.",
  contact_email: "parent@example.com",
};

describe("SupportService", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "parent-access-token" } },
      error: null,
    });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the feedback with the Supabase bearer token and never supplies a recipient", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: true,
          delivery_status: "accepted_by_smtp",
          detail: "The SMTP server accepted the support message.",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );

    await expect(
      createSupportService().submitFeedback(request),
    ).resolves.toMatchObject({
      accepted: true,
      delivery_status: "accepted_by_smtp",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/support/feedback",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer parent-access-token",
          "Content-Type": "application/json",
        }),
      }),
    );
    const requestOptions = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestOptions.body)) as Record<
      string,
      unknown
    >;
    expect(body).toEqual(request);
    expect(body).not.toHaveProperty("recipient");
  });

  it("maps a temporary SMTP failure without reporting success", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: "SMTP credentials missing" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      createSupportService().submitFeedback(request),
    ).rejects.toBeInstanceOf(SupportFeedbackError);
    await expect(
      createSupportService().submitFeedback(request),
    ).rejects.toMatchObject({
      status: 503,
      message:
        "Hệ thống email hỗ trợ đang tạm thời không khả dụng. Ba mẹ có thể thử gửi lại sau.",
    });
  });

  it("does not call the API when there is no authenticated session", async () => {
    getSessionMock.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    await expect(
      createSupportService().submitFeedback(request),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
