import { describe, expect, it } from "vitest";

import { ServiceError } from "@/lib/api/service-error";
import {
  createMockAppStore,
  MOCK_CURRENT_PARENT_ID,
  MOCK_FOREIGN_CHILD_ID,
} from "@/lib/mock/mock-app-store";
import { createMockChildService } from "@/lib/mock/mock-child-service";

describe("mock ChildService ownership boundary", () => {
  it("lists only children owned by the authenticated parent", async () => {
    const service = createMockChildService(createMockAppStore(), "default");

    const children = await service.list();

    expect(children).toHaveLength(2);
    expect(
      children.every((child) => child.parent_id === MOCK_CURRENT_PARENT_ID),
    ).toBe(true);
    expect(children.some((child) => child.id === MOCK_FOREIGN_CHILD_ID)).toBe(
      false,
    );
  });

  it("derives parent_id instead of accepting it in create input", async () => {
    const service = createMockChildService(createMockAppStore(), "default");

    const child = await service.create({ alias: "Bé Na", grade: 3 });

    expect(child.parent_id).toBe(MOCK_CURRENT_PARENT_ID);
    expect(child).toMatchObject({ alias: "Bé Na", grade: 3, settings: {} });
  });

  it.each([MOCK_FOREIGN_CHILD_ID, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"])(
    "returns the same RESOURCE_NOT_FOUND response for inaccessible id %s",
    async (childId) => {
      const service = createMockChildService(createMockAppStore(), "default");

      await expect(service.get(childId)).rejects.toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        status: 404,
        retryable: false,
      });

      const updateError: unknown = await service
        .update(childId, { alias: "Không được phép" })
        .catch((error: unknown) => error);
      expect(updateError).toBeInstanceOf(ServiceError);
      expect(updateError).toMatchObject({
        code: "RESOURCE_NOT_FOUND",
        status: 404,
      });
    },
  );
});
