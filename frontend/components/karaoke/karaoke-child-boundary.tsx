"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import type { ChildProfileDTO } from "@/types/child";

export function KaraokeChildBoundary({
  children,
}: {
  children: (child: ChildProfileDTO) => ReactNode;
}) {
  const auth = useAuthRuntime();
  const { replace } = useRouter();
  // INITIAL_SESSION can arrive after the SDK initialization promise resolves.
  const restoring =
    auth.status === "initializing" ||
    (auth.status === "ready" && auth.lastEvent === null && !auth.session);
  const signedOut =
    auth.status === "ready" &&
    !restoring &&
    (!auth.session || auth.isPasswordRecovery);
  useEffect(() => {
    if (signedOut) replace("/login");
  }, [signedOut, replace]);
  if (restoring) return <p role="status">Đang kiểm tra phiên đăng nhập…</p>;
  if (auth.status === "error" || signedOut)
    return (
      <StatusMessage tone="warning">
        Ba mẹ vui lòng đăng nhập lại để mở Hát vui.
        <ButtonLink className="mt-3 sm:w-auto" href="/login">
          Đăng nhập lại
        </ButtonLink>
      </StatusMessage>
    );
  // Account/child changes unmount the player before any new ownership request resolves.
  return (
    <ValidatedChild key={auth.session!.user.id}>{children}</ValidatedChild>
  );
}
function ValidatedChild({
  children,
}: {
  children: (child: ChildProfileDTO) => ReactNode;
}) {
  const { state, retry } = useValidatedSelectedChild();
  if (state.status === "loading" || state.status === "redirecting")
    return <p role="status">Đang kiểm tra hồ sơ bé…</p>;
  if (state.status === "error")
    return (
      <StatusMessage tone="error">
        Chưa tải được hồ sơ bé.
        <Button className="mt-3 sm:w-auto" variant="secondary" onClick={retry}>
          Thử lại hồ sơ
        </Button>
      </StatusMessage>
    );
  return children(state.child);
}
