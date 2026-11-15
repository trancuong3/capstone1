import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import type {
  SentenceShooterBookDTO,
  SentenceShooterDifficulty,
  SentenceShooterHintDTO,
  SentenceShooterNextRoundDTO,
  SentenceShooterResultDTO,
  SentenceShooterSessionDTO,
  SentenceShooterShotDTO,
} from "@/types/sentence-shooter";

const bookSchema = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  title: z.string(),
  author: z.string().nullable(),
  min_grade: z.number().int().min(1).max(5),
  max_grade: z.number().int().min(1).max(5),
  available_rounds: z.number().int().min(1),
});

const difficultySchema = z.enum(["easy", "medium", "challenge"]);
const tokenSchema = z.object({ id: z.uuid(), text: z.string() });
const roundSchema = z.object({
  round_id: z.uuid(),
  round_number: z.number().int().min(1).max(5),
  token_count: z.number().int().min(3).max(14),
  tokens: z.array(tokenSchema),
});
const sessionSchema = z.object({
  session_id: z.uuid(),
  book: bookSchema,
  difficulty: difficultySchema,
  total_rounds: z.number().int().min(1).max(5),
  completed_rounds: z.number().int().min(0).max(5),
  total_stars: z.number().int().min(0),
  round: roundSchema,
});
const shotSchema = z.object({
  is_correct: z.boolean(),
  correct_count: z.number().int().min(0),
  token_count: z.number().int().min(3).max(14),
  mistakes_total: z.number().int().min(0),
  completed_rounds: z.number().int().min(0).max(5),
  total_stars: z.number().int().min(0),
  round_completed: z.boolean(),
  session_completed: z.boolean(),
  next_expected_position: z.number().int().min(0),
  stars_awarded: z.number().int().min(0).max(3),
  completed_sentence: z.string().nullable(),
  message: z.string(),
});
const hintSchema = z.object({
  target_token_id: z.uuid(),
  hint_count: z.number().int().min(1),
  message: z.string(),
});
const nextRoundSchema = z.object({
  session_id: z.uuid(),
  completed_rounds: z.number().int().min(1).max(5),
  total_rounds: z.number().int().min(2).max(5),
  total_stars: z.number().int().min(0),
  round: roundSchema,
});
const resultSchema = z.object({
  session_id: z.uuid(),
  book: bookSchema,
  difficulty: difficultySchema,
  status: z.enum(["IN_PROGRESS", "COMPLETED", "ABANDONED"]),
  total_rounds: z.number().int().min(1).max(5),
  completed_rounds: z.number().int().min(0).max(5),
  correct_count: z.number().int().min(0),
  mistakes_total: z.number().int().min(0),
  hint_count: z.number().int().min(0),
  total_stars: z.number().int().min(0),
  duration_seconds: z.number().int().min(0),
  started_at: z.string(),
  completed_at: z.string().nullable(),
});
const abandonSchema = z.object({
  session_id: z.uuid(),
  status: z.literal("ABANDONED"),
});

export interface CreateSentenceShooterSessionInput {
  readonly child_id: string;
  readonly book_id: string;
  readonly difficulty: SentenceShooterDifficulty;
  readonly total_rounds: number;
}

export interface SentenceShooterService {
  listBooks(
    childId: string,
    difficulty: SentenceShooterDifficulty,
    totalRounds: number,
    signal?: AbortSignal,
  ): Promise<SentenceShooterBookDTO[]>;
  createSession(
    input: CreateSentenceShooterSessionInput,
    signal?: AbortSignal,
  ): Promise<SentenceShooterSessionDTO>;
  shoot(
    sessionId: string,
    input: { round_id: string; token_id: string; request_id: string },
    signal?: AbortSignal,
  ): Promise<SentenceShooterShotDTO>;
  hint(
    sessionId: string,
    roundId: string,
    signal?: AbortSignal,
  ): Promise<SentenceShooterHintDTO>;
  nextRound(
    sessionId: string,
    roundId: string,
    signal?: AbortSignal,
  ): Promise<SentenceShooterNextRoundDTO>;
  result(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SentenceShooterResultDTO>;
  abandon(sessionId: string, signal?: AbortSignal): Promise<void>;
}

const basePath = "/games/sentence-shooter";
const requestTimeoutMs = 20_000;

async function withRequestTimeout<T>(
  signal: AbortSignal | undefined,
  request: (requestSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(
    () =>
      controller.abort(new DOMException("Request timed out", "TimeoutError")),
    requestTimeoutMs,
  );
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    return await request(controller.signal);
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function createSentenceShooterService(): SentenceShooterService {
  return {
    listBooks: (childId, difficulty, totalRounds, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          basePath +
            "/books" +
            apiQuery({
              child_id: childId,
              difficulty,
              total_rounds: totalRounds,
            }),
          z.array(bookSchema),
          requestSignal,
        ),
      ),
    createSession: (input, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(basePath + "/sessions", sessionSchema, requestSignal, {
          method: "POST",
          body: input,
        }),
      ),
    shoot: (sessionId, input, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          basePath + "/sessions/" + encodeURIComponent(sessionId) + "/shots",
          shotSchema,
          requestSignal,
          { method: "POST", body: input },
        ),
      ),
    hint: (sessionId, roundId, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          basePath + "/sessions/" + encodeURIComponent(sessionId) + "/hints",
          hintSchema,
          requestSignal,
          { method: "POST", body: { round_id: roundId, hint_level: 1 } },
        ),
      ),
    nextRound: (sessionId, roundId, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          basePath +
            "/sessions/" +
            encodeURIComponent(sessionId) +
            "/next-round",
          nextRoundSchema,
          requestSignal,
          { method: "POST", body: { round_id: roundId } },
        ),
      ),
    result: (sessionId, signal) =>
      withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          basePath + "/sessions/" + encodeURIComponent(sessionId) + "/result",
          resultSchema,
          requestSignal,
        ),
      ),
    abandon: async (sessionId, signal) => {
      await withRequestTimeout(signal, (requestSignal) =>
        requestApi(
          basePath + "/sessions/" + encodeURIComponent(sessionId) + "/abandon",
          abandonSchema,
          requestSignal,
          { method: "POST" },
        ),
      );
    },
  };
}
