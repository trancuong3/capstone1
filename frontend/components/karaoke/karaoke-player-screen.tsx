"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { KaraokeChildBoundary } from "@/components/karaoke/karaoke-child-boundary";
import {
  KaraokeStage,
  type KaraokePracticeHistorySummary,
} from "@/components/karaoke/karaoke-stage";
import { useKaraokeService } from "@/components/karaoke/karaoke-services-provider";
import { SelectedChildIdentity } from "@/components/children/selected-child-identity";
import { Button, ButtonLink } from "@/components/common/button";
import { StatusMessage } from "@/components/common/status-message";
import { useKaraokePlayer } from "@/hooks/use-karaoke-player";
import { useTranslations } from "@/hooks/use-i18n";
import {
  karaokeParentErrorMessage,
  type KaraokePlayback,
} from "@/lib/api/karaoke-service";
import { createKaraokePracticeService } from "@/lib/api/karaoke-practice-service";
import { createAdaptiveLearningService } from "@/lib/api/adaptive-learning-service";
import { isServiceError } from "@/lib/api/service-error";
import type { MusicalEvaluationResult } from "@/lib/karaoke/musical-scoring";
import type { ChildProfileDTO } from "@/types/child";

export function KaraokePlayerScreen({
  songId,
  expectedVersionId,
  autoPlay,
  autoScored,
}: {
  songId: string;
  expectedVersionId?: string;
  autoPlay?: boolean;
  autoScored?: boolean;
}) {
  const searchParams = useSearchParams();
  const resolvedAutoPlay = autoPlay ?? searchParams?.get("autoplay") === "1";
  const scoredParam = searchParams?.get("scored");
  const resolvedAutoScored =
    autoScored ??
    (scoredParam === "1" || (resolvedAutoPlay && scoredParam !== "0"));

  return (
    <KaraokeChildBoundary>
      {(child) => (
        <Song
          key={`${child.id}:${child.grade}:${songId}:${expectedVersionId ?? "latest"}`}
          child={child}
          songId={songId}
          expectedVersionId={expectedVersionId}
          autoPlay={resolvedAutoPlay}
          autoScored={resolvedAutoScored}
        />
      )}
    </KaraokeChildBoundary>
  );
}

function Song({
  child,
  songId,
  expectedVersionId,
  autoPlay,
  autoScored,
}: {
  child: ChildProfileDTO;
  songId: string;
  expectedVersionId?: string;
  autoPlay: boolean;
  autoScored: boolean;
}) {
  const t = useTranslations("entertainment");
  const [request, setRequest] = useState({
    version: expectedVersionId,
    attempt: 0,
  });
  return (
    <section className="mx-auto grid w-full max-w-[960px] gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <SelectedChildIdentity child={child} />
        <ButtonLink href="/karaoke" variant="secondary" className="sm:w-auto">
          {t("karaoke.playerScreen.backToLibrary")}
        </ButtonLink>
      </div>
      <Playback
        key={`${request.version ?? "latest"}:${request.attempt}`}
        child={child}
        songId={songId}
        expectedVersionId={request.version}
        autoPlay={autoPlay}
        autoScored={autoScored}
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
  autoPlay,
  autoScored,
  onReload,
}: {
  source: KaraokePlayback;
  child: ChildProfileDTO;
  autoPlay: boolean;
  autoScored: boolean;
  onReload: () => void;
}) {
  const t = useTranslations("entertainment");
  const practiceService = useMemo(() => createKaraokePracticeService(), []);
  const adaptiveService = useMemo(() => createAdaptiveLearningService(), []);
  const [focusWords, setFocusWords] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    const params = new URLSearchParams(window.location.search);
    const raw =
      params.get("focus") ??
      params.get("focusWords") ??
      params.get("targetWords") ??
      "";
    return raw
      .split(",")
      .map((w) => w.trim())
      .filter(Boolean)
      .slice(0, 8);
  });
  const initialAutopilot = useMemo(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return (
      params.get("autopilot") === "1" || params.get("autopilot") === "true"
    );
  }, []);

  useEffect(() => {
    if (focusWords.length > 0) return;
    let active = true;
    void adaptiveService
      .getRecommendations(child.id)
      .then((rec) => {
        if (active && rec.focus_difficult_words?.length) {
          setFocusWords(rec.focus_difficult_words.slice(0, 6));
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [adaptiveService, child.id, focusWords.length]);

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
        matchedDifficultWords?: string[];
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
        matchedDifficultWords: meta.matchedDifficultWords,
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
      focusWords={focusWords}
      initialAutopilot={initialAutopilot}
      onReload={onReload}
      onLoadMusicalProfile={onLoadMusicalProfile}
      onLoadPracticeHistory={onLoadPracticeHistory}
      onSavePracticeSession={onSavePracticeSession}
      autoPlay={autoPlay}
      autoScored={autoScored}
    />
  );
}

function Playback({
  child,
  songId,
  expectedVersionId,
  autoPlay,
  autoScored,
  onRefresh,
}: {
  child: ChildProfileDTO;
  songId: string;
  expectedVersionId?: string;
  autoPlay: boolean;
  autoScored: boolean;
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
          className="mt-3 sm:w-auto"
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
      autoPlay={autoPlay}
      autoScored={autoScored}
      onReload={() => onRefresh(source.version_id)}
    />
  );
}
