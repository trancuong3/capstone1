import type { AdminPageService } from "@/lib/api/admin-page-service";
import { isServiceError } from "@/lib/api/service-error";
import type {
  AdminPageUploadInputUI,
  AdminPageUploadProgressUI,
} from "@/types/admin";

export interface AdminBookUploadSession {
  readonly progress: readonly AdminPageUploadProgressUI[];
  readonly busy: boolean;
  readonly error: string | null;
  readonly completedRunId: number;
}

export const emptyAdminBookUploadSession: AdminBookUploadSession = {
  progress: [],
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

  try {
    await pages.upload(bookId, entries, (item) => {
      if (item.status === "PROCESSING") fileEntries.delete(item.client_id);
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
  } catch (cause) {
    updateSession(bookId, (session) => ({
      ...session,
      busy: false,
      error: isServiceError(cause)
        ? cause.message
        : "Không thể tải lại danh sách trang sau upload. Dữ liệu có thể đã được lưu; hãy tải lại để xác minh.",
      completedRunId: nextRunId,
    }));
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
