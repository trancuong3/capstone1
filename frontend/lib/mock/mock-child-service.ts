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

function getOwnedChild(store: MockAppStore, childId: string): ChildProfileDTO {
  const child = store.children.get(childId);

  if (!child || child.parent_id !== store.currentParentId) {
    throw notFoundError();
  }

  return child;
}

function createChildId(store: MockAppStore): string {
  const suffix = String(store.nextChildSequence).padStart(12, "0");
  store.nextChildSequence += 1;
  return `dddddddd-dddd-4ddd-8ddd-${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapChild(data: unknown): ChildProfileDTO {
  if (!isRecord(data)) {
    throw new Error("Phản hồi hồ sơ bé không hợp lệ.");
  }

  const id = data.id ?? data.Id;
  const parentId = data.parent_id ?? data.ParentId;
  const alias = data.alias ?? data.Alias;
  const grade = data.grade ?? data.Grade;
  const settings = data.settings ?? data.Settings ?? {};
  const createdAt = data.created_at ?? data.CreatedAt;

  if (
    typeof id !== "string" ||
    typeof parentId !== "string" ||
    typeof alias !== "string" ||
    typeof grade !== "number" ||
    !isRecord(settings) ||
    typeof createdAt !== "string"
  ) {
    throw new Error("Phản hồi hồ sơ bé không hợp lệ.");
  }

  return {
    id,
    parent_id: parentId,
    alias,
    grade,
    settings,
    created_at: createdAt,
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

      if (!API_URL) {
        return [...store.children.values()]
          .filter((child) => child.parent_id === store.currentParentId)
          .map(cloneChild);
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

      if (!API_URL) {
        const child: ChildProfileDTO = {
          id: createChildId(store),
          parent_id: store.currentParentId,
          alias: request.alias.trim(),
          grade: request.grade,
          settings: { ...(request.settings ?? {}) },
          created_at: new Date().toISOString(),
        };

        store.children.set(child.id, child);
        return cloneChild(child);
      }

      try {
        const response = await fetch(`${API_URL}/profiles/children`, {
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
        });

        if (!response.ok) {
          if (response.status === 404) {
            throw notFoundError();
          }

          if (response.status === 422) {
            throw validationError();
          }

          const errorData = await response.json().catch(() => null);

          throw new Error(errorData?.detail ?? "Không thể tạo hồ sơ bé.");
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

      if (!API_URL) {
        return cloneChild(getOwnedChild(store, childId));
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

          throw new Error(errorData?.detail ?? "Không thể lấy hồ sơ bé.");
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

      if (!API_URL) {
        const current = getOwnedChild(store, childId);
        const updated: ChildProfileDTO = {
          ...current,
          alias:
            request.alias === undefined ? current.alias : request.alias.trim(),
          grade: request.grade ?? current.grade,
          settings:
            request.settings === undefined
              ? current.settings
              : { ...request.settings },
        };

        store.children.set(updated.id, updated);
        return cloneChild(updated);
      }

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

          throw new Error(errorData?.detail ?? "Không thể cập nhật hồ sơ bé.");
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
