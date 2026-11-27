"use client";

import { useMemo, useSyncExternalStore } from "react";

import { useOptionalAiTaskCenter } from "@/components/tasks/ai-task-center-provider";

const eventName = "viread-ai-batch-skipped";

function storageKey(bookId: string, actorId?: string | null) {
  const normalizedActor =
    typeof actorId === "string" && actorId.trim().length > 0
      ? actorId.trim()
      : "anon";
  return `viread:ai-batch-skipped:${normalizedActor}:${bookId}`;
}

export function useSkippedAiPageIds(
  bookId: string,
  actorId?: string | null,
): ReadonlySet<string> {
  const taskCenter = useOptionalAiTaskCenter();
  const key = storageKey(bookId, actorId ?? taskCenter?.actorId ?? null);
  const serialized = useSyncExternalStore(
    (onStoreChange) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key === key || event.key === null) onStoreChange();
      };
      const onLocalChange = (event: Event) => {
        if ((event as CustomEvent<string>).detail === key) onStoreChange();
      };
      window.addEventListener("storage", onStorage);
      window.addEventListener(eventName, onLocalChange);
      return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(eventName, onLocalChange);
      };
    },
    () => {
      try {
        return window.localStorage.getItem(key) ?? "[]";
      } catch {
        return "[]";
      }
    },
    () => "[]",
  );

  return useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(serialized);
      return new Set(
        Array.isArray(parsed) &&
          parsed.every((value): value is string => typeof value === "string")
          ? parsed
          : [],
      );
    } catch {
      return new Set<string>();
    }
  }, [serialized]);
}

export function markAiPageRevisionSkipped(
  bookId: string,
  pageRevisionId: string,
  actorId?: string | null,
) {
  const key = storageKey(bookId, actorId);
  try {
    const saved = window.localStorage.getItem(key) ?? "[]";
    const parsed: unknown = JSON.parse(saved);
    const ids = new Set(
      Array.isArray(parsed) &&
        parsed.every((value): value is string => typeof value === "string")
        ? parsed
        : [],
    );
    ids.add(pageRevisionId);
    window.localStorage.setItem(key, JSON.stringify([...ids]));
    window.dispatchEvent(new CustomEvent(eventName, { detail: key }));
  } catch {
    // The current run can continue even if browser storage is unavailable.
  }
}
