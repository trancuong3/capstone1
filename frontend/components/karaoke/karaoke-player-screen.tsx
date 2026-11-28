"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KaraokeChildBoundary } from "@/components/karaoke/karaoke-child-boundary";
import {
  KaraokeStage,
  type KaraokePracticeHistorySummary,
} from "@/components/karaoke/karaoke-stage";
import { useKaraokeService } from "@/components/karaoke/karaoke-services-provider";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useIsMobileViewport } from "@/components/dashboard/use-is-mobile-viewport";
import { useKaraokePlayer } from "@/hooks/use-karaoke-player";
import { useTranslations } from "@/hooks/use-i18n";
import {
  karaokeParentErrorMessage,
  type KaraokePlayback,
} from "@/lib/api/karaoke-service";
import { createKaraokePracticeService } from "@/lib/api/karaoke-practice-service";
import { isServiceError } from "@/lib/api/service-error";
import type { MusicalEvaluationResult } from "@/lib/karaoke/musical-scoring";
import type { ChildProfileDTO } from "@/types/child";

export function KaraokePlayerScreen({
  songId,
  expectedVersionId,
}: {
  songId: string;
  expectedVersionId?: string;
}) {
  const isMobile = useIsMobileViewport();

  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      window.dispatchEvent(
        new CustomEvent("viread:immersive-mode", {
          detail: { active: isMobile },
        }),
      );
    });
    return () => {
      cancelled = true;
      window.dispatchEvent(
        new CustomEvent("viread:immersive-mode", {
          detail: { active: false },
        }),
      );
    };
  }, [isMobile]);

  return (
    <KaraokeChildBoundary>
      {(child) => (
        <Song
          key={`${child.id}:${child.grade}:${songId}:${expectedVersionId ?? "latest"}`}
          child={child}
          isMobile={isMobile}
          songId={songId}
          expectedVersionId={expectedVersionId}
        />
      )}
    </KaraokeChildBoundary>
  );
}

function Song({
  child,
  isMobile,
  songId,
  expectedVersionId,
}: {
  child: ChildProfileDTO;
  isMobile: boolean;
  songId: string;
  expectedVersionId?: string;
}) {
  const t = useTranslations("entertainment");
  const [request, setRequest] = useState({
    version: expectedVersionId,
    attempt: 0,
  });
  return (
    <section
      className={
        isMobile
          ? "mx-auto grid w-full max-w-[960px] gap-3.5"
          : "mx-auto grid w-full max-w-[960px] gap-6"
      }
    >
      {isMobile ? (
        <div className="flex min-h-12 items-center justify-between gap-2">
          <ButtonLink
            className="border border-border shadow-xs"
            fullWidth={false}
            href="/karaoke"
            size="touch"
            variant="quiet"
          >
            <ArrowLeft
              aria-hidden="true"
              className="viread-rtl-flip size-4 shrink-0"
            />
            {t("karaoke.playerScreen.backToLibrary")}
          </ButtonLink>
          <Link
            className="inline-flex min-h-11 max-w-[152px] shrink-0 items-center truncate rounded-full border border-border bg-sky/80 px-3 text-xs font-bold text-primary-hover focus-visible:outline-3 focus-visible:outline-primary"
            href="/dashboard?focus=child-selection"
          >
            <span className="truncate">
              {t("hub.childOptionLabel", {
                alias: child.alias,
                grade: child.grade,
              })}
            </span>
          </Link>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <SelectedChildIdentity child={child} />
          <ButtonLink fullWidth={false} href="/karaoke" variant="secondary">
            {t("karaoke.playerScreen.backToLibrary")}
          </ButtonLink>
        </div>
      )}
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

/**
 * Directly mounts `useKaraokePlayer` + `KaraokeStage` with a memoized `source`
 * reference, eliminating per-frame `source={{ ...source, lyrics }}` cloning.
 */
function ChildKaraokeSession({
  source,
  child,
  onReload,
}: {
  source: KaraokePlayback;
  child: ChildProfileDTO;
  onReload: () => void;
}) {
  const t = useTranslations("entertainment");
  const practiceService = useMemo(() => createKaraokePracticeService(), []);
  const player = useKaraokePlayer(
    source.audio_url,
    source.duration_ms,
    source.audio_url_expires_at,
  );

  const onLoadMusicalProfile = useCallback(async () => {
    try {
      return await practiceService.getMusicalProfile(source.song_id);
    } catch {
      return null;
    }
  }, [practiceService, source.song_id]);

  const onLoadPracticeHistory =
    useCallback(async (): Promise<KaraokePracticeHistorySummary | null> => {
      try {
        const res = await practiceService.listPracticeSessions(
          child.id,
          source.song_id,
          10,
        );
        return {
          bestFullSongScore: res.best_full_song_score,
          bestFullSongStars: res.best_full_song_stars,
          totalSessions: res.total_sessions,
        };
      } catch {
        return null;
      }
    }, [child.id, practiceService, source.song_id]);

  const onSavePracticeSession = useCallback(
    async (
      evaluation: MusicalEvaluationResult,
      meta: {
        playbackRate: number;
        headphoneMode: boolean;
        segmentStartMs: number | null;
        segmentEndMs: number | null;
      },
    ) => {
      await practiceService.savePracticeSession({
        childId: child.id,
        songId: source.song_id,
        songVersionId: source.version_id,
        practiceMode: evaluation.practiceMode,
        playbackRate: meta.playbackRate,
        headphoneMode: meta.headphoneMode,
        segmentStartMs: meta.segmentStartMs,
        segmentEndMs: meta.segmentEndMs,
        evaluation,
      });
    },
    [child.id, practiceService, source.song_id, source.version_id],
  );

  return (
    <KaraokeStage
      source={source}
      player={player}
      childAlias={child.alias}
      label={t("karaoke.playerScreen.childStageLabel")}
      onReload={onReload}
      onLoadMusicalProfile={onLoadMusicalProfile}
      onLoadPracticeHistory={onLoadPracticeHistory}
      onSavePracticeSession={onSavePracticeSession}
    />
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
  const t = useTranslations("entertainment");
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
        {t("karaoke.playerScreen.loading")}
      </p>
    );
  if (state.status === "error")
    return (
      <StatusMessage
        tone="error"
        title={t("karaoke.playerScreen.openErrorTitle")}
      >
        {state.message}
        <Button
          className="mt-3"
          fullWidth={false}
          variant="secondary"
          onClick={() =>
            onRefresh(state.conflict ? undefined : expectedVersionId)
          }
        >
          {state.conflict
            ? t("karaoke.playerScreen.reloadNewVersion")
            : t("karaoke.playerScreen.retrySong")}
        </Button>
      </StatusMessage>
    );
  const source = state.data;
  return (
    <ChildKaraokeSession
      key={`${source.version_id}:${source.audio_url}`}
      source={source}
      child={child}
      onReload={() => onRefresh(source.version_id)}
    />
  );
}
