"use client";

import { useRouter } from "next/navigation";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { AuthRuntimeContext } from "@/components/auth/auth-service-provider";
import { useAppStore } from "@/components/providers/app-store-provider";
import { useChildService } from "@/hooks/use-child-service";
import { isServiceError } from "@/lib/api/service-error";
import {
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

export function useValidatedSelectedChild() {
  const { replace } = useRouter();
  const childService = useChildService();
  const authRuntime = useContext(AuthRuntimeContext);
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

  const immediateChild = useMemo<ChildProfileDTO | null>(() => {
    if (!selectedChildId) return null;
    if (validatedSelectedChild?.id === selectedChildId) {
      return validatedSelectedChild;
    }
    return findCachedChild(userId, selectedChildId);
  }, [selectedChildId, userId, validatedSelectedChild]);
  const immediateChildRef = useRef<ChildProfileDTO | null>(immediateChild);
  useEffect(() => {
    immediateChildRef.current = immediateChild;
  }, [immediateChild]);

  useEffect(() => {
    let active = true;

    if (!selectedChildId) {
      if (typeof window !== "undefined") {
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

    const requestChildId = selectedChildId;
    const hadImmediateChild = Boolean(immediateChildRef.current);

    void childService
      .get(selectedChildId)
      .then((child) => {
        if (!active) return;
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
        if (!active) return;
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
  ]);

  const visibleState = useMemo<ChildLoadState>(() => {
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
  }, [immediateChild, selectedChildId, state]);

  return {
    state: visibleState,
    selectedChildId,
    retry: () => setRetryKey((key) => key + 1),
  };
}
