"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "@/components/providers/app-store-provider";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useChildService } from "@/hooks/use-child-service";
import { isServiceError } from "@/lib/api/service-error";
import type { ChildProfileDTO } from "@/types/child";

type ChildLoadState =
  | { status: "loading"; childId: string | null }
  | { status: "ready"; childId: string; child: ChildProfileDTO }
  | { status: "redirecting"; childId: null }
  | { status: "error"; childId: string };

export function useValidatedSelectedChild() {
  const { replace } = useRouter();
  const authRuntime = useAuthRuntime();
  const childService = useChildService();
  const {
    selectedChildId,
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
    void childService
      .get(selectedChildId)
      .then((child) => {
        if (!active || requestEpoch !== requestEpochRef.current) return;
        if (child.id !== requestChildId) {
          clearSelectedChild();
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
          setState({ status: "redirecting", childId: null });
          replace("/dashboard?focus=child-selection&reason=invalid");
          return;
        }
        setState({ status: "error", childId: requestChildId });
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
    waitingForAuthInit,
  ]);

  const visibleState = useMemo<ChildLoadState>(
    () =>
      waitingForAuthInit
        ? { status: "loading", childId: selectedChildId }
        : selectedChildId
          ? state.childId === selectedChildId
            ? state
            : { status: "loading", childId: selectedChildId }
          : { status: "redirecting", childId: null },
    [selectedChildId, state, waitingForAuthInit],
  );

  return {
    state: visibleState,
    selectedChildId,
    retry: () => setRetryKey((key) => key + 1),
  };
}
