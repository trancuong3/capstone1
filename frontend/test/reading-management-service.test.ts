import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReadingManagementService } from "@/lib/api/reading-management-service";
import { requestApi } from "@/lib/api/api-client";

vi.mock("@/lib/api/api-client", () => ({
  apiQuery: (values: Record<string, string | number | undefined>) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(values))
      if (value !== undefined) query.set(key, String(value));
    return query.size ? "?" + query.toString() : "";
  },
  requestApi: vi.fn(),
}));

describe("ReadingManagementService HTTP contracts", () => {
  beforeEach(() => vi.clearAllMocks());
  it("loads goals for the selected child", async () => {
    vi.mocked(requestApi).mockResolvedValueOnce([]);
    await createReadingManagementService().listGoals(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(requestApi).toHaveBeenCalledWith(
      "/reading-management/goals?child_id=00000000-0000-4000-8000-000000000001",
      expect.anything(),
      undefined,
    );
  });
  it("sends a delete request to backend for a reminder", async () => {
    vi.mocked(requestApi).mockResolvedValueOnce({ deleted: true });
    await createReadingManagementService().deleteReminder(
      "00000000-0000-4000-8000-000000000002",
    );
    expect(requestApi).toHaveBeenCalledWith(
      "/reading-management/reminders/00000000-0000-4000-8000-000000000002",
      expect.anything(),
      undefined,
      { method: "DELETE" },
    );
  });
});
