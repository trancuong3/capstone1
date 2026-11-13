"use client";

import { useMemo, useSyncExternalStore } from "react";

export interface AdminBookAiReviewRecord {
  readonly pageId: string;
  readonly pageRevisionId: string;
  readonly pageNumber: number;
  readonly outcome: "reviewed" | "failed";
}

const changeEventName = "viread:admin-book-ai-review-history-changed";

function storageKey(bookId: string) {
  return `viread:admin-book-ai-review-history:${bookId}`;
}

function readSnapshot(bookId: string): string {
  if (typeof window === "undefined") return "[]";
  try {
    return window.localStorage.getItem(storageKey(bookId)) ?? "[]";
  } catch {
    return "[]";
  }
}

function subscribe(bookId: string, onChange: () => void) {
  const key = storageKey(bookId);
  const onStorage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changeEventName, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changeEventName, onChange);
  };
}

function parseRecords(snapshot: string): readonly AdminBookAiReviewRecord[] {
  try {
    const value: unknown = JSON.parse(snapshot);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (record): record is AdminBookAiReviewRecord =>
        typeof record === "object" &&
        record !== null &&
        "pageId" in record &&
        typeof record.pageId === "string" &&
        "pageRevisionId" in record &&
        typeof record.pageRevisionId === "string" &&
        "pageNumber" in record &&
        typeof record.pageNumber === "number" &&
        "outcome" in record &&
        (record.outcome === "reviewed" || record.outcome === "failed"),
    );
  } catch {
    return [];
  }
}

export function useAdminBookAiReviewHistory(bookId: string) {
  const snapshot = useSyncExternalStore(
    (onChange) => subscribe(bookId, onChange),
    () => readSnapshot(bookId),
    () => "[]",
  );

  return useMemo(() => parseRecords(snapshot), [snapshot]);
}

export function recordAdminBookAiReview(
  bookId: string,
  record: AdminBookAiReviewRecord,
) {
  if (typeof window === "undefined") return;

  const key = storageKey(bookId);
  const records = parseRecords(readSnapshot(bookId));
  const nextRecords = [
    ...records.filter(
      (existing) => existing.pageRevisionId !== record.pageRevisionId,
    ),
    record,
  ];

  try {
    window.localStorage.setItem(key, JSON.stringify(nextRecords));
    window.dispatchEvent(new Event(changeEventName));
  } catch {
    // Keep the current review usable when browser storage is unavailable.
  }
}
