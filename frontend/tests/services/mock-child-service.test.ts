import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChildService } from "@/lib/api/child-service";
import { ServiceError } from "@/lib/api/service-error";
import {
  apiFetchFixture,
  installApiFetchFixture,
  requestedApiUrl,
} from "@/test/fixtures/api-test-fixture";
import {
  childFixture,
  TEST_CHILD_ID,
  TEST_FOREIGN_CHILD_ID,
} from "@/test/fixtures/report-data-fixture";

vi.mock("@/lib/supabase/client", () => ({
  createBrowserSupabaseClient: () => ({
    auth: {
      getSession: async () => ({
        data: { session: { access_token: "isolated-test-token" } },
        error: null,
      }),
    },
  }),
}));
vi.mock("@/lib/supabase/config", () => ({
  getApiBaseUrl: () => "http://127.0.0.1:8000",
}));
beforeEach(() => installApiFetchFixture());
afterEach(() => vi.unstubAllGlobals());

describe("ChildService real HTTP boundary (ownership is enforced by backend)", () => {
  it("requests the authenticated parent's child list with a bearer session", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json([childFixture]));
    expect(await createChildService().list()).toEqual([childFixture]);
    expect(requestedApiUrl().pathname).toBe("/profiles/children");
    const init = apiFetchFixture.mock.calls[0][1];
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer isolated-test-token",
    );
  });

  it("never forwards parent_id or role from registration input", async () => {
    apiFetchFixture.mockResolvedValueOnce(Response.json(childFixture));
    const input = {
      alias: childFixture.alias,
      grade: childFixture.grade,
      parent_id: TEST_FOREIGN_CHILD_ID,
      role: "admin",
    };
    expect(await createChildService().create(input)).toEqual(childFixture);
    const init = apiFetchFixture.mock.calls[0][1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      alias: childFixture.alias,
      grade: childFixture.grade,
    });
  });

  it("forwards only allowed update fields and preserves the stored child ID", async () => {
    apiFetchFixture.mockResolvedValueOnce(
      Response.json({ ...childFixture, alias: "Tên mới" }),
    );
    await createChildService().update(TEST_CHILD_ID, {
      alias: "Tên mới",
      grade: 3,
    });
    expect(requestedApiUrl().pathname).toBe(
      `/profiles/children/${TEST_CHILD_ID}`,
    );
    expect(apiFetchFixture.mock.calls[0][1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify({ alias: "Tên mới", grade: 3 }),
    });
  });

  it.each([TEST_FOREIGN_CHILD_ID, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"])(
    "maps backend 404 consistently for inaccessible id %s",
    async (childId) => {
      apiFetchFixture.mockImplementation(async () =>
        Response.json({ message: "Resource not found" }, { status: 404 }),
      );
      const service = createChildService();
      await expect(service.get(childId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        status: 404,
        retryable: false,
      });
      await expect(
        service.update(childId, { alias: "Không được phép", grade: 2 }),
      ).rejects.toBeInstanceOf(ServiceError);
      expect(apiFetchFixture.mock.calls).toHaveLength(2);
      expect(requestedApiUrl(1).pathname).toBe(`/profiles/children/${childId}`);
    },
  );

  it("handles a successful delete with no response body", async () => {
    apiFetchFixture.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      createChildService().delete(TEST_CHILD_ID),
    ).resolves.toBeUndefined();
    expect(apiFetchFixture.mock.calls[0][1]?.method).toBe("DELETE");
  });
});
