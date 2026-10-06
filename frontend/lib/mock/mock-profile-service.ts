import type { ProfileService } from "@/lib/api/profile-service";
import { ServiceError } from "@/lib/api/service-error";
import type { MockAppStore } from "@/lib/mock/mock-app-store";
import type { ParentProfileDTO } from "@/types/profile";
import type { AppMockScenario } from "@/types/ui-state";

const MOCK_DELAY_MS = 350;

const API_URL =
  process.env.NODE_ENV === "test"
    ? undefined
    : process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");

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

      if (!API_URL) {
        return cloneProfile(getOwnedProfile(store));
      }

      try {
        const response = await fetch(
          `${API_URL}/profiles/${store.currentParentId}`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
          },
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => null);

          throw new ServiceError({
            code: errorData?.code ?? "PROFILE_API_ERROR",
            message:
              errorData?.message ??
              errorData?.detail ??
              "Không thể lấy thông tin hồ sơ ba mẹ.",
            status: response.status,
            request_id: errorData?.request_id ?? "profile-get-error",
            retryable: response.status >= 500,
          });
        }

        const data = await response.json();

        return {
          id: data.id ?? data.Id,
          display_name: data.display_name ?? data.DisplayName,
          role: data.role ?? data.Role,
          created_at: data.created_at ?? data.CreatedAt,
        };
      } catch (error) {
        if (error instanceof ServiceError) {
          throw error;
        }

        throw new ServiceError({
          code: "NETWORK_ERROR",
          message: "Không thể kết nối đến Backend.",
          status: 0,
          request_id: "profile-network-error",
          retryable: true,
        });
      }
    },

    async update(request): Promise<ParentProfileDTO> {
      if (scenario === "loading") {
        return waitForever<ParentProfileDTO>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock profile service is unavailable.");
      }

      if (!API_URL) {
        const current = getOwnedProfile(store);
        const updated: ParentProfileDTO = {
          ...current,
          display_name: request.display_name,
        };

        store.profiles.set(updated.id, updated);
        return cloneProfile(updated);
      }

      try {
        const response = await fetch(
          `${API_URL}/profiles/${store.currentParentId}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              DisplayName: request.display_name,
            }),
          },
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => null);

          throw new ServiceError({
            code: errorData?.code ?? "PROFILE_API_ERROR",
            message:
              errorData?.message ??
              errorData?.detail ??
              "Không thể cập nhật hồ sơ ba mẹ.",
            status: response.status,
            request_id: errorData?.request_id ?? "profile-update-error",
            retryable: response.status >= 500,
          });
        }

        const data = await response.json();

        return {
          id: data.id ?? data.Id,
          display_name: data.display_name ?? data.DisplayName,
          role: data.role ?? data.Role,
          created_at: data.created_at ?? data.CreatedAt,
        };
      } catch (error) {
        if (error instanceof ServiceError) {
          throw error;
        }

        throw new ServiceError({
          code: "NETWORK_ERROR",
          message: "Không thể kết nối đến Backend.",
          status: 0,
          request_id: "profile-network-error",
          retryable: true,
        });
      }
    },
  };
}
