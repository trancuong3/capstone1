import type { ChildService } from "@/lib/api/child-service";
import { ServiceError } from "@/lib/api/service-error";
import type { MockAppStore } from "@/lib/mock/mock-app-store";
import {
  isChildGrade,
  type ChildProfileCreateDTO,
  type ChildProfileDTO,
  type ChildProfilePatchDTO,
} from "@/types/child";
import type { AppMockScenario } from "@/types/ui-state";

const MOCK_DELAY_MS = 350;

const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

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

function cloneChild(child: ChildProfileDTO): ChildProfileDTO {
  return {
    ...child,
    settings: { ...child.settings },
  };
}

function notFoundError(): ServiceError {
  return new ServiceError({
    code: "RESOURCE_NOT_FOUND",
    message: "Không tìm thấy hồ sơ bé.",
    status: 404,
    request_id: "mock-child-not-found",
    retryable: false,
  });
}

function validationError(): ServiceError {
  return new ServiceError({
    code: "VALIDATION_ERROR",
    message: "Dữ liệu hồ sơ bé không hợp lệ.",
    status: 422,
    request_id: "mock-child-validation",
    retryable: false,
  });
}

function isValidAlias(alias: string): boolean {
  return alias.trim().length > 0;
}

function validateCreate(request: ChildProfileCreateDTO): void {
  if (!isValidAlias(request.alias) || !isChildGrade(request.grade)) {
    throw validationError();
  }
}

function validatePatch(request: ChildProfilePatchDTO): void {
  if (request.alias !== undefined && !isValidAlias(request.alias)) {
    throw validationError();
  }

  if (request.grade !== undefined && !isChildGrade(request.grade)) {
    throw validationError();
  }
}

function mapChild(data: any): ChildProfileDTO {
  return {
    id: data.id ?? data.Id,
    parent_id: data.parent_id ?? data.ParentId,
    alias: data.alias ?? data.Alias,
    grade: data.grade ?? data.Grade,
    settings: data.settings ?? data.Settings ?? {},
    created_at: data.created_at ?? data.CreatedAt,
  };
}

export function createMockChildService(
  store: MockAppStore,
  scenario: AppMockScenario,
): ChildService {
  return {
    async list(): Promise<ChildProfileDTO[]> {
      if (scenario === "loading") {
        return waitForever<ChildProfileDTO[]>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock child service is unavailable.");
      }

      if (scenario === "empty") {
        return [];
      }

      try {
        const response = await fetch(
          `${API_URL}/profiles/children?parent_id=${encodeURIComponent(
            store.currentParentId,
          )}`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
          },
        );

        if (!response.ok) {
          if (response.status === 404) {
            throw notFoundError();
          }

          const errorData = await response.json().catch(() => null);

          if (response.status === 422) {
            throw validationError();
          }

          throw new Error(
            errorData?.detail ?? "Không thể lấy danh sách hồ sơ bé.",
          );
        }

        const data = await response.json();

        return data.map(mapChild).map(cloneChild);
      } catch (error) {
        if (error instanceof ServiceError) {
          throw error;
        }

        throw error;
      }
    },

    async create(request): Promise<ChildProfileDTO> {
      if (scenario === "loading") {
        return waitForever<ChildProfileDTO>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock child service is unavailable.");
      }

      validateCreate(request);

      try {
        const response = await fetch(
          `${API_URL}/profiles/children`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              ParentId: store.currentParentId,
              Alias: request.alias.trim(),
              Grade: request.grade,
              Settings: request.settings ?? {},
            }),
          },
        );

        if (!response.ok) {
          if (response.status === 404) {
            throw notFoundError();
          }

          if (response.status === 422) {
            throw validationError();
          }

          const errorData = await response.json().catch(() => null);

          throw new Error(
            errorData?.detail ?? "Không thể tạo hồ sơ bé.",
          );
        }

        const data = await response.json();

        return cloneChild(mapChild(data));
      } catch (error) {
        if (error instanceof ServiceError) {
          throw error;
        }

        throw error;
      }
    },

    async get(childId): Promise<ChildProfileDTO> {
      if (scenario === "loading") {
        return waitForever<ChildProfileDTO>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock child service is unavailable.");
      }

      if (scenario === "not-found") {
        throw notFoundError();
      }

      try {
        const response = await fetch(
          `${API_URL}/profiles/children/${childId}`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
          },
        );

        if (!response.ok) {
          if (response.status === 404) {
            throw notFoundError();
          }

          const errorData = await response.json().catch(() => null);

          throw new Error(
            errorData?.detail ?? "Không thể lấy hồ sơ bé.",
          );
        }

        const data = await response.json();

        return cloneChild(mapChild(data));
      } catch (error) {
        if (error instanceof ServiceError) {
          throw error;
        }

        throw error;
      }
    },

    async update(childId, request): Promise<ChildProfileDTO> {
      if (scenario === "loading") {
        return waitForever<ChildProfileDTO>();
      }

      await waitForMock();

      if (scenario === "error") {
        throw new Error("The mock child service is unavailable.");
      }

      if (scenario === "not-found") {
        throw notFoundError();
      }

      validatePatch(request);

      try {
        const response = await fetch(
          `${API_URL}/profiles/children/${childId}`,
          {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              alias: request.alias,
              grade: request.grade,
              settings: request.settings,
            }),
          },
        );

        if (!response.ok) {
          if (response.status === 404) {
            throw notFoundError();
          }

          if (response.status === 422) {
            throw validationError();
          }

          const errorData = await response.json().catch(() => null);

          throw new Error(
            errorData?.detail ?? "Không thể cập nhật hồ sơ bé.",
          );
        }

        const data = await response.json();

        return cloneChild(mapChild(data));
      } catch (error) {
        if (error instanceof ServiceError) {
          throw error;
        }

        throw error;
      }
    },
  };
}
