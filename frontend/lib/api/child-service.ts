import { z, type ZodType } from "zod";

import { requestApi, type RequestApiOptions } from "@/lib/api/api-client";
import { ServiceError } from "@/lib/api/service-error";
import { clearUserCache } from "@/lib/cache/user-query-cache";
import { translateRuntime } from "@/lib/i18n/runtime";
import type {
  ChildProfileCreateDTO,
  ChildProfileDTO,
  ChildProfilePatchDTO,
} from "@/types/child";

export interface ChildService {
  list(): Promise<ChildProfileDTO[]>;
  create(request: ChildProfileCreateDTO): Promise<ChildProfileDTO>;
  get(childId: string): Promise<ChildProfileDTO>;
  update(
    childId: string,
    request: ChildProfilePatchDTO,
  ): Promise<ChildProfileDTO>;
  uploadAvatar(childId: string, file: File): Promise<ChildProfileDTO>;
  removeAvatar(childId: string): Promise<ChildProfileDTO>;
  delete(childId: string): Promise<void>;
}

const childProfileSchema = z.object({
  id: z.string().min(1),
  parent_id: z.string().min(1),
  alias: z.string(),
  grade: z.number().int(),
  settings: z.record(z.string(), z.unknown()).optional().default({}),
  created_at: z.string(),
  avatar_url: z.string().nullable().optional(),
});

const childProfileListSchema = z.array(childProfileSchema);
const emptyMutationSchema = z.void();

async function requestChildApi<T>(
  path: string,
  schema: ZodType<T>,
  options?: RequestApiOptions,
): Promise<T> {
  try {
    return await requestApi(path, schema, undefined, options);
  } catch (error) {
    if (
      error instanceof ServiceError &&
      error.message === translateRuntime("errors.generic")
    ) {
      throw new ServiceError({
        code: error.code,
        message:
          error.status === 401
            ? translateRuntime("errors.clientRuntime.sessionExpiredParent")
            : translateRuntime("errors.clientRuntime.genericParentRetry"),
        status: error.status,
        request_id: error.request_id,
        retryable: error.retryable,
      });
    }
    throw error;
  }
}

async function runChildMutation<T>(operation: () => Promise<T>): Promise<T> {
  clearUserCache();
  try {
    return await operation();
  } finally {
    clearUserCache();
  }
}

export function createChildService(): ChildService {
  return {
    async list(): Promise<ChildProfileDTO[]> {
      return requestChildApi("/profiles/children", childProfileListSchema);
    },

    async create(requestBody: ChildProfileCreateDTO): Promise<ChildProfileDTO> {
      const body: ChildProfileCreateDTO = {
        alias: requestBody.alias,
        grade: requestBody.grade,
      };

      if (requestBody.settings !== undefined) {
        body.settings = requestBody.settings;
      }

      return runChildMutation(() =>
        requestChildApi("/profiles/children", childProfileSchema, {
          method: "POST",
          body,
        }),
      );
    },

    async get(childId: string): Promise<ChildProfileDTO> {
      return requestChildApi(
        `/profiles/children/${encodeURIComponent(childId)}`,
        childProfileSchema,
      );
    },

    async update(
      childId: string,
      requestBody: ChildProfilePatchDTO,
    ): Promise<ChildProfileDTO> {
      return runChildMutation(() =>
        requestChildApi(
          `/profiles/children/${encodeURIComponent(childId)}`,
          childProfileSchema,
          {
            method: "PUT",
            body: {
              alias: requestBody.alias,
              grade: requestBody.grade,
            },
          },
        ),
      );
    },

    async delete(childId: string): Promise<void> {
      await runChildMutation(() =>
        requestChildApi(
          `/profiles/children/${encodeURIComponent(childId)}`,
          emptyMutationSchema,
          { method: "DELETE" },
        ),
      );
    },

    async uploadAvatar(childId: string, file: File): Promise<ChildProfileDTO> {
      const body = new FormData();
      body.append("file", file);
      return runChildMutation(() =>
        requestChildApi(
          `/profiles/children/${encodeURIComponent(childId)}/avatar`,
          childProfileSchema,
          { method: "POST", body },
        ),
      );
    },

    async removeAvatar(childId: string): Promise<ChildProfileDTO> {
      return runChildMutation(() =>
        requestChildApi(
          `/profiles/children/${encodeURIComponent(childId)}/avatar`,
          childProfileSchema,
          { method: "DELETE" },
        ),
      );
    },
  };
}
