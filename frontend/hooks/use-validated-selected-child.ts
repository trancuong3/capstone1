"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "@/components/providers/app-store-provider";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useChildService } from "@/hooks/use-child-service";
import { isServiceError } from "@/lib/api/service-error";
import {
  DEFAULT_USER_CACHE_TTL_MS,
  invalidateUserCacheKey,
  readUserCacheWithStale,
} from "@/lib/cache/user-query-cache";
import type { ChildProfileDTO } from "@/types/child";
import type { DashboardSummaryDTO } from "@/types/profile";

type ChildLoadState =
  | { status: "loading"; childId: string | null }
  | { status: "ready"; childId: string; child: ChildProfileDTO }
  | { status: "redirecting"; childId: null }
  | { status: "error"; childId: string };

function findCachedChild(
  userId: string | null | undefined,
  childId: string,
): ChildProfileDTO | null {
  if (!userId || !childId) return null;

  const summary = readUserCacheWithStale<DashboardSummaryDTO>(
    userId,
    "dashboard-summary",
  );
  const fromSummary = summary?.data.children.find(
    (candidate) => candidate.id === childId,
  );
  if (fromSummary) return fromSummary;

  const children = readUserCacheWithStale<ChildProfileDTO[]>(
    userId,
    "children",
  );
  return children?.data.find((candidate) => candidate.id === childId) ?? null;
}

function findFreshCachedChild(
  userId: string | null | undefined,
  childId: string,
): ChildProfileDTO | null {
  if (!userId || !childId) return null;

  const summary = readUserCacheWithStale<DashboardSummaryDTO>(
    userId,
    "dashboard-summary",
    DEFAULT_USER_CACHE_TTL_MS,
  );
  if (summary && !summary.isStale) {
    const fromSummary = summary.data.children.find(
      (candidate) => candidate.id === childId,
    );
    if (fromSummary) return fromSummary;
  }

  const children = readUserCacheWithStale<ChildProfileDTO[]>(
    userId,
    "children",
    DEFAULT_USER_CACHE_TTL_MS,
  );
  if (children && !children.isStale) {
    return children.data.find((candidate) => candidate.id === childId) ?? null;
  }

  return null;
}

export function useValidatedSelectedChild() {
  const { replace } = useRouter();
  const authRuntime = useAuthRuntime();
  const childService = useChildService();
  const userId = authRuntime?.session?.user?.id ?? null;
  const {
    selectedChildId,
    validatedSelectedChild,
    selectChild,
    clearSelectedChild,
    setValidatedSelectedChild,
  } = useAppStore();
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<ChildLoadState>({
    status: "loading",
    childId: null,
  });
  const requestEpochRef = useRef(0);
  const consumedQueryChildRef = useRef(false);
  const waitingForAuthInit =
    Boolean(authRuntime.hasProvider) && authRuntime.status === "initializing";

  const immediateChild = useMemo<ChildProfileDTO | null>(() => {
    if (!selectedChildId) return null;
    if (validatedSelectedChild?.id === selectedChildId) {
      return validatedSelectedChild;
    }
    return findCachedChild(userId, selectedChildId);
  }, [selectedChildId, userId, validatedSelectedChild]);
  const immediateChildRef = useRef<ChildProfileDTO | null>(immediateChild);
  const validatedSelectedChildRef = useRef<ChildProfileDTO | null>(
    validatedSelectedChild,
  );
  useEffect(() => {
    immediateChildRef.current = immediateChild;
    validatedSelectedChildRef.current = validatedSelectedChild;
  }, [immediateChild, validatedSelectedChild]);

  useEffect(() => {
    if (waitingForAuthInit) {
      return;
    }

    let active = true;
    const requestEpoch = ++requestEpochRef.current;

    if (!selectedChildId) {
      if (!consumedQueryChildRef.current && typeof window !== "undefined") {
        consumedQueryChildRef.current = true;
        const queryChildId = new URLSearchParams(window.location.search)
          .get("childId")
          ?.trim();
        if (queryChildId) {
          selectChild(queryChildId);
          return () => {
            active = false;
          };
        }
      }
      replace("/dashboard?focus=child-selection&reason=missing");
      return () => {
        active = false;
      };
    }

    consumedQueryChildRef.current = true;
    const requestChildId = selectedChildId;
    const freshCachedChild =
      retryKey === 0 ? findFreshCachedChild(userId, requestChildId) : null;
    if (freshCachedChild) {
      if (validatedSelectedChildRef.current?.id !== freshCachedChild.id) {
        setValidatedSelectedChild(freshCachedChild);
      }
      return () => {
        active = false;
      };
    }

    const hadImmediateChild = Boolean(immediateChildRef.current);

    void childService
      .get(selectedChildId)
      .then((child) => {
        if (!active || requestEpoch !== requestEpochRef.current) return;
        if (child.id !== requestChildId) {
          clearSelectedChild();
          invalidateUserCacheKey(userId, "dashboard-summary");
          invalidateUserCacheKey(userId, "children");
          setState({ status: "redirecting", childId: null });
          replace("/dashboard?focus=child-selection&reason=invalid");
          return;
        }
        setValidatedSelectedChild(child);
        setState({ status: "ready", childId: requestChildId, child });
      })
      .catch((error: unknown) => {
        if (!active || requestEpoch !== requestEpochRef.current) return;
        if (
          isServiceError(error) &&
          ["AUTH_REQUIRED", "FORBIDDEN", "RESOURCE_NOT_FOUND"].includes(
            error.code,
          )
        ) {
          clearSelectedChild();
          invalidateUserCacheKey(userId, "dashboard-summary");
          invalidateUserCacheKey(userId, "children");
          setState({ status: "redirecting", childId: null });
          replace("/dashboard?focus=child-selection&reason=invalid");
          return;
        }
        if (!hadImmediateChild) {
          setState({ status: "error", childId: requestChildId });
        }
      });

    return () => {
      active = false;
    };
  }, [
    childService,
    clearSelectedChild,
    retryKey,
    replace,
    selectChild,
    selectedChildId,
    setValidatedSelectedChild,
    userId,
    waitingForAuthInit,
  ]);

  const visibleState = useMemo<ChildLoadState>(() => {
    if (waitingForAuthInit) {
      return { status: "loading", childId: selectedChildId };
    }
    if (!selectedChildId) {
      return { status: "redirecting", childId: null };
    }
    if (state.status === "redirecting") {
      return state;
    }
    if (state.childId === selectedChildId && state.status === "ready") {
      return state;
    }
    if (immediateChild) {
      return {
        status: "ready",
        childId: selectedChildId,
        child: immediateChild,
      };
    }
    if (state.childId === selectedChildId) {
      return state;
    }
    return { status: "loading", childId: selectedChildId };
  }, [immediateChild, selectedChildId, state, waitingForAuthInit]);

  return {
    state: visibleState,
    selectedChildId,
    retry: () => setRetryKey((key) => key + 1),
  };
}
