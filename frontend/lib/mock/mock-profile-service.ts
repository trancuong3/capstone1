import type { ProfileService } from "@/lib/api/profile-service";
import { ServiceError } from "@/lib/api/service-error";
import type { MockAppStore } from "@/lib/mock/mock-app-store";
import type { ParentProfileDTO } from "@/types/profile";
import type { AppMockScenario } from "@/types/ui-state";

const MOCK_DELAY_MS = 350;

function waitForMock(): Promise<void> {
  if (process.env.NODE_ENV === "test") {
    return Promise.resolve();
  }

  return new Promise((resolve) =>
    globalThis.setTimeout(resolve, MOCK_DELAY_MS),
  );
}

function waitForever<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function cloneProfile(profile: ParentProfileDTO): ParentProfileDTO {
  return { ...profile };
}

function getOwnedProfile(store: MockAppStore): ParentProfileDTO {
  const profile = store.profiles.get(store.currentParentId);

  if (!profile) {
    throw new ServiceError({
      code: "RESOURCE_NOT_FOUND",
      message: "Không tìm thấy hồ sơ ba mẹ.",
      status: 404,
      request_id: "mock-profile-not-found",
      retryable: false,
    });
  }

  return profile;
}

export function createMockProfileService(
  store: MockAppStore,
  scenario: AppMockScenario,
): ProfileService {
  return {
    async get(): Promise<ParentProfileDTO> {
      if (scenario === "loading") {
        return waitForever<ParentProfileDTO>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock profile service is unavailable.");
      }

      return cloneProfile(getOwnedProfile(store));
    },

    async update(request): Promise<ParentProfileDTO> {
      if (scenario === "loading") {
        return waitForever<ParentProfileDTO>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock profile service is unavailable.");
      }

      const current = getOwnedProfile(store);
      const updated: ParentProfileDTO = {
        ...current,
        display_name: request.display_name,
      };

      store.profiles.set(updated.id, updated);
      return cloneProfile(updated);
    },
  };
}
