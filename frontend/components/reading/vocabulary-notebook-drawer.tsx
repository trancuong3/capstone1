"use client";

import {
  BookHeart,
  Lock,
  Sparkles,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { Button, ButtonLink } from "@/components/common/button";
import type { SpeechPlayer } from "@/hooks/use-speech-player";
import { createSpeechService } from "@/lib/api/speech-service";
import {
  createVocabularyNotebookService,
  type FavoriteWordDTO,
  type VocabularyNotebookListDTO,
  type VocabularyNotebookService,
} from "@/lib/api/vocabulary-notebook-service";
import { createVoiceStudioService } from "@/lib/api/voice-studio-service";
import { TtsPlayback } from "@/lib/reading/tts-playback";
import { useWordGlossaryTranslations } from "@/messages/features/word_glossary";

export interface VocabularyNotebookDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly childId: string | null;
  readonly childAlias?: string | null;
  readonly service?: VocabularyNotebookService;
  readonly speechPlayer?: Pick<SpeechPlayer, "play" | "stop" | "isPlaying">;
  readonly initialNotebook?: VocabularyNotebookListDTO | null;
  readonly onNotebookChange?: (notebook: VocabularyNotebookListDTO) => void;
  readonly showGameLinks?: boolean;
}

export function VocabularyNotebookDrawer({
  open,
  onClose,
  childId,
  childAlias = null,
  service,
  speechPlayer,
  initialNotebook = null,
  onNotebookChange,
  showGameLinks = true,
}: VocabularyNotebookDrawerProps) {
  const tGlossary = useWordGlossaryTranslations();
  const headingId = useId();
  const resolvedService = useMemo(
    () => service ?? createVocabularyNotebookService(),
    [service],
  );
  const lazyPlayerRef = useRef<TtsPlayback | null>(null);

  const [fetchedState, setFetchedState] = useState<{
    readonly childId: string;
    readonly data: VocabularyNotebookListDTO;
  } | null>(null);
  const [completedFetchKey, setCompletedFetchKey] = useState<string | null>(
    null,
  );
  const [playingItemId, setPlayingItemId] = useState<string | null>(null);
  const [removingItemId, setRemovingItemId] = useState<string | null>(null);

  const stopExternalAudio = useCallback(() => {
    if (speechPlayer) {
      speechPlayer.stop();
    } else {
      lazyPlayerRef.current?.stop();
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // Ignore synthesis cancel errors.
      }
    }
  }, [speechPlayer]);

  const stopAudio = useCallback(() => {
    setPlayingItemId(null);
    stopExternalAudio();
  }, [stopExternalAudio]);

  useEffect(() => {
    return () => {
      lazyPlayerRef.current?.dispose();
      lazyPlayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        stopAudio();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      stopExternalAudio();
    };
  }, [onClose, open, stopAudio, stopExternalAudio]);

  const fetchKey = open && childId ? `${childId}:open` : null;

  useEffect(() => {
    if (!open || !childId || !fetchKey) return;
    const controller = new AbortController();
    void resolvedService
      .listNotebook(childId, 50, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setFetchedState({ childId, data });
        setCompletedFetchKey(fetchKey);
        onNotebookChange?.(data);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setCompletedFetchKey(fetchKey);
        }
      });
    return () => controller.abort();
  }, [childId, fetchKey, onNotebookChange, open, resolvedService]);

  const notebook =
    fetchedState && fetchedState.childId === childId
      ? fetchedState.data
      : initialNotebook && initialNotebook.child_id === childId
        ? initialNotebook
        : null;
  const loading = Boolean(fetchKey && completedFetchKey !== fetchKey);

  const handlePlayItem = async (item: FavoriteWordDTO) => {
    if (playingItemId === item.id) {
      stopAudio();
      return;
    }
    stopAudio();
    setPlayingItemId(item.id);
    try {
      if (speechPlayer) {
        await speechPlayer.play(item.spoken_tts_text, {
          coaching: true,
          bypassSessionLock: true,
        });
      } else {
        if (!lazyPlayerRef.current) {
          lazyPlayerRef.current = new TtsPlayback(
            createSpeechService(),
            createVoiceStudioService(),
          );
        }
        await lazyPlayerRef.current.play(item.spoken_tts_text, {
          coaching: true,
          bypassSessionLock: true,
        });
      }
    } catch {
      // Calm silent recovery if audio device is unavailable.
    } finally {
      setPlayingItemId((prev) => (prev === item.id ? null : prev));
    }
  };

  const handleDeleteItem = async (item: FavoriteWordDTO) => {
    if (!childId || removingItemId) return;
    if (playingItemId === item.id) {
      stopAudio();
    }
    setRemovingItemId(item.id);
    try {
      await resolvedService.deleteWord(childId, item.id);
      if (notebook) {
        const remaining = notebook.items.filter(
          (entry) => entry.id !== item.id,
        );
        const nextStoryWords = remaining.slice(0, 3).map((entry) => entry.word);
        const updated: VocabularyNotebookListDTO = {
          child_id: notebook.child_id,
          total: Math.max(0, notebook.total - 1),
          storytelling_words: nextStoryWords,
          items: remaining,
        };
        setFetchedState({ childId, data: updated });
        onNotebookChange?.(updated);
      }
    } catch {
      // Keep item in list if transient network delete failed.
    } finally {
      setRemovingItemId((prev) => (prev === item.id ? null : prev));
    }
  };

  if (!open) return null;

  const items = notebook?.items ?? [];
  const storyWords = (
    notebook?.storytelling_words?.length
      ? notebook.storytelling_words
      : items.slice(0, 3).map((it) => it.word)
  ).slice(0, 3);
  const focusQuery = storyWords.length
    ? `?focus=${encodeURIComponent(storyWords.join(","))}`
    : "";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/45 p-2 sm:items-center sm:p-4"
      data-testid="vocabulary-notebook-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          stopAudio();
          onClose();
        }
      }}
    >
      <section
        aria-labelledby={headingId}
        aria-modal="true"
        className="flex max-h-[88vh] w-full max-w-2xl flex-col overflow-hidden rounded-3xl border-2 border-amber-200 bg-cream shadow-xl"
        data-testid="vocabulary-notebook-drawer"
        role="dialog"
      >
        <header className="flex items-start justify-between gap-3 border-b border-amber-200/80 bg-gradient-to-r from-amber-50 via-white to-sky/40 px-5 py-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-extrabold text-amber-950">
                <BookHeart aria-hidden="true" className="size-3.5" />
                {childAlias
                  ? `${tGlossary("drawerTitle")} • ${childAlias}`
                  : tGlossary("drawerTitle")}
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-0.5 text-xs font-bold text-emerald-900">
                <Lock aria-hidden="true" className="size-3" />
                {tGlossary("privateBadge")}
              </span>
              <span
                className="rounded-full bg-white px-2.5 py-0.5 text-xs font-bold text-muted"
                data-testid="notebook-total-badge"
              >
                {tGlossary("wordCountBadge", { count: items.length })}
              </span>
            </div>
            <h2 className="text-xl font-extrabold text-ink" id={headingId}>
              {tGlossary("drawerTitle")}
            </h2>
            <p className="text-xs font-semibold text-muted">
              {tGlossary("drawerSubtitle")}
            </p>
          </div>

          <button
            aria-label={tGlossary("closeDrawer")}
            className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control border border-border bg-white text-ink hover:bg-canvas focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-primary"
            data-testid="close-vocabulary-notebook-btn"
            onClick={() => {
              stopAudio();
              onClose();
            }}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {showGameLinks && storyWords.length > 0 ? (
            <div
              className="rounded-2xl border border-amber-300/80 bg-amber-50/90 p-3.5"
              data-testid="notebook-storytelling-bridge"
            >
              <p className="flex items-center gap-1.5 text-xs font-extrabold text-amber-950">
                <Sparkles
                  aria-hidden="true"
                  className="size-4 text-amber-600"
                />
                {tGlossary("storyPromptBanner")}{" "}
                <span className="viread-learning-content" dir="ltr" lang="vi">
                  {storyWords.join(", ")}
                </span>
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <ButtonLink
                  className="min-h-10 w-auto!"
                  data-testid="notebook-launch-picture-game"
                  href={`/entertainment/picture-description${focusQuery}`}
                  onClick={() => stopAudio()}
                  size="compact"
                >
                  {tGlossary("playPictureStoryCta")}
                </ButtonLink>
                <ButtonLink
                  className="min-h-10 w-auto!"
                  data-testid="notebook-launch-memory-game"
                  href={`/entertainment/memory-game${focusQuery}`}
                  onClick={() => stopAudio()}
                  size="compact"
                  variant="secondary"
                >
                  {tGlossary("playMemoryStoryCta")}
                </ButtonLink>
              </div>
            </div>
          ) : null}

          {loading && items.length === 0 ? (
            <p className="py-8 text-center text-sm font-semibold text-muted">
              {tGlossary("loadingMeaning")}
            </p>
          ) : items.length === 0 ? (
            <div
              className="rounded-2xl border border-dashed border-border bg-white p-6 text-center"
              data-testid="notebook-empty-state"
            >
              <p className="text-base font-extrabold text-ink">
                {tGlossary("emptyTitle")}
              </p>
              <p className="mt-1 text-sm text-muted">
                {tGlossary("emptyDescription")}
              </p>
            </div>
          ) : (
            <ul className="space-y-3" data-testid="notebook-word-list">
              {items.map((item) => {
                const isPlaying = playingItemId === item.id;
                const isRemoving = removingItemId === item.id;
                return (
                  <li
                    className="rounded-2xl border border-border bg-white p-4 shadow-2xs"
                    data-testid="notebook-word-item"
                    key={item.id}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="viread-learning-content text-lg font-extrabold text-ink"
                          dir="ltr"
                          lang="vi"
                        >
                          {item.word}
                        </span>
                        <span className="rounded-full bg-sky px-2.5 py-0.5 text-xs font-bold text-primary">
                          {item.grade_band === "GRADE_3_5"
                            ? tGlossary("grade35Badge")
                            : tGlossary("grade12Badge")}
                        </span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          className="min-h-10 w-auto!"
                          data-testid={`notebook-listen-${item.normalized_word}`}
                          disabled={isRemoving}
                          onClick={() => void handlePlayItem(item)}
                          size="compact"
                          type="button"
                          variant="secondary"
                        >
                          {isPlaying ? (
                            <>
                              <Square aria-hidden="true" className="size-3.5" />
                              {tGlossary("stopListeningExplanation")}
                            </>
                          ) : (
                            <>
                              <Volume2
                                aria-hidden="true"
                                className="size-3.5"
                              />
                              {tGlossary("listenItem")}
                            </>
                          )}
                        </Button>
                        <Button
                          className="min-h-10 w-auto!"
                          data-testid={`notebook-delete-${item.normalized_word}`}
                          disabled={isRemoving}
                          onClick={() => void handleDeleteItem(item)}
                          size="compact"
                          type="button"
                          variant="quiet"
                        >
                          <Trash2 aria-hidden="true" className="size-3.5" />
                          {isRemoving
                            ? tGlossary("removingItem")
                            : tGlossary("removeItem")}
                        </Button>
                      </div>
                    </div>

                    <p
                      className="viread-learning-content mt-2 text-sm font-semibold text-ink"
                      dir="ltr"
                      lang="vi"
                    >
                      {item.definition_vi}
                    </p>
                    {item.nuance_note_vi ? (
                      <p
                        className="viread-learning-content mt-1 text-xs font-semibold text-primary"
                        dir="ltr"
                        lang="vi"
                      >
                        💡 {item.nuance_note_vi}
                      </p>
                    ) : null}
                    <p
                      className="viread-learning-content mt-1.5 rounded-xl bg-amber-50/70 px-3 py-2 text-xs font-semibold text-amber-950"
                      dir="ltr"
                      lang="vi"
                    >
                      “{item.example_sentence_vi}”
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
