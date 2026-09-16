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
  return { ...child, settings: { ...child.settings } };
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

      return [...store.children.values()]
        .filter((child) => child.parent_id === store.currentParentId)
        .map(cloneChild);
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

      return cloneChild(getOwnedChild(store, childId));
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

      const current = getOwnedChild(store, childId);
      validatePatch(request);

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
    },
  };
}
