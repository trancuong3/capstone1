"use client";

import { useMemo, useSyncExternalStore } from "react";

const eventName = "viread-ai-batch-skipped";

function storageKey(bookId: string) {
  return `viread:ai-batch-skipped:${bookId}`;
}

export function useSkippedAiPageIds(bookId: string): ReadonlySet<string> {
  const key = storageKey(bookId);
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
) {
  const key = storageKey(bookId);
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
