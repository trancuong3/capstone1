"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useTranslations } from "@/hooks/use-i18n";
import { useAuthRuntime } from "@/hooks/use-auth-runtime";
import { useValidatedSelectedChild } from "@/hooks/use-validated-selected-child";
import type { ChildProfileDTO } from "@/types/child";

export function KaraokeChildBoundary({
  children,
}: {
  children: (child: ChildProfileDTO) => ReactNode;
}) {
  const t = useTranslations("entertainment");
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
  if (restoring)
    return <p role="status">{t("karaoke.boundary.checkingSession")}</p>;
  if (auth.status === "error" || signedOut)
    return (
      <StatusMessage tone="warning">
        {t("karaoke.boundary.loginRequired")}
        <ButtonLink className="mt-3 sm:w-auto" href="/login">
          {t("karaoke.boundary.reloginAction")}
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
  const t = useTranslations("entertainment");
  const { state, retry } = useValidatedSelectedChild();
  if (state.status === "loading" || state.status === "redirecting")
    return <p role="status">{t("karaoke.boundary.checkingChild")}</p>;
  if (state.status === "error")
    return (
      <StatusMessage tone="error">
        {t("karaoke.boundary.childError")}
        <Button className="mt-3 sm:w-auto" variant="secondary" onClick={retry}>
          {t("karaoke.boundary.retryChild")}
        </Button>
      </StatusMessage>
    );
  return children(state.child);
}
