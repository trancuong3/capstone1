import type { AdminPageService } from "@/lib/api/admin-page-service";
import {
  createGlobalTasksService,
  emitStudioTasksChanged,
  type GlobalTasksService,
} from "@/lib/api/global-tasks-service";
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

function notify(bookId: string) {
  listeners.get(bookId)?.forEach((listener) => listener());
}

function updateSession(
  bookId: string,
  update: (current: AdminBookUploadSession) => AdminBookUploadSession,
) {
  sessions.set(
    bookId,
    update(sessions.get(bookId) ?? emptyAdminBookUploadSession),
  );
  notify(bookId);
}

export function getAdminBookUploadSession(bookId: string) {
  return sessions.get(bookId) ?? emptyAdminBookUploadSession;
}

export function clearAdminBookUploadSessionForTests(bookId?: string): void {
  if (bookId) {
    sessions.delete(bookId);
    entriesByBook.delete(bookId);
    notify(bookId);
    return;
  }
  sessions.clear();
  entriesByBook.clear();
}

export function hasRetryableAdminBookUploads(bookId: string) {
  const fileEntries = entriesByBook.get(bookId);
  return getAdminBookUploadSession(bookId).progress.some(
    (item) => item.status === "FAILED" && fileEntries?.has(item.client_id),
  );
}

export function subscribeAdminBookUploadSession(
  bookId: string,
  onChange: () => void,
) {
  const bookListeners = listeners.get(bookId) ?? new Set<() => void>();
  bookListeners.add(onChange);
  listeners.set(bookId, bookListeners);
  return () => {
    bookListeners.delete(onChange);
    if (bookListeners.size === 0) listeners.delete(bookId);
  };
}

function isBookUploadOrOcrTask(task: GlobalTaskItem, bookId: string): boolean {
  if (task.book_id !== bookId) return false;
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
 * Rehydrates durable server-side upload/OCR jobs for `bookId` from `GET /studio/tasks`
 * after a page reload or route switch without clearing active in-tab progress.
 */
export async function rehydrateAdminBookUploadTasks(
  bookId: string,
  options?: {
    readonly service?: GlobalTasksService;
    readonly signal?: AbortSignal;
  },
): Promise<readonly GlobalTaskItem[]> {
  try {
    const tasksService = options?.service ?? createGlobalTasksService();
    const feed = await tasksService.listTasks({
      activeOnly: true,
      limit: 40,
      signal: options?.signal,
    });
    if (options?.signal?.aborted) {
      return getAdminBookUploadSession(bookId).serverTasks;
    }
    const matchingTasks = feed.tasks.filter((task) =>
      isBookUploadOrOcrTask(task, bookId),
    );
    updateSession(bookId, (session) => ({
      ...session,
      serverTasks: matchingTasks,
    }));
    return matchingTasks;
  } catch {
    // Non-fatal: keep any existing session progress when /studio/tasks is offline or unmocked.
    return getAdminBookUploadSession(bookId).serverTasks;
  }
}

export async function runAdminBookUpload(
  bookId: string,
  pages: AdminPageService,
  entries: readonly AdminPageUploadInputUI[],
  initialProgress: readonly AdminPageUploadProgressUI[],
) {
  const current = getAdminBookUploadSession(bookId);
  if (current.busy) return;

  const fileEntries = entriesByBook.get(bookId) ?? new Map();
  for (const entry of entries) fileEntries.set(entry.client_id, entry);
  entriesByBook.set(bookId, fileEntries);
  const nextRunId = current.completedRunId + 1;
  updateSession(bookId, (session) => ({
    ...session,
    progress: initialProgress,
    busy: true,
    error: null,
  }));
  emitStudioTasksChanged();

  try {
    await pages.upload(bookId, entries, (item) => {
      if (item.status === "PROCESSING") fileEntries.delete(item.client_id);
      if (item.status === "PROCESSING" || item.status === "FAILED") {
        emitStudioTasksChanged();
      }
      updateSession(bookId, (session) => {
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
      });
    });
    updateSession(bookId, (session) => ({
      ...session,
      busy: false,
      completedRunId: nextRunId,
    }));
    emitStudioTasksChanged();
  } catch (cause) {
    updateSession(bookId, (session) => ({
      ...session,
      busy: false,
      error: isServiceError(cause)
        ? cause.message
        : translateRuntime("admin.pageUploadRuntime.reloadAfterUploadFailed"),
      completedRunId: nextRunId,
    }));
    emitStudioTasksChanged();
  }
}

export async function retryAdminBookUpload(
  bookId: string,
  pages: AdminPageService,
) {
  const session = getAdminBookUploadSession(bookId);
  if (session.busy) return;
  const fileEntries = entriesByBook.get(bookId);
  const failed = session.progress.flatMap((item) => {
    const entry = fileEntries?.get(item.client_id);
    return item.status === "FAILED" && entry ? [entry] : [];
  });
  if (failed.length === 0) return;
  emitStudioTasksChanged();
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
  );
}
