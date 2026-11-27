import { z } from "zod";

import { apiQuery, requestApi } from "@/lib/api/api-client";
import { translateRuntime } from "@/lib/i18n/runtime";
import type {
  DifficultWordBookGroup,
  DifficultWordDTO,
  DifficultWordEvaluateAudioInput,
  DifficultWordEvaluateDirectInput,
  DifficultWordPracticeAttemptDTO,
  DifficultWordPracticeCompleteInput,
  DifficultWordPracticeHistoryDTO,
  DifficultWordPracticeStartInput,
  DifficultWordPracticeStatus,
  DifficultWordPracticeResultUI,
  ReportDateWindow,
} from "@/types/reports";

export interface DifficultWordListOptions {
  readonly statusFilter?: DifficultWordPracticeStatus;
  readonly signal?: AbortSignal;
}

export interface DifficultWordService {
  list(
    childId: string,
    window?: ReportDateWindow,
    options?: DifficultWordListOptions,
  ): Promise<DifficultWordDTO[]>;
  practice(
    childId: string,
    normalizedWord: string,
    displayText?: string,
  ): Promise<DifficultWordPracticeResultUI>;
  startPractice(
    childId: string,
    input: DifficultWordPracticeStartInput,
    signal?: AbortSignal,
  ): Promise<DifficultWordPracticeAttemptDTO>;
  evaluateAudio(
    childId: string,
    attemptId: string,
    input: DifficultWordEvaluateAudioInput,
    signal?: AbortSignal,
  ): Promise<DifficultWordPracticeAttemptDTO>;
  evaluatePracticeWord?(
    childId: string,
    input: DifficultWordEvaluateDirectInput,
    signal?: AbortSignal,
  ): Promise<DifficultWordPracticeAttemptDTO>;
  completePractice(
    childId: string,
    attemptId: string,
    input: DifficultWordPracticeCompleteInput,
    signal?: AbortSignal,
  ): Promise<DifficultWordPracticeAttemptDTO>;
  getPracticeHistory(
    childId: string,
    options?: {
      readonly normalizedWord?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<DifficultWordPracticeHistoryDTO>;
}

const practiceStatusSchema = z.enum([
  "NOT_PRACTICED",
  "IN_PROGRESS",
  "NEEDS_MORE_PRACTICE",
  "COMPLETED",
]);

const practiceAssessmentStatusSchema = z.enum([
  "CORRECT",
  "INCORRECT",
  "UNCERTAIN",
  "NO_CLEAR_AUDIO",
  "ENGINE_ERROR",
]);

const recognitionSourceSchema = z.enum([
  "SERVER_STT",
  "SERVER_STT_KEYTERM",
  "BROWSER_SPEECH",
  "AUDIO_QUALITY_GATE",
  "ENGINE_ERROR",
]);

const difficultWordSourceSchema = z.object({
  book_id: z.uuid().nullable().optional(),
  book_title: z.string().nullable().optional(),
  book_author: z.string().nullable().optional(),
  min_grade: z.number().int().nullable().optional(),
  max_grade: z.number().int().nullable().optional(),
  book_cover_url: z.string().nullable().optional(),
  session_id: z.uuid().nullable().optional(),
  page_id: z.uuid().nullable().optional(),
  page_revision_id: z.uuid().nullable().optional(),
  page_number: z.number().int().nullable().optional(),
  word_id: z.uuid().nullable().optional(),
  context_phrase: z.string().nullable().optional(),
  last_seen_at: z.iso.datetime({ offset: true }),
});

export const difficultWordSchema = z.object({
  normalized_word: z.string(),
  display_text: z.string(),
  difficulty_score: z.number(),
  omission_count: z.number().int().nonnegative(),
  repetition_count: z.number().int().nonnegative(),
  long_pause_count: z.number().int().nonnegative(),
  read_example_count: z.number().int().nonnegative(),
  session_count: z.number().int().nonnegative(),
  last_seen_at: z.iso.datetime({ offset: true }),
  evidence_word_ids: z.array(z.uuid()),
  mispronunciation_count: z.number().int().nonnegative().optional(),
  encounter_count: z.number().int().nonnegative().optional(),
  practice_status: practiceStatusSchema.optional(),
  practice_attempts_count: z.number().int().nonnegative().optional(),
  practice_correct_count: z.number().int().nonnegative().optional(),
  practice_incorrect_count: z.number().int().nonnegative().optional(),
  practice_uncertain_count: z.number().int().nonnegative().optional(),
  consecutive_correct_count: z.number().int().nonnegative().optional(),
  last_practiced_at: z.iso.datetime({ offset: true }).nullable().optional(),
  last_practice_status: practiceAssessmentStatusSchema.nullable().optional(),
  sources: z.array(difficultWordSourceSchema).optional(),
});

const wordProgressSchema = z.object({
  normalized_word: z.string(),
  practice_status: practiceStatusSchema,
  practice_attempts_count: z.number().int().nonnegative(),
  practice_correct_count: z.number().int().nonnegative(),
  practice_incorrect_count: z.number().int().nonnegative(),
  practice_uncertain_count: z.number().int().nonnegative(),
  consecutive_correct_count: z.number().int().nonnegative(),
  required_consecutive_correct: z.number().int().positive(),
  last_practiced_at: z.iso.datetime({ offset: true }).nullable(),
  last_practice_status: practiceAssessmentStatusSchema.nullable(),
});

const practiceAttemptSchema = z.object({
  attempt_id: z.uuid(),
  child_id: z.uuid(),
  normalized_word: z.string(),
  display_text: z.string(),
  attempt_number: z.number().int().positive(),
  state: z.enum(["STARTED", "COMPLETED"]),
  assessment_status: practiceAssessmentStatusSchema.nullable(),
  recognition_source: recognitionSourceSchema.nullable(),
  spoken_transcript: z.string().nullable(),
  confidence: z.number().nullable(),
  audio_duration_ms: z.number().int().nonnegative().nullable(),
  assessment_version: z.number().int().positive(),
  evidence_word_ids: z.array(z.uuid()),
  book_id: z.uuid().nullable().optional(),
  session_id: z.uuid().nullable().optional(),
  page_id: z.uuid().nullable().optional(),
  page_revision_id: z.uuid().nullable().optional(),
  word_id: z.uuid().nullable().optional(),
  resolved_in_session: z.boolean().optional(),
  persistence_backend: z
    .enum(["PRACTICE_TABLE_AND_EVENT", "PRACTICE_TABLE", "READING_EVENT"])
    .nullable()
    .optional(),
  started_at: z.iso.datetime({ offset: true }),
  completed_at: z.iso.datetime({ offset: true }).nullable(),
  feedback_message: z.string().nullable(),
  word_progress: wordProgressSchema,
  next_recommended_word: z.string().nullable(),
  evidence_count_unchanged: z.literal(true),
});

const practiceHistoryItemSchema = z.object({
  attempt_id: z.uuid(),
  normalized_word: z.string(),
  display_text: z.string(),
  attempt_number: z.number().int().positive(),
  state: z.enum(["STARTED", "COMPLETED"]),
  assessment_status: practiceAssessmentStatusSchema.nullable(),
  recognition_source: recognitionSourceSchema.nullable(),
  spoken_transcript: z.string().nullable(),
  confidence: z.number().nullable(),
  audio_duration_ms: z.number().int().nonnegative().nullable(),
  assessment_version: z.number().int().positive(),
  started_at: z.iso.datetime({ offset: true }),
  completed_at: z.iso.datetime({ offset: true }).nullable(),
});

const practiceHistorySchema = z.object({
  storage_ready: z.boolean(),
  items: z.array(practiceHistoryItemSchema),
});

function generateClientUuid(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return "00000000-0000-4000-8000-000000000001";
}

function audioFilenameForMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "practice.ogg";
  if (mimeType.includes("mp4")) return "practice.mp4";
  if (mimeType.includes("wav")) return "practice.wav";
  return "practice.webm";
}

export function createDifficultWordService(): DifficultWordService {
  const startPractice: DifficultWordService["startPractice"] = (
    childId,
    input,
    signal,
  ) =>
    requestApi(
      `/system/difficult-words/${encodeURIComponent(childId)}/practice/start`,
      practiceAttemptSchema,
      signal,
      {
        method: "POST",
        body: {
          request_id: input.request_id,
          normalized_word: input.normalized_word,
          ...(input.display_text ? { display_text: input.display_text } : {}),
          ...(input.evidence_word_ids?.length
            ? { evidence_word_ids: input.evidence_word_ids }
            : {}),
        },
      },
    );

  return {
    list: (childId, window, options) =>
      requestApi(
        `/system/difficult-words/${encodeURIComponent(childId)}${apiQuery({
          period_start: window?.period_start,
          period_end: window?.period_end,
          status_filter: options?.statusFilter,
        })}`,
        z.array(difficultWordSchema),
        options?.signal,
      ),
    startPractice,
    async practice(childId, normalizedWord, displayText) {
      const started = await startPractice(childId, {
        request_id: generateClientUuid(),
        normalized_word: normalizedWord,
        display_text: displayText ?? normalizedWord,
      });
      return {
        normalized_word: started.normalized_word,
        action_id: started.attempt_id,
        message: translateRuntime("difficultWords.runtime.practiceOpened", {
          attempt: started.attempt_number,
          word: started.display_text,
        }),
        evidence_count_unchanged: started.evidence_count_unchanged,
      };
    },
    evaluateAudio(childId, attemptId, input, signal) {
      const mimeType = input.audio.type || "audio/webm";
      const fileBlob = input.audio.type
        ? input.audio
        : new Blob([input.audio], { type: mimeType });
      const form = new FormData();
      form.append("completion_request_id", input.completion_request_id);
      form.append(
        "file",
        fileBlob,
        input.filename ?? audioFilenameForMime(mimeType),
      );
      if (input.audio_duration_ms != null) {
        form.append(
          "audio_duration_ms",
          String(Math.round(input.audio_duration_ms)),
        );
      }
      if (input.audio_quality_status) {
        form.append("audio_quality_status", input.audio_quality_status);
      }
      if (input.browser_transcript) {
        form.append("browser_transcript", input.browser_transcript);
      }
      if (input.browser_confidence != null) {
        form.append("browser_confidence", String(input.browser_confidence));
      }
      return requestApi(
        `/system/difficult-words/${encodeURIComponent(childId)}/practice/${encodeURIComponent(attemptId)}/evaluate-audio`,
        practiceAttemptSchema,
        signal,
        {
          method: "POST",
          body: form,
        },
      );
    },
    evaluatePracticeWord(childId, input, signal) {
      const form = new FormData();
      form.append("request_id", input.request_id);
      form.append("normalized_word", input.normalized_word);
      if (input.display_text) {
        form.append("display_text", input.display_text);
      }
      if (input.context_phrase) {
        form.append("context_phrase", input.context_phrase);
      }
      if (input.audio && input.audio.size > 0) {
        const mimeType = input.audio.type || "audio/webm";
        const fileBlob = input.audio.type
          ? input.audio
          : new Blob([input.audio], { type: mimeType });
        form.append(
          "file",
          fileBlob,
          input.filename ?? audioFilenameForMime(mimeType),
        );
      }
      if (input.audio_duration_ms != null) {
        form.append(
          "audio_duration_ms",
          String(Math.round(input.audio_duration_ms)),
        );
      }
      if (input.audio_quality_status) {
        form.append("audio_quality_status", input.audio_quality_status);
      }
      if (input.browser_transcript) {
        form.append("browser_transcript", input.browser_transcript);
      }
      if (input.browser_confidence != null) {
        form.append("browser_confidence", String(input.browser_confidence));
      }
      if (input.book_id) form.append("book_id", input.book_id);
      if (input.session_id) form.append("session_id", input.session_id);
      if (input.page_id) form.append("page_id", input.page_id);
      if (input.page_revision_id) {
        form.append("page_revision_id", input.page_revision_id);
      }
      if (input.word_id) form.append("word_id", input.word_id);
      if (input.evidence_word_ids?.length) {
        form.append(
          "evidence_word_ids",
          JSON.stringify(input.evidence_word_ids),
        );
      }
      if (input.provider_mode) {
        form.append("provider_mode", input.provider_mode);
      }
      if (input.allow_google_stt != null) {
        form.append("allow_google_stt", String(input.allow_google_stt));
      }
      return requestApi(
        `/system/difficult-words/${encodeURIComponent(childId)}/practice/evaluate`,
        practiceAttemptSchema,
        signal,
        {
          method: "POST",
          body: form,
        },
      );
    },
    completePractice: (childId, attemptId, input, signal) =>
      requestApi(
        `/system/difficult-words/${encodeURIComponent(childId)}/practice/${encodeURIComponent(attemptId)}/complete`,
        practiceAttemptSchema,
        signal,
        {
          method: "POST",
          body: input,
        },
      ),
    getPracticeHistory: (childId, options) =>
      requestApi(
        `/system/difficult-words/${encodeURIComponent(childId)}/practice/history${apiQuery(
          {
            normalized_word: options?.normalizedWord,
            limit: options?.limit,
          },
        )}`,
        practiceHistorySchema,
        options?.signal,
      ),
  };
}

export function groupDifficultWordsByBook(
  words: readonly DifficultWordDTO[],
): readonly DifficultWordBookGroup[] {
  const buckets = new Map<
    string,
    {
      bookId: string | null;
      bookTitle: string;
      bookAuthor: string | null;
      bookCoverUrl: string | null;
      minGrade: number | null;
      maxGrade: number | null;
      words: DifficultWordDTO[];
      /** Track normalized_word values already added to avoid duplicates. */
      seenWords: Set<string>;
      latestSeenAt: string;
    }
  >();

  function upsertBucket(
    key: string,
    bookId: string | null,
    bookTitle: string,
    bookAuthor: string | null,
    bookCoverUrl: string | null,
    minGrade: number | null,
    maxGrade: number | null,
    word: DifficultWordDTO,
    matchingSources: DifficultWordDTO["sources"],
  ): void {
    // Build a word copy whose `sources` only contain entries for this book.
    const wordForBucket: DifficultWordDTO =
      matchingSources && matchingSources !== word.sources
        ? { ...word, sources: matchingSources }
        : word;

    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        bookId,
        bookTitle,
        bookAuthor,
        bookCoverUrl,
        minGrade,
        maxGrade,
        words: [wordForBucket],
        seenWords: new Set([word.normalized_word]),
        latestSeenAt: word.last_seen_at,
      });
    } else {
      // Only add the word once per book bucket.
      if (!existing.seenWords.has(word.normalized_word)) {
        existing.seenWords.add(word.normalized_word);
        existing.words.push(wordForBucket);
      }
      if (word.last_seen_at > existing.latestSeenAt) {
        existing.latestSeenAt = word.last_seen_at;
      }
      if (!existing.bookAuthor && bookAuthor) {
        existing.bookAuthor = bookAuthor;
      }
      if (!existing.bookCoverUrl && bookCoverUrl) {
        existing.bookCoverUrl = bookCoverUrl;
      }
      if (existing.minGrade == null && minGrade != null) {
        existing.minGrade = minGrade;
      }
      if (existing.maxGrade == null && maxGrade != null) {
        existing.maxGrade = maxGrade;
      }
    }
  }

  for (const word of words) {
    const sources = word.sources;

    // Collect all distinct book_ids from the word's sources.
    if (sources && sources.length > 0) {
      // Group sources by book_id so each bucket gets only its own sources.
      const sourcesByBook = new Map<
        string,
        typeof sources extends readonly (infer T)[] ? T[] : never
      >();
      let hasValidBook = false;
      for (const src of sources) {
        const bid = src.book_id;
        if (bid) {
          hasValidBook = true;
          let arr = sourcesByBook.get(bid);
          if (!arr) {
            arr = [];
            sourcesByBook.set(bid, arr);
          }
          arr.push(src);
        }
      }

      if (hasValidBook) {
        for (const [bid, bookSources] of sourcesByBook) {
          // Use the first source of this book for metadata.
          const rep = bookSources[0]!;
          upsertBucket(
            bid,
            bid,
            rep.book_title?.trim() ||
              translateRuntime("difficultWords.runtime.unknownBookSource"),
            rep.book_author ?? null,
            rep.book_cover_url ?? null,
            rep.min_grade ?? null,
            rep.max_grade ?? null,
            word,
            bookSources,
          );
        }
      } else {
        // All sources lack a book_id — fall through to unknown.
        const first = sources[0]!;
        upsertBucket(
          "__unknown_book__",
          null,
          translateRuntime("difficultWords.runtime.unknownBookSource"),
          first.book_author ?? null,
          first.book_cover_url ?? null,
          first.min_grade ?? null,
          first.max_grade ?? null,
          word,
          sources,
        );
      }
    } else {
      // No sources at all.
      upsertBucket(
        "__unknown_book__",
        null,
        translateRuntime("difficultWords.runtime.unknownBookSource"),
        null,
        null,
        null,
        null,
        word,
        sources,
      );
    }
  }

  const groups: DifficultWordBookGroup[] = [];
  for (const [key, bucket] of buckets.entries()) {
    const completedWords = bucket.words.filter(
      (item) => item.practice_status === "COMPLETED",
    ).length;
    const totalWords = bucket.words.length;
    const progressPercent =
      totalWords > 0 ? Math.round((completedWords / totalWords) * 100) : 0;
    groups.push({
      key,
      bookId: bucket.bookId,
      bookTitle: bucket.bookTitle,
      bookAuthor: bucket.bookAuthor,
      bookCoverUrl: bucket.bookCoverUrl,
      minGrade: bucket.minGrade,
      maxGrade: bucket.maxGrade,
      words: bucket.words,
      totalWords,
      completedWords,
      progressPercent,
      latestSeenAt: bucket.latestSeenAt,
    });
  }

  return groups.sort((left, right) => {
    const leftPending = left.totalWords - left.completedWords;
    const rightPending = right.totalWords - right.completedWords;
    if (leftPending > 0 !== rightPending > 0) {
      return leftPending > 0 ? -1 : 1;
    }
    if (left.bookId && !right.bookId) return -1;
    if (!left.bookId && right.bookId) return 1;
    if (rightPending !== leftPending) return rightPending - leftPending;
    return right.latestSeenAt.localeCompare(left.latestSeenAt);
  });
}
