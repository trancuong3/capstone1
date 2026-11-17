"use client";

import { useEffect, useState } from "react";
import { KaraokeChildBoundary } from "@/components/karaoke/karaoke-child-boundary";
import { KaraokePlayer } from "@/components/karaoke/karaoke-player";
import { useKaraokeService } from "@/components/karaoke/karaoke-services-provider";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import {
  karaokeParentErrorMessage,
  type KaraokePlayback,
} from "@/lib/api/karaoke-service";
import { isServiceError } from "@/lib/api/service-error";
import type { ChildProfileDTO } from "@/types/child";

export function KaraokePlayerScreen({
  songId,
  expectedVersionId,
}: {
  songId: string;
  expectedVersionId?: string;
}) {
  return (
    <KaraokeChildBoundary>
      {(child) => (
        <Song
          key={`${child.id}:${child.grade}:${songId}:${expectedVersionId ?? "latest"}`}
          child={child}
          songId={songId}
          expectedVersionId={expectedVersionId}
        />
      )}
    </KaraokeChildBoundary>
  );
}
function Song({
  child,
  songId,
  expectedVersionId,
}: {
  child: ChildProfileDTO;
  songId: string;
  expectedVersionId?: string;
}) {
  const [request, setRequest] = useState({
    version: expectedVersionId,
    attempt: 0,
  });
  return (
    <section className="mx-auto grid w-full max-w-[960px] gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <SelectedChildIdentity child={child} />
        <ButtonLink href="/karaoke" variant="secondary" className="sm:w-auto">
          Về thư viện bài hát
        </ButtonLink>
      </div>
      <Playback
        key={`${request.version ?? "latest"}:${request.attempt}`}
        child={child}
        songId={songId}
        expectedVersionId={request.version}
        onRefresh={(version) =>
          setRequest({ version, attempt: request.attempt + 1 })
        }
      />
    </section>
  );
}
function Playback({
  child,
  songId,
  expectedVersionId,
  onRefresh,
}: {
  child: ChildProfileDTO;
  songId: string;
  expectedVersionId?: string;
  onRefresh: (version?: string) => void;
}) {
  const service = useKaraokeService();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; data: KaraokePlayback }
    | { status: "error"; message: string; conflict: boolean }
  >({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    service
      .playback(songId, child.id, expectedVersionId, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            status: "error",
            message: karaokeParentErrorMessage(error),
            conflict: isServiceError(error) && error.status === 409,
          });
      });
    return () => controller.abort();
  }, [child.id, expectedVersionId, service, songId]);
  if (state.status === "loading")
    return (
      <p role="status" className="rounded-card bg-sky p-6">
        Đang chuẩn bị nhạc và lời cho bé…
      </p>
    );
  if (state.status === "error")
    return (
      <StatusMessage tone="error" title="Chưa mở được bài hát">
        {state.message}
        <Button
          className="mt-3 sm:w-auto"
          variant="secondary"
          onClick={() =>
            onRefresh(state.conflict ? undefined : expectedVersionId)
          }
        >
          {state.conflict ? "Tải phiên bản mới" : "Thử lại bài hát"}
        </Button>
      </StatusMessage>
    );
  const source = state.data;
  return (
    <KaraokePlayer
      source={source}
      label="Hát cùng bé"
      presentation="child"
      childAlias={child.alias}
      onReload={() => onRefresh(source.version_id)}
    />
  );
}
