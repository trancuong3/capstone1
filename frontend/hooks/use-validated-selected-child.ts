"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useAppStore } from "@/components/providers/app-store-provider";
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
  const childService = useChildService();
  const { selectedChildId, clearSelectedChild, setValidatedSelectedChild } =
    useAppStore();
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<ChildLoadState>({
    status: "loading",
    childId: null,
  });

  useEffect(() => {
    let active = true;

    if (!selectedChildId) {
      replace("/dashboard?focus=child-selection&reason=missing");
      return () => {
        active = false;
      };
    }

    const requestChildId = selectedChildId;
    void childService
      .get(selectedChildId)
      .then((child) => {
        if (!active) return;
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
        if (!active) return;
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
    selectedChildId,
    setValidatedSelectedChild,
  ]);

  const visibleState = useMemo<ChildLoadState>(
    () =>
      selectedChildId
        ? state.childId === selectedChildId
          ? state
          : { status: "loading", childId: selectedChildId }
        : { status: "redirecting", childId: null },
    [selectedChildId, state],
  );

  return {
    state: visibleState,
    selectedChildId,
    retry: () => setRetryKey((key) => key + 1),
  };
}
