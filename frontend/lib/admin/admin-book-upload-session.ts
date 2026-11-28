import type { AdminPageService } from "@/lib/api/admin-page-service";
import {
  createGlobalTasksService,
  emitStudioTasksChanged,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
import { registerCacheResetListener } from "@/lib/api/read-cache";
import { isServiceError } from "@/lib/api/service-error";
import { translateRuntime } from "@/lib/i18n/runtime";
import type {
  AdminPageUploadInputUI,
  AdminPageUploadProgressUI,
} from "@/types/admin";
import {
  ACTIVE_GLOBAL_TASK_STATUSES,
  type GlobalTaskItem,
} from "@/types/global-tasks";

export interface AdminBookUploadSession {
  readonly progress: readonly AdminPageUploadProgressUI[];
  readonly serverTasks: readonly GlobalTaskItem[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly completedRunId: number;
}

export const emptyAdminBookUploadSession: AdminBookUploadSession = {
  progress: [],
  serverTasks: [],
  busy: false,
  error: null,
  completedRunId: 0,
};

const sessions = new Map<string, AdminBookUploadSession>();
const entriesByBook = new Map<string, Map<string, AdminPageUploadInputUI>>();
const listeners = new Map<string, Set<() => void>>();

function buildSessionKey(bookId: string, actorId?: string | null): string {
  const normalizedActor =
    typeof actorId === "string" && actorId.trim().length > 0
      ? actorId.trim()
      : "anon";
  return `${normalizedActor}:${bookId}`;
}

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

function updateSession(
  bookId: string,
  update: (current: AdminBookUploadSession) => AdminBookUploadSession,
  actorId?: string | null,
) {
  const key = buildSessionKey(bookId, actorId);
  sessions.set(key, update(sessions.get(key) ?? emptyAdminBookUploadSession));
  notify(key);
}

export function getAdminBookUploadSession(
  bookId: string,
  actorId?: string | null,
) {
  return (
    sessions.get(buildSessionKey(bookId, actorId)) ??
    emptyAdminBookUploadSession
  );
}

export function clearAdminBookUploadSessions(): void {
  const activeKeys = new Set<string>([
    ...sessions.keys(),
    ...entriesByBook.keys(),
    ...listeners.keys(),
  ]);
  sessions.clear();
  entriesByBook.clear();
  activeKeys.forEach((key) => notify(key));
}

registerCacheResetListener(clearAdminBookUploadSessions);

export function clearAdminBookUploadSessionForTests(
  bookId?: string,
  actorId?: string | null,
): void {
  if (bookId) {
    const key = buildSessionKey(bookId, actorId);
    sessions.delete(key);
    entriesByBook.delete(key);
    notify(key);
    return;
  }
  clearAdminBookUploadSessions();
}

export function hasRetryableAdminBookUploads(
  bookId: string,
  actorId?: string | null,
) {
  const key = buildSessionKey(bookId, actorId);
  const fileEntries = entriesByBook.get(key);
  return getAdminBookUploadSession(bookId, actorId).progress.some(
    (item) => item.status === "FAILED" && fileEntries?.has(item.client_id),
  );
}

export function subscribeAdminBookUploadSession(
  bookId: string,
  onChange: () => void,
  actorId?: string | null,
) {
  const key = buildSessionKey(bookId, actorId);
  const bookListeners = listeners.get(key) ?? new Set<() => void>();
  bookListeners.add(onChange);
  listeners.set(key, bookListeners);
  return () => {
    bookListeners.delete(onChange);
    if (bookListeners.size === 0) listeners.delete(key);
  };
}

function isBookUploadOrOcrTask(
  task: GlobalTaskItem,
  bookId: string,
  actorId?: string | null,
): boolean {
  if (task.book_id !== bookId) return false;
  if (task.actor_role !== "admin") return false;
  if (task.portal && task.portal !== "admin") return false;
  if (actorId && task.actor_id && task.actor_id !== actorId) return false;
  if (!ACTIVE_GLOBAL_TASK_STATUSES.has(task.status)) return false;
  return (
    task.source === "ocr_inference_job" ||
    task.source === "admin_ai_workflow" ||
    task.job_type === "BATCH_BOOK_IMPORT" ||
    task.job_type === "OCR_EXTRACT" ||
    task.job_type.includes("OCR") ||
    task.job_type.includes("UPLOAD") ||
    task.job_type.includes("IMPORT")
  );
}

/**
 * Rehydrates durable server-side upload/OCR jobs for `bookId` from `GET /studio/admin/tasks`
 * after a page reload or route switch without clearing active in-tab progress.
 */
export async function rehydrateAdminBookUploadTasks(
  bookId: string,
  options?: {
    readonly actorId?: string | null;
    readonly service?: GlobalTasksService;
    readonly signal?: AbortSignal;
  },
): Promise<readonly GlobalTaskItem[]> {
  const actorId = options?.actorId ?? null;
  try {
    const tasksService = options?.service ?? createGlobalTasksService();
    const feed = await tasksService.listTasks({
      portal: "admin",
      activeOnly: true,
      limit: 40,
      signal: options?.signal,
    });
    if (options?.signal?.aborted) {
      return getAdminBookUploadSession(bookId, actorId).serverTasks;
    }
    const matchingTasks = feed.tasks.filter((task) =>
      isBookUploadOrOcrTask(task, bookId, actorId),
    );
    updateSession(
      bookId,
      (session) => ({
        ...session,
        serverTasks: matchingTasks,
      }),
      actorId,
    );
    return matchingTasks;
  } catch {
    // Non-fatal: keep any existing session progress when /studio/admin/tasks is offline or unmocked.
    return getAdminBookUploadSession(bookId, actorId).serverTasks;
  }
}

export async function runAdminBookUpload(
  bookId: string,
  pages: AdminPageService,
  entries: readonly AdminPageUploadInputUI[],
  initialProgress: readonly AdminPageUploadProgressUI[],
  actorId?: string | null,
) {
  const current = getAdminBookUploadSession(bookId, actorId);
  if (current.busy) return;

  const key = buildSessionKey(bookId, actorId);
  const fileEntries = entriesByBook.get(key) ?? new Map();
  for (const entry of entries) fileEntries.set(entry.client_id, entry);
  entriesByBook.set(key, fileEntries);
  const nextRunId = current.completedRunId + 1;
  updateSession(
    bookId,
    (session) => ({
      ...session,
      progress: initialProgress,
      busy: true,
      error: null,
    }),
    actorId,
  );
  emitStudioTasksChanged({ portal: "admin", actorId: actorId ?? undefined });

  try {
    await pages.upload(bookId, entries, (item) => {
      if (item.status === "PROCESSING") fileEntries.delete(item.client_id);
      if (item.status === "PROCESSING" || item.status === "FAILED") {
        emitStudioTasksChanged({
          portal: "admin",
          actorId: actorId ?? undefined,
        });
      }
      updateSession(
        bookId,
        (session) => {
          const found = session.progress.some(
            (existing) => existing.client_id === item.client_id,
          );
          return {
            ...session,
            progress: found
              ? session.progress.map((existing) =>
                  existing.client_id === item.client_id ? item : existing,
                )
              : [...session.progress, item],
          };
        },
        actorId,
      );
    });
    updateSession(
      bookId,
      (session) => ({
        ...session,
        busy: false,
        completedRunId: nextRunId,
      }),
      actorId,
    );
    emitStudioTasksChanged({ portal: "admin", actorId: actorId ?? undefined });
  } catch (cause) {
    updateSession(
      bookId,
      (session) => ({
        ...session,
        busy: false,
        error: isServiceError(cause)
          ? cause.message
          : translateRuntime("admin.pageUploadRuntime.reloadAfterUploadFailed"),
        completedRunId: nextRunId,
      }),
      actorId,
    );
    emitStudioTasksChanged({ portal: "admin", actorId: actorId ?? undefined });
  }
}

export async function retryAdminBookUpload(
  bookId: string,
  pages: AdminPageService,
  actorId?: string | null,
) {
  const session = getAdminBookUploadSession(bookId, actorId);
  if (session.busy) return;
  const fileEntries = entriesByBook.get(buildSessionKey(bookId, actorId));
  const failed = session.progress.flatMap((item) => {
    const entry = fileEntries?.get(item.client_id);
    return item.status === "FAILED" && entry ? [entry] : [];
  });
  if (failed.length === 0) return;
  emitStudioTasksChanged({ portal: "admin", actorId: actorId ?? undefined });
  await runAdminBookUpload(
    bookId,
    pages,
    failed,
    session.progress.map((item) =>
      failed.some((entry) => entry.client_id === item.client_id)
        ? {
            ...item,
            file_name:
              item.file_name ??
              failed.find((entry) => entry.client_id === item.client_id)
                ?.file_name,
            status: "QUEUED",
            progress_percent: 0,
            error_message: undefined,
            summary_message: undefined,
          }
        : item,
    ),
    actorId,
  );
}
