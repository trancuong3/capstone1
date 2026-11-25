/**
 * Bộ điều phối luồng đọc tự động ("bấm Bắt đầu một lần").
 *
 * Tách khỏi UI để kiểm thử được: `reduce` là hàm thuần (trạng thái, sự kiện) →
 * (trạng thái mới, danh sách hiệu ứng). Không có timer, không có I/O. Mọi mốc
 * thời gian là mili-giây của một đồng hồ đơn điệu do bên gọi cung cấp
 * (`event.at`). `ReadingAutomationRuntime` ở cuối file chỉ nối reducer với
 * timer và các cổng I/O.
 *
 * Trạng thái: sẵn sàng → đang nghe → có bằng chứng → đọc mẫu → chờ bé thử lại
 * → chuyển trang → hoàn tất, cùng với tạm dừng / thiếu quyền / mất mạng.
 *
 * Bất biến (được kiểm thử, kể cả với chuỗi sự kiện ngẫu nhiên có seed):
 *  I1  đã dừng (userStopped) thì không bao giờ phát hiệu ứng mở mic / đọc mẫu tự động
 *  I2  một trang không lưu hai lần song song, không lưu lại sau khi đã lưu
 *  I3  một trang không chuyển hai lần
 *  I4  sự kiện của phiên / trang / revision / lượt nghe / lượt đọc mẫu khác bị bỏ
 *  I5  không can thiệp (nhắc, đọc mẫu) khi bé đang nói
 *  I6  từ được trợ giúp hoặc bị bỏ qua không bao giờ ở trạng thái "correct"
 */

export type AutomationPhase =
  | "idle"
  | "ready"
  | "listening"
  | "evidence"
  | "hinting"
  | "modeling"
  | "awaiting-retry"
  | "quiz-listening"
  | "page-turn"
  | "complete"
  | "paused"
  | "permission-needed"
  | "offline"
  | "recovering";

export type AutomationWordState =
  "pending" | "correct" | "retry" | "skipped" | "assisted";

export interface AutomationSettings {
  /** Hỗ trợ tự động: tự nhắc nhẹ và tự đọc mẫu khi bé mắc kẹt. */
  readonly assist: boolean;
  /** Tự chuyển trang khi đủ điều kiện. */
  readonly autoAdvance: boolean;
}

export interface AutomationConfig {
  readonly hesitationMinMs: number;
  readonly hesitationMaxMs: number;
  readonly paceMultiplier: number;
  readonly initialPaceMs: number;
  /** Ngắt hơi sau dấu câu được phép lâu hơn. */
  readonly punctuationFactor: number;
  readonly promptToHelpMs: number;
  readonly speechQuietMs: number;
  readonly selfCorrectWindowMs: number;
  readonly maxAttemptsPerWord: number;
  readonly promptCooldownMs: number;
  readonly maxPromptsPerPage: number;
  readonly resumeAfterModelMs: number;
  readonly evidenceLingerMs: number;
  readonly autoAdvanceDelayMs: number;
  readonly saveRetryBaseMs: number;
  readonly saveRetryMaxMs: number;
  /** Maximum consecutive silence reminders before offering pause (safe mode). */
  readonly maxSilenceReminders?: number;
  /** Extra wait duration when child says "chờ con" / "để con tự đọc". */
  readonly waitExtendMs?: number;
  /** Cap silence reminders and emit offer-pause rather than endless modeling. */
  readonly offerPauseOnProlongedSilence?: boolean;
}

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = {
  hesitationMinMs: 4000,
  hesitationMaxMs: 9000,
  paceMultiplier: 2.5,
  initialPaceMs: 1500,
  punctuationFactor: 1.5,
  promptToHelpMs: 3000,
  speechQuietMs: 1200,
  selfCorrectWindowMs: 1500,
  maxAttemptsPerWord: 3,
  promptCooldownMs: 6000,
  maxPromptsPerPage: 3,
  resumeAfterModelMs: 250,
  evidenceLingerMs: 600,
  autoAdvanceDelayMs: 800,
  saveRetryBaseMs: 2000,
  saveRetryMaxMs: 30_000,
};

/** Live ReadingScreen config: 2-round escalating auto-help ladder + prolonged silence safety. */
export const AUTO_HELP_LADDER_CONFIG: AutomationConfig = {
  ...DEFAULT_AUTOMATION_CONFIG,
  maxAttemptsPerWord: 2,
  maxSilenceReminders: 2,
  waitExtendMs: 20_000,
  offerPauseOnProlongedSilence: true,
};

export interface PageContext {
  readonly sessionId: string;
  readonly pageId: string;
  readonly revisionId: string;
  readonly isLastPage: boolean;
}

export interface AutomationWord {
  readonly id: string;
  /** Từ này kết thúc bằng dấu câu: cho phép ngắt hơi lâu hơn. */
  readonly punctAfter?: boolean;
}

export interface AutomationState {
  readonly phase: AutomationPhase;
  readonly settings: AutomationSettings;
  readonly config: AutomationConfig;
  readonly ended: boolean;
  /** Bé/phụ huynh/nền/hiện diện đã dừng: không tự mở mic hay phát tiếng. */
  readonly userStopped: boolean;
  readonly page: PageContext | null;
  /** Mỗi lần mở mic là một lượt (run); kết quả của lượt cũ bị bỏ. */
  readonly runId: number;
  readonly listening: boolean;
  readonly words: readonly AutomationWord[];
  readonly wordStates: Readonly<Record<string, AutomationWordState>>;
  readonly cursor: number;
  readonly attempts: Readonly<Record<string, number>>;
  readonly helped: readonly string[];
  readonly needsPractice: readonly string[];
  /** Words the app encouraged the child past after the allowed attempts. */
  readonly gaveUp: readonly string[];
  readonly stuckWordId: string | null;
  readonly unsure: boolean;
  readonly paceMs: number;
  readonly listenStartedAt: number;
  readonly lastEvidenceAt: number;
  readonly lastSpeechAt: number;
  readonly lastInterventionAt: number;
  readonly promptsThisPage: number;
  readonly promptedAtCursor: number;
  readonly modeling: {
    readonly gen: number;
    readonly wordId: string | null;
  } | null;
  readonly modelGen: number;
  readonly awaitingRetryWordId: string | null;
  readonly pendingErrorCheckAt: number | null;
  readonly resumeListenAt: number | null;
  readonly lingerUntil: number | null;
  readonly offline: boolean;
  readonly permissionMissing: boolean;
  /** Khóa idempotent đang lưu / đã lưu của trang hiện tại. */
  readonly save: {
    readonly key: string;
    readonly status: "idle" | "inflight" | "saved";
    readonly attempts: number;
    readonly retryAt: number | null;
  };
  readonly pageTurnAt: number | null;
  /** TURN_PAGE already issued during this visit to the page. */
  readonly turnIssued: boolean;
  /** Pages (session:page:revision) whose first reading is already persisted. */
  readonly savedKeys: readonly string[];
  readonly completionRequested: boolean;
  readonly pauseReason: PauseReason | null;
  readonly waitUntilAt: number | null;
  readonly silenceReminders: number;
  readonly silencePauseOffered: boolean;
  readonly extraRetries: Readonly<Record<string, number>>;
  readonly lastGivenUpWordId: string | null;
  readonly disambiguationCandidates: readonly string[] | null;
}

export type PauseReason =
  "child" | "parent" | "background" | "presence" | "voice";

export type AutomationEvent =
  | {
      readonly type: "START_PAGE";
      readonly at: number;
      readonly page: PageContext;
      readonly words: readonly AutomationWord[];
      /** Vị trí đã lưu (số từ đã xong) hoặc 0. */
      readonly startIndex?: number;
      /** Tự động sau khi chuyển trang: bị bỏ nếu bé đã dừng. */
      readonly auto?: boolean;
    }
  | {
      readonly type: "LISTEN_RESULT";
      readonly at: number;
      readonly runId: number;
      readonly ok: boolean;
      readonly reason?: "permission" | "unavailable";
    }
  | {
      readonly type: "SPEECH_ACTIVITY";
      readonly at: number;
      readonly runId: number;
      readonly holdMs?: number;
    }
  | {
      readonly type: "WORD_EVIDENCE";
      readonly at: number;
      readonly runId: number;
      readonly pageId: string;
      readonly revisionId: string;
      readonly wordId: string;
      readonly outcome: "correct" | "retry" | "skipped";
    }
  | {
      readonly type: "UNSURE_POSITION";
      readonly at: number;
      readonly runId: number;
    }
  | {
      readonly type: "HELP_REQUEST";
      readonly at: number;
      readonly scope: "word" | "phrase";
      readonly source: "voice" | "button";
    }
  | { readonly type: "MODEL_ENDED"; readonly at: number; readonly gen: number }
  | { readonly type: "MODEL_FAILED"; readonly at: number; readonly gen: number }
  | { readonly type: "PAUSE"; readonly at: number; readonly by: PauseReason }
  | {
      readonly type: "RESUME";
      readonly at: number;
      readonly autoListen?: boolean;
    }
  | {
      readonly type: "PERMISSION";
      readonly at: number;
      readonly granted: boolean;
    }
  | { readonly type: "NETWORK"; readonly at: number; readonly online: boolean }
  | {
      readonly type: "SAVE_RESULT";
      readonly at: number;
      readonly key: string;
      readonly ok: boolean;
    }
  | { readonly type: "MANUAL_NEXT"; readonly at: number }
  | { readonly type: "SESSION_END"; readonly at: number }
  | {
      readonly type: "SET_SETTINGS";
      readonly at: number;
      readonly settings: Partial<AutomationSettings>;
    }
  | {
      readonly type: "WAIT_REQUESTED";
      readonly at: number;
      readonly extendMs?: number;
    }
  | {
      readonly type: "TRY_MORE_REQUESTED";
      readonly at: number;
      readonly wordId?: string;
    }
  | {
      readonly type: "DISAMBIGUATION_NEEDED";
      readonly at: number;
      readonly candidates: readonly [string, string];
    }
  | {
      readonly type: "DISAMBIGUATION_RESOLVED";
      readonly at: number;
      readonly wordId: string;
    }
  | { readonly type: "QUIZ_START"; readonly at: number }
  | { readonly type: "QUIZ_END"; readonly at: number }
  | { readonly type: "RECOVER_START"; readonly at: number }
  | { readonly type: "RECOVER_END"; readonly at: number }
  | { readonly type: "TICK"; readonly at: number };

export type ModelKind =
  | "hint"
  | "word"
  | "slow-word"
  | "phrase"
  | "orient"
  | "prompt"
  | "encourage"
  | "clarify";

export type AutomationMessage =
  | "gentle-prompt"
  | "encourage"
  | "unsaved"
  | "saved"
  | "offline"
  | "recovered"
  | "permission-needed"
  | "paused"
  | "page-ready"
  | "book-complete"
  | "wait-extended"
  | "offer-pause"
  | "recovering";

export type AutomationEffect =
  | { readonly type: "START_LISTENING"; readonly runId: number }
  | {
      readonly type: "STOP_LISTENING";
      readonly reason: "pause" | "model" | "page" | "end" | "permission";
    }
  | {
      readonly type: "PLAY_MODEL";
      readonly gen: number;
      readonly kind: ModelKind;
      readonly wordId: string | null;
      readonly wordIds: readonly string[];
      /** Tốc độ tương đối: 1 = bình thường, < 1 = chậm, rõ hơn. */
      readonly speed: number;
    }
  | { readonly type: "STOP_AUDIO" }
  | {
      readonly type: "SAVE_PAGE";
      readonly key: string;
      readonly attempt: number;
    }
  | { readonly type: "TURN_PAGE"; readonly key: string }
  | { readonly type: "FINISH_SESSION" }
  | { readonly type: "GIVE_UP_WORD"; readonly wordId: string }
  | { readonly type: "SHOW"; readonly message: AutomationMessage }
  | { readonly type: "NEEDS_PRACTICE"; readonly wordId: string };

export interface ReduceResult {
  readonly state: AutomationState;
  readonly effects: readonly AutomationEffect[];
}

export function pageKey(page: PageContext): string {
  return `${page.sessionId}:${page.pageId}:${page.revisionId}`;
}

export function createAutomationState(
  settings: AutomationSettings = { assist: true, autoAdvance: true },
  config: AutomationConfig = DEFAULT_AUTOMATION_CONFIG,
): AutomationState {
  return {
    phase: "idle",
    settings,
    config,
    ended: false,
    userStopped: false,
    page: null,
    runId: 0,
    listening: false,
    words: [],
    wordStates: {},
    cursor: 0,
    attempts: {},
    helped: [],
    needsPractice: [],
    gaveUp: [],
    stuckWordId: null,
    unsure: false,
    paceMs: config.initialPaceMs,
    listenStartedAt: 0,
    lastEvidenceAt: 0,
    lastSpeechAt: -Infinity,
    lastInterventionAt: -Infinity,
    promptsThisPage: 0,
    promptedAtCursor: -1,
    modeling: null,
    modelGen: 0,
    awaitingRetryWordId: null,
    pendingErrorCheckAt: null,
    resumeListenAt: null,
    lingerUntil: null,
    offline: false,
    permissionMissing: false,
    save: { key: "", status: "idle", attempts: 0, retryAt: null },
    pageTurnAt: null,
    turnIssued: false,
    savedKeys: [],
    completionRequested: false,
    pauseReason: null,
    waitUntilAt: null,
    silenceReminders: 0,
    silencePauseOffered: false,
    extraRetries: {},
    lastGivenUpWordId: null,
    disambiguationCandidates: null,
  };
}

const unchanged = (state: AutomationState): ReduceResult => ({
  state,
  effects: [],
});

function hesitationThreshold(state: AutomationState): number {
  const { config } = state;
  const base = Math.min(
    config.hesitationMaxMs,
    Math.max(config.hesitationMinMs, state.paceMs * config.paceMultiplier),
  );
  const previous = state.words[state.cursor - 1];
  return previous?.punctAfter ? base * config.punctuationFactor : base;
}

function indexOfWord(state: AutomationState, wordId: string): number {
  return state.words.findIndex((word) => word.id === wordId);
}

function isPageDone(state: AutomationState): boolean {
  return state.words.length > 0 && state.cursor >= state.words.length;
}

function lastActivityAt(state: AutomationState): number {
  return Math.max(
    state.lastEvidenceAt,
    state.lastSpeechAt,
    state.listenStartedAt,
    state.waitUntilAt ?? -Infinity,
  );
}

function isSpeechActive(state: AutomationState, at: number): boolean {
  return at - state.lastSpeechAt < state.config.speechQuietMs;
}

/** Interventions need a live, un-stopped, online, un-paused reading context. */
function canIntervene(state: AutomationState): boolean {
  return (
    !state.ended &&
    !state.userStopped &&
    !state.offline &&
    !state.permissionMissing &&
    !state.silencePauseOffered &&
    state.page !== null &&
    !isPageDone(state) &&
    state.modeling === null &&
    (state.phase === "listening" ||
      state.phase === "evidence" ||
      state.phase === "awaiting-retry")
  );
}

function withWordState(
  state: AutomationState,
  wordId: string,
  value: AutomationWordState,
): AutomationState {
  return { ...state, wordStates: { ...state.wordStates, [wordId]: value } };
}

function addUnique(list: readonly string[], value: string): readonly string[] {
  return list.includes(value) ? list : [...list, value];
}

function ladderKind(
  attempt: number,
  unsure: boolean,
  maxAttemptsPerWord: number,
): ModelKind {
  if (unsure && attempt <= 1) return "orient";
  if (maxAttemptsPerWord <= 2) {
    if (attempt <= 1) return "hint";
    return "phrase";
  }
  if (attempt <= 1) return "word";
  if (attempt === 2) return "slow-word";
  return "phrase";
}

/**
 * Bậc thang hỗ trợ cho một từ: đọc mẫu từ → đọc chậm, rõ hơn → đọc cụm có từ →
 * hết lượt thì động viên, cho qua và lưu "Cần luyện lại".
 */
function startHelp(
  inputState: AutomationState,
  wordId: string,
  at: number,
  effects: AutomationEffect[],
  options: { readonly forcedKind?: ModelKind } = {},
): AutomationState {
  const attempt = (inputState.attempts[wordId] ?? 0) + 1;
  const maxAttempts =
    inputState.config.maxAttemptsPerWord +
    (inputState.extraRetries[wordId] ?? 0);
  let state: AutomationState = {
    ...inputState,
    attempts: { ...inputState.attempts, [wordId]: attempt },
    lastInterventionAt: at,
    pendingErrorCheckAt: null,
    disambiguationCandidates: null,
  };

  if (attempt > maxAttempts) {
    // Encourage, let the child move on, never colour the word green.
    state = withWordState(state, wordId, "skipped");
    state = {
      ...state,
      cursor: Math.max(state.cursor, indexOfWord(state, wordId) + 1),
      needsPractice: addUnique(state.needsPractice, wordId),
      gaveUp: addUnique(state.gaveUp, wordId),
      lastGivenUpWordId: wordId,
      stuckWordId: null,
      awaitingRetryWordId: null,
      pendingErrorCheckAt: null,
      unsure: false,
    };
    effects.push({ type: "GIVE_UP_WORD", wordId });
    effects.push({ type: "NEEDS_PRACTICE", wordId });
    effects.push({ type: "SHOW", message: "encourage" });
    const gen = state.modelGen + 1;
    state = {
      ...state,
      modelGen: gen,
      modeling: { gen, wordId: null },
      phase: "modeling",
    };
    effects.push({ type: "STOP_LISTENING", reason: "model" });
    effects.push({
      type: "PLAY_MODEL",
      gen,
      kind: "encourage",
      wordId: null,
      wordIds: [],
      speed: 1,
    });
    return state;
  }

  const kind =
    options.forcedKind ??
    ladderKind(attempt, state.unsure, state.config.maxAttemptsPerWord);
  const index = indexOfWord(state, wordId);
  const phraseSpan = kind === "phrase" || kind === "orient" ? 3 : 1;
  const wordIds = state.words
    .slice(Math.max(0, index), Math.max(0, index) + phraseSpan)
    .map((word) => word.id);
  const gen = state.modelGen + 1;
  state = {
    ...state,
    modelGen: gen,
    modeling: { gen, wordId },
    phase: kind === "hint" ? "hinting" : "modeling",
    stuckWordId: wordId,
    awaitingRetryWordId: null,
    helped: [
      ...state.helped,
      ...wordIds.filter((id) => !state.helped.includes(id)),
    ],
    unsure: false,
  };
  effects.push({ type: "STOP_LISTENING", reason: "model" });
  effects.push({
    type: "PLAY_MODEL",
    gen,
    kind,
    wordId,
    wordIds,
    speed: kind === "slow-word" ? 0.75 : 1,
  });
  return state;
}

function startListeningEffect(
  state: AutomationState,
  at: number,
  effects: AutomationEffect[],
): AutomationState {
  const runId = state.runId + 1;
  effects.push({ type: "START_LISTENING", runId });
  return {
    ...state,
    runId,
    listening: false,
    listenStartedAt: at,
    resumeListenAt: null,
  };
}

function requestCompletion(
  state: AutomationState,
  at: number,
  effects: AutomationEffect[],
): AutomationState {
  if (!state.page || state.completionRequested) return state;
  const key = pageKey(state.page);
  if (state.save.key === key && state.save.status !== "idle") return state;
  if (state.savedKeys.includes(key)) {
    // Re-reading an already persisted page is practice: the first result is
    // kept and nothing is saved (or reported) twice.
    return afterPageSaved(
      {
        ...state,
        completionRequested: true,
        save: { key, status: "saved", attempts: 0, retryAt: null },
      },
      at,
      effects,
    );
  }
  effects.push({ type: "SAVE_PAGE", key, attempt: 1 });
  return {
    ...state,
    completionRequested: true,
    save: { key, status: "inflight", attempts: 1, retryAt: null },
    resumeListenAt: null,
    pendingErrorCheckAt: null,
  };
}

function afterPageSaved(
  state: AutomationState,
  at: number,
  effects: AutomationEffect[],
): AutomationState {
  effects.push({ type: "SHOW", message: "saved" });
  if (state.userStopped) return { ...state, phase: "paused" };
  if (state.settings.autoAdvance) {
    return {
      ...state,
      phase: "page-turn",
      pageTurnAt: at + state.config.autoAdvanceDelayMs,
    };
  }
  effects.push({ type: "SHOW", message: "page-ready" });
  return { ...state, phase: "page-turn", pageTurnAt: null };
}

function turnPage(
  state: AutomationState,
  effects: AutomationEffect[],
): AutomationState {
  if (!state.page) return state;
  const key = pageKey(state.page);
  if (state.turnIssued) return { ...state, pageTurnAt: null };
  effects.push({ type: "STOP_LISTENING", reason: "page" });
  if (state.page.isLastPage) {
    effects.push({ type: "SHOW", message: "book-complete" });
    effects.push({ type: "FINISH_SESSION" });
    return {
      ...state,
      turnIssued: true,
      pageTurnAt: null,
      phase: "complete",
      ended: true,
      listening: false,
    };
  }
  effects.push({ type: "TURN_PAGE", key });
  return {
    ...state,
    turnIssued: true,
    pageTurnAt: null,
    listening: false,
    phase: "ready",
  };
}

export function reduce(
  state: AutomationState,
  event: AutomationEvent,
): ReduceResult {
  if (state.ended && event.type !== "SET_SETTINGS") return unchanged(state);
  const effects: AutomationEffect[] = [];
  const at = event.at;

  switch (event.type) {
    case "SET_SETTINGS": {
      const settings = { ...state.settings, ...event.settings };
      let next: AutomationState = { ...state, settings };
      if (!settings.autoAdvance) next = { ...next, pageTurnAt: null };
      if (
        settings.autoAdvance &&
        next.phase === "page-turn" &&
        next.save.status === "saved" &&
        !next.userStopped &&
        next.pageTurnAt === null &&
        !next.turnIssued
      ) {
        next = { ...next, pageTurnAt: at + next.config.autoAdvanceDelayMs };
      }
      return { state: next, effects };
    }

    case "START_PAGE": {
      if (event.auto && state.userStopped) return unchanged(state);
      const startIndex = Math.min(
        Math.max(0, event.startIndex ?? 0),
        event.words.length,
      );
      const wordStates: Record<string, AutomationWordState> = {};
      event.words.forEach((word, index) => {
        wordStates[word.id] = index < startIndex ? "correct" : "pending";
      });
      let next: AutomationState = {
        ...state,
        phase: "ready",
        userStopped: false,
        pauseReason: null,
        page: event.page,
        words: event.words,
        wordStates,
        cursor: startIndex,
        attempts: {},
        helped: [],
        needsPractice: [],
        gaveUp: [],
        stuckWordId: null,
        unsure: false,
        listenStartedAt: at,
        lastEvidenceAt: at,
        lastInterventionAt: -Infinity,
        promptsThisPage: 0,
        promptedAtCursor: -1,
        modeling: null,
        modelGen: state.modelGen + 1,
        awaitingRetryWordId: null,
        pendingErrorCheckAt: null,
        resumeListenAt: null,
        lingerUntil: null,
        pageTurnAt: null,
        turnIssued: false,
        completionRequested: false,
        permissionMissing: false,
        save: {
          key: pageKey(event.page),
          status: "idle",
          attempts: 0,
          retryAt: null,
        },
        waitUntilAt: null,
        silenceReminders: 0,
        silencePauseOffered: false,
        extraRetries: {},
        lastGivenUpWordId: null,
        disambiguationCandidates: null,
      };
      effects.push({ type: "STOP_AUDIO" });
      if (isPageDone(next)) {
        next = requestCompletion(next, at, effects);
        return { state: next, effects };
      }
      next = startListeningEffect(next, at, effects);
      return { state: next, effects };
    }

    case "LISTEN_RESULT": {
      if (event.runId !== state.runId || state.userStopped)
        return unchanged(state);
      if (event.ok) {
        const phase: AutomationPhase =
          state.phase === "ready" ||
          state.phase === "paused" ||
          state.phase === "offline" ||
          state.phase === "permission-needed"
            ? "listening"
            : state.phase;
        return {
          state: { ...state, listening: true, permissionMissing: false, phase },
          effects,
        };
      }
      if (event.reason === "permission") {
        effects.push({ type: "SHOW", message: "permission-needed" });
        return {
          state: {
            ...state,
            listening: false,
            permissionMissing: true,
            phase: "permission-needed",
          },
          effects,
        };
      }
      effects.push({ type: "SHOW", message: "offline" });
      return {
        state: {
          ...state,
          listening: false,
          phase: state.offline ? "offline" : "paused",
        },
        effects,
      };
    }

    case "PERMISSION": {
      if (!event.granted) {
        effects.push({ type: "STOP_LISTENING", reason: "permission" });
        effects.push({ type: "SHOW", message: "permission-needed" });
        return {
          state: {
            ...state,
            permissionMissing: true,
            listening: false,
            phase: "permission-needed",
          },
          effects,
        };
      }
      let next: AutomationState = { ...state, permissionMissing: false };
      if (
        !next.userStopped &&
        next.page &&
        !isPageDone(next) &&
        next.phase === "permission-needed"
      ) {
        next = { ...next, phase: "ready" };
        next = startListeningEffect(next, at, effects);
      }
      return { state: next, effects };
    }

    case "SPEECH_ACTIVITY": {
      if (event.runId !== state.runId) return unchanged(state);
      return {
        state: {
          ...state,
          lastSpeechAt: at,
          waitUntilAt:
            event.holdMs && event.holdMs > 0
              ? Math.max(state.waitUntilAt ?? 0, at + event.holdMs)
              : state.waitUntilAt,
          silenceReminders: 0,
          silencePauseOffered: false,
        },
        effects,
      };
    }

    case "UNSURE_POSITION": {
      if (event.runId !== state.runId) return unchanged(state);
      return { state: { ...state, unsure: true }, effects };
    }

    case "WORD_EVIDENCE": {
      if (
        !state.page ||
        state.userStopped ||
        event.runId !== state.runId ||
        event.pageId !== state.page.pageId ||
        event.revisionId !== state.page.revisionId
      ) {
        return unchanged(state);
      }
      const index = indexOfWord(state, event.wordId);
      if (index === -1) return unchanged(state);
      // Evidence arriving while the app speaks is never the child's reading.
      if (state.modeling) return unchanged(state);

      let next: AutomationState = {
        ...state,
        lastEvidenceAt: at,
        unsure: false,
        silenceReminders: 0,
        silencePauseOffered: false,
        waitUntilAt: null,
      };
      if (event.outcome === "correct") {
        const wasHelped = state.helped.includes(event.wordId);
        const gaveUp = state.gaveUp.includes(event.wordId);
        // Helped or given-up words are never plain green (I6).
        next = withWordState(
          next,
          event.wordId,
          gaveUp ? "skipped" : wasHelped ? "assisted" : "correct",
        );
        if (!wasHelped && !gaveUp) {
          // A self-corrected slip is no longer something to practise.
          next = {
            ...next,
            needsPractice: next.needsPractice.filter(
              (id) => id !== event.wordId,
            ),
          };
        }
        const gap = at - state.lastEvidenceAt;
        const paceMs = Math.min(
          6000,
          Math.max(300, state.paceMs * 0.7 + Math.max(0, gap) * 0.3),
        );
        next = {
          ...next,
          cursor: Math.max(next.cursor, index + 1),
          paceMs: gap > 0 ? paceMs : state.paceMs,
          attempts: { ...next.attempts },
          awaitingRetryWordId: null,
          pendingErrorCheckAt:
            state.stuckWordId === event.wordId
              ? null
              : state.pendingErrorCheckAt,
          stuckWordId:
            state.stuckWordId === event.wordId ? null : state.stuckWordId,
          promptedAtCursor: -1,
          phase: "evidence",
          lingerUntil: at + state.config.evidenceLingerMs,
        };
        // The child moved past an earlier unresolved error: stop waiting on it.
        if (
          state.stuckWordId &&
          indexOfWord(state, state.stuckWordId) < index
        ) {
          next = { ...next, stuckWordId: null, pendingErrorCheckAt: null };
        }
      } else if (event.outcome === "retry") {
        next = withWordState(next, event.wordId, "retry");
        const needs = addUnique(next.needsPractice, event.wordId);
        // An error on a helped word is still an error, never assisted-green.
        next = {
          ...next,
          needsPractice: needs,
          cursor: Math.max(next.cursor, index),
          stuckWordId: event.wordId,
          pendingErrorCheckAt:
            at +
            Math.max(
              state.config.selfCorrectWindowMs,
              Math.round(state.paceMs * 0.8),
            ),
          phase: "evidence",
          lingerUntil: at + state.config.evidenceLingerMs,
        };
      } else {
        next = withWordState(next, event.wordId, "skipped");
        next = {
          ...next,
          needsPractice: addUnique(next.needsPractice, event.wordId),
          cursor: Math.max(next.cursor, index + 1),
          phase: "evidence",
          lingerUntil: at + state.config.evidenceLingerMs,
        };
        effects.push({ type: "NEEDS_PRACTICE", wordId: event.wordId });
      }
      if (isPageDone(next) && !next.stuckWordId) {
        next = requestCompletion(next, at, effects);
      }
      return { state: next, effects };
    }

    case "HELP_REQUEST": {
      if (!state.page || isPageDone(state) || state.modeling)
        return unchanged(state);
      const word = state.words[Math.min(state.cursor, state.words.length - 1)];
      if (!word) return unchanged(state);
      let next = startHelp(state, word.id, at, effects, {
        forcedKind: event.scope === "phrase" ? "phrase" : undefined,
      });
      // Explicit child/parent requests are honoured even when automatic
      // assistance is off, but never re-open the mic after a stop.
      next = { ...next, promptsThisPage: next.promptsThisPage };
      return { state: next, effects };
    }

    case "MODEL_ENDED":
    case "MODEL_FAILED": {
      if (!state.modeling || event.gen !== state.modeling.gen)
        return unchanged(state);
      const wordId = state.modeling.wordId;
      let next: AutomationState = {
        ...state,
        modeling: null,
        lastInterventionAt: at,
        lastEvidenceAt: at,
        awaitingRetryWordId: wordId,
      };
      if (state.userStopped) {
        return { state: { ...next, phase: "paused" }, effects };
      }
      if (isPageDone(next)) {
        next = requestCompletion(next, at, effects);
        return { state: next, effects };
      }
      next = {
        ...next,
        phase: "awaiting-retry",
        resumeListenAt: at + state.config.resumeAfterModelMs,
      };
      return { state: next, effects };
    }

    case "PAUSE": {
      effects.push({ type: "STOP_AUDIO" });
      effects.push({ type: "STOP_LISTENING", reason: "pause" });
      effects.push({ type: "SHOW", message: "paused" });
      return {
        state: {
          ...state,
          userStopped: true,
          pauseReason: event.by,
          phase: "paused",
          listening: false,
          // Invalidate every callback and timer started before the stop.
          runId: state.runId + 1,
          modelGen: state.modelGen + 1,
          modeling: null,
          resumeListenAt: null,
          pendingErrorCheckAt: null,
          pageTurnAt: null,
          lingerUntil: null,
        },
        effects,
      };
    }

    case "RESUME": {
      if (!state.userStopped && state.phase !== "paused")
        return unchanged(state);
      let next: AutomationState = {
        ...state,
        userStopped: false,
        pauseReason: null,
        phase: "ready",
        lastEvidenceAt: at,
      };
      if (!next.page) return { state: { ...next, phase: "idle" }, effects };
      if (isPageDone(next)) {
        if (next.save.status === "saved") {
          next = afterPageSaved(next, at, effects);
        } else if (next.save.status === "idle") {
          next = requestCompletion(next, at, effects);
        }
        return { state: next, effects };
      }
      if (next.permissionMissing)
        return { state: { ...next, phase: "permission-needed" }, effects };
      if (event.autoListen !== false) {
        next = startListeningEffect(next, at, effects);
      }
      return { state: next, effects };
    }

    case "NETWORK": {
      if (!event.online) {
        if (state.offline) return unchanged(state);
        effects.push({ type: "SHOW", message: "offline" });
        return {
          state: {
            ...state,
            offline: true,
            phase:
              state.userStopped || state.phase === "page-turn"
                ? state.phase
                : "offline",
          },
          effects,
        };
      }
      if (!state.offline) return unchanged(state);
      effects.push({ type: "SHOW", message: "recovered" });
      let next: AutomationState = { ...state, offline: false };
      if (next.save.status === "inflight" && next.save.retryAt !== null) {
        next = { ...next, save: { ...next.save, retryAt: at } };
      }
      if (
        next.phase === "offline" &&
        !next.userStopped &&
        next.page &&
        !isPageDone(next)
      ) {
        next = { ...next, phase: "ready" };
        next = startListeningEffect(next, at, effects);
      }
      return { state: next, effects };
    }

    case "SAVE_RESULT": {
      if (
        !state.page ||
        event.key !== state.save.key ||
        state.save.status !== "inflight"
      ) {
        return unchanged(state);
      }
      if (event.ok) {
        let next: AutomationState = {
          ...state,
          savedKeys: addUnique(state.savedKeys, state.save.key),
          save: { ...state.save, status: "saved", retryAt: null },
        };
        next = afterPageSaved(next, at, effects);
        return { state: next, effects };
      }
      effects.push({ type: "SHOW", message: "unsaved" });
      const delay = Math.min(
        state.config.saveRetryMaxMs,
        state.config.saveRetryBaseMs *
          2 ** Math.max(0, state.save.attempts - 1),
      );
      return {
        state: {
          ...state,
          save: { ...state.save, retryAt: at + delay },
          // Never turn the page, never lose progress: stay on this page.
          pageTurnAt: null,
        },
        effects,
      };
    }

    case "MANUAL_NEXT": {
      if (!state.page || state.save.status !== "saved") return unchanged(state);
      return {
        state: turnPage({ ...state, userStopped: false }, effects),
        effects,
      };
    }

    case "SESSION_END": {
      effects.push({ type: "STOP_AUDIO" });
      effects.push({ type: "STOP_LISTENING", reason: "end" });
      return {
        state: {
          ...state,
          ended: true,
          phase: "complete",
          listening: false,
          runId: state.runId + 1,
          modelGen: state.modelGen + 1,
          modeling: null,
          resumeListenAt: null,
          pendingErrorCheckAt: null,
          pageTurnAt: null,
          lingerUntil: null,
          waitUntilAt: null,
        },
        effects,
      };
    }

    case "WAIT_REQUESTED": {
      if (state.ended || state.userStopped || !state.page) {
        return unchanged(state);
      }
      const extendMs = event.extendMs ?? state.config.waitExtendMs ?? 20_000;
      const wasModeling = state.modeling !== null;
      if (wasModeling) {
        effects.push({ type: "STOP_AUDIO" });
      }
      effects.push({ type: "SHOW", message: "wait-extended" });
      return {
        state: {
          ...state,
          phase:
            state.phase === "hinting" || state.phase === "modeling"
              ? "listening"
              : state.phase,
          modelGen: state.modelGen + 1,
          modeling: null,
          pendingErrorCheckAt: null,
          lingerUntil: null,
          waitUntilAt: at + extendMs,
          lastEvidenceAt: at,
          silenceReminders: 0,
          silencePauseOffered: false,
        },
        effects,
      };
    }

    case "TRY_MORE_REQUESTED": {
      if (state.ended || state.userStopped || !state.page) {
        return unchanged(state);
      }
      const targetWordId =
        event.wordId ??
        state.stuckWordId ??
        state.awaitingRetryWordId ??
        state.lastGivenUpWordId ??
        state.words[Math.max(0, Math.min(state.cursor, state.words.length - 1))]
          ?.id;
      if (!targetWordId) return unchanged(state);
      const targetIdx = indexOfWord(state, targetWordId);
      if (targetIdx === -1) return unchanged(state);

      const wasGivenUp = state.gaveUp.includes(targetWordId);
      let next: AutomationState = {
        ...state,
        extraRetries: {
          ...state.extraRetries,
          [targetWordId]: (state.extraRetries[targetWordId] ?? 0) + 1,
        },
        cursor: wasGivenUp ? Math.min(state.cursor, targetIdx) : state.cursor,
        gaveUp: state.gaveUp.filter((id) => id !== targetWordId),
        stuckWordId: targetWordId,
        awaitingRetryWordId: targetWordId,
        pendingErrorCheckAt: null,
        waitUntilAt: null,
        lastEvidenceAt: at,
        silenceReminders: 0,
        silencePauseOffered: false,
        phase: "awaiting-retry",
      };
      if (wasGivenUp || state.wordStates[targetWordId] === "skipped") {
        next = withWordState(next, targetWordId, "retry");
      }
      if (!next.listening && !next.modeling && !next.permissionMissing) {
        next = startListeningEffect(next, at, effects);
      }
      return { state: next, effects };
    }

    case "DISAMBIGUATION_NEEDED": {
      if (!state.page || state.userStopped || state.ended || state.modeling) {
        return unchanged(state);
      }
      const gen = state.modelGen + 1;
      effects.push({ type: "STOP_LISTENING", reason: "model" });
      effects.push({
        type: "PLAY_MODEL",
        gen,
        kind: "clarify",
        wordId: null,
        wordIds: event.candidates,
        speed: 1,
      });
      return {
        state: {
          ...state,
          modelGen: gen,
          modeling: { gen, wordId: null },
          phase: "hinting",
          pendingErrorCheckAt: null,
          disambiguationCandidates: event.candidates,
        },
        effects,
      };
    }

    case "DISAMBIGUATION_RESOLVED": {
      if (!state.page || state.userStopped || state.ended) {
        return unchanged(state);
      }
      const next = startHelp(
        { ...state, disambiguationCandidates: null },
        event.wordId,
        at,
        effects,
      );
      return { state: next, effects };
    }

    case "QUIZ_START": {
      effects.push({ type: "STOP_AUDIO" });
      effects.push({ type: "STOP_LISTENING", reason: "pause" });
      return {
        state: {
          ...state,
          phase: "quiz-listening",
          listening: false,
          runId: state.runId + 1,
          modelGen: state.modelGen + 1,
          modeling: null,
          pendingErrorCheckAt: null,
          resumeListenAt: null,
          lingerUntil: null,
          pageTurnAt: null,
          waitUntilAt: null,
        },
        effects,
      };
    }

    case "QUIZ_END": {
      effects.push({ type: "STOP_AUDIO" });
      effects.push({ type: "STOP_LISTENING", reason: "end" });
      return {
        state: {
          ...state,
          phase: "complete",
          ended: true,
          listening: false,
          runId: state.runId + 1,
          modelGen: state.modelGen + 1,
          modeling: null,
          pendingErrorCheckAt: null,
          resumeListenAt: null,
          lingerUntil: null,
          pageTurnAt: null,
          waitUntilAt: null,
        },
        effects,
      };
    }

    case "RECOVER_START": {
      effects.push({ type: "STOP_AUDIO" });
      effects.push({ type: "SHOW", message: "recovering" });
      return {
        state: {
          ...state,
          phase: "recovering",
          modelGen: state.modelGen + 1,
          modeling: null,
          pendingErrorCheckAt: null,
          lingerUntil: null,
          pageTurnAt: null,
        },
        effects,
      };
    }

    case "RECOVER_END": {
      if (state.phase !== "recovering" || state.userStopped || state.ended) {
        return unchanged(state);
      }
      let next: AutomationState = {
        ...state,
        phase: "ready",
        lastEvidenceAt: at,
      };
      if (next.page && !isPageDone(next) && !next.permissionMissing) {
        next = startListeningEffect(next, at, effects);
      }
      return { state: next, effects };
    }

    case "TICK":
      return tick(state, at);
  }
}

function tick(inputState: AutomationState, at: number): ReduceResult {
  const effects: AutomationEffect[] = [];
  let state = inputState;
  if (state.userStopped || state.ended) return unchanged(state);

  if (state.lingerUntil !== null && at >= state.lingerUntil) {
    state = {
      ...state,
      lingerUntil: null,
      phase: state.phase === "evidence" ? "listening" : state.phase,
    };
  }

  // Save retry (idempotent: same key, attempt counter only).
  if (
    state.save.status === "inflight" &&
    state.save.retryAt !== null &&
    at >= state.save.retryAt &&
    !state.offline
  ) {
    const attempt = state.save.attempts + 1;
    effects.push({ type: "SAVE_PAGE", key: state.save.key, attempt });
    state = {
      ...state,
      save: { ...state.save, attempts: attempt, retryAt: null },
    };
    return { state, effects };
  }

  if (
    state.pageTurnAt !== null &&
    at >= state.pageTurnAt &&
    state.settings.autoAdvance
  ) {
    state = turnPage(state, effects);
    return { state, effects };
  }

  if (
    state.resumeListenAt !== null &&
    at >= state.resumeListenAt &&
    state.modeling === null
  ) {
    if (
      !state.offline &&
      !state.permissionMissing &&
      state.page &&
      !isPageDone(state)
    ) {
      state = startListeningEffect(state, at, effects);
      state = { ...state, phase: "awaiting-retry" };
    } else {
      state = { ...state, resumeListenAt: null };
    }
    return { state, effects };
  }

  if (!canIntervene(state)) return { state, effects };
  // Never interrupt a child who is speaking right now (I5).
  if (isSpeechActive(state, at)) return { state, effects };

  // Reading error followed by silence: help only if the child is stuck.
  if (
    state.pendingErrorCheckAt !== null &&
    at >= state.pendingErrorCheckAt &&
    state.stuckWordId &&
    state.settings.assist
  ) {
    state = startHelp(state, state.stuckWordId, at, effects);
    return { state, effects };
  }

  // Hesitation: one gentle prompt, then the sample if the child is still stuck.
  if (state.settings.assist) {
    if (state.waitUntilAt !== null && at < state.waitUntilAt) {
      return { state, effects };
    }
    const plan = hesitationPlan(state);
    const word = state.words[Math.min(state.cursor, state.words.length - 1)];
    if (word && plan && at >= plan.dueAt) {
      const maxReminders =
        state.config.maxSilenceReminders ?? state.config.maxPromptsPerPage;
      if (
        state.config.offerPauseOnProlongedSilence &&
        maxReminders > 0 &&
        state.silenceReminders >= maxReminders
      ) {
        effects.push({ type: "SHOW", message: "offer-pause" });
        state = {
          ...state,
          silencePauseOffered: true,
          lastInterventionAt: at,
        };
        return { state, effects };
      }
      if (plan.mode === "prompt") {
        const gen = state.modelGen + 1;
        effects.push({ type: "SHOW", message: "gentle-prompt" });
        effects.push({ type: "STOP_LISTENING", reason: "model" });
        effects.push({
          type: "PLAY_MODEL",
          gen,
          kind: "prompt",
          wordId: word.id,
          wordIds: [],
          speed: 1,
        });
        state = {
          ...state,
          modelGen: gen,
          modeling: { gen, wordId: null },
          phase: "modeling",
          promptsThisPage: state.promptsThisPage + 1,
          silenceReminders: state.silenceReminders + 1,
          promptedAtCursor: state.cursor,
          lastInterventionAt: at,
          awaitingRetryWordId: null,
        };
        return { state, effects };
      }
      const nextReminders = state.silenceReminders + 1;
      state = {
        ...startHelp(state, word.id, at, effects),
        silenceReminders: nextReminders,
      };
      return { state, effects };
    }
  }
  return { state, effects };
}

/**
 * Khi nào cần can thiệp vì bé ngập ngừng, và bằng cách nào:
 * - lần đầu im lặng quá ngưỡng thích ứng với nhịp đọc: nhắc nhẹ (có giới hạn
 *   số lần và thời gian nghỉ giữa hai lời nhắc);
 * - đã nhắc rồi mà vẫn im: đọc mẫu sau `promptToHelpMs`;
 * - đã đọc mẫu rồi mà vẫn im: sang bậc tiếp theo sau một ngưỡng nữa.
 */
function hesitationPlan(
  state: AutomationState,
): { dueAt: number; mode: "prompt" | "help" } | null {
  if (!state.page || isPageDone(state)) return null;
  const { config } = state;
  const base = lastActivityAt(state);
  const threshold = hesitationThreshold(state);
  if (state.awaitingRetryWordId !== null) {
    return { dueAt: base + threshold, mode: "help" };
  }
  if (state.promptedAtCursor === state.cursor) {
    return { dueAt: base + config.promptToHelpMs, mode: "help" };
  }
  if (state.promptsThisPage >= config.maxPromptsPerPage) {
    return { dueAt: base + threshold, mode: "help" };
  }
  return {
    dueAt: Math.max(
      base + threshold,
      state.lastInterventionAt + config.promptCooldownMs,
    ),
    mode: "prompt",
  };
}
/**
 * Mốc thời gian sớm nhất cần đánh thức bộ điều phối (hoặc null). Dùng cho
 * runtime để chỉ giữ một timer; hàm thuần nên kiểm thử được.
 */
export function nextWakeAt(state: AutomationState, now: number): number | null {
  if (state.ended || state.userStopped) return null;
  const candidates: number[] = [];
  if (state.lingerUntil !== null) candidates.push(state.lingerUntil);
  if (
    state.save.status === "inflight" &&
    state.save.retryAt !== null &&
    !state.offline
  ) {
    candidates.push(state.save.retryAt);
  }
  if (state.pageTurnAt !== null && state.settings.autoAdvance)
    candidates.push(state.pageTurnAt);
  if (state.resumeListenAt !== null) candidates.push(state.resumeListenAt);
  if (canIntervene(state)) {
    const quietAt = state.lastSpeechAt + state.config.speechQuietMs;
    const gate = (time: number) => Math.max(time, quietAt);
    if (
      state.pendingErrorCheckAt !== null &&
      state.stuckWordId &&
      state.settings.assist
    ) {
      candidates.push(gate(state.pendingErrorCheckAt));
    }
    if (state.settings.assist) {
      const plan = hesitationPlan(state);
      if (plan) {
        const due =
          state.waitUntilAt !== null
            ? Math.max(plan.dueAt, state.waitUntilAt)
            : plan.dueAt;
        candidates.push(gate(due));
      }
    }
  }
  if (!candidates.length) return null;
  return Math.max(now, Math.min(...candidates));
}

// ---------------------------------------------------------------------------
// Runtime: reducer + one timer + I/O ports.
// ---------------------------------------------------------------------------

export interface AutomationClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AutomationPorts {
  startListening(
    runId: number,
  ): Promise<{ ok: boolean; reason?: "permission" | "unavailable" }>;
  stopListening(reason: string): void;
  playModel(
    effect: Extract<AutomationEffect, { type: "PLAY_MODEL" }>,
  ): Promise<void>;
  stopAudio(): void;
  savePage(key: string, attempt: number): Promise<boolean>;
  turnPage(key: string): void;
  finishSession(): void;
  giveUpWord(wordId: string): void;
  needsPractice(wordId: string): void;
  show(message: AutomationMessage): void;
}

export class ReadingAutomationRuntime {
  private state: AutomationState;
  private timer: unknown = null;
  private disposed = false;
  readonly log: AutomationEffect[] = [];

  constructor(
    private readonly clock: AutomationClock,
    private readonly ports: AutomationPorts,
    settings?: AutomationSettings,
    config?: AutomationConfig,
  ) {
    this.state = createAutomationState(settings, config);
  }

  getState(): AutomationState {
    return this.state;
  }

  dispatch(event: DistributiveOmitAt<AutomationEvent>): void {
    if (this.disposed) return;
    this.apply({ ...event, at: this.clock.now() } as AutomationEvent);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private apply(event: AutomationEvent): void {
    const result = reduce(this.state, event);
    this.state = result.state;
    for (const effect of result.effects) {
      this.log.push(effect);
      this.run(effect);
    }
    this.arm();
  }

  private arm(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.disposed) return;
    const now = this.clock.now();
    const wake = nextWakeAt(this.state, now);
    if (wake === null) return;
    this.timer = this.clock.setTimeout(
      () => {
        this.timer = null;
        this.apply({ type: "TICK", at: this.clock.now() });
      },
      Math.max(0, wake - now),
    );
  }

  private run(effect: AutomationEffect): void {
    const ports = this.ports;
    switch (effect.type) {
      case "START_LISTENING":
        void ports.startListening(effect.runId).then(
          (result) =>
            this.dispatch({
              type: "LISTEN_RESULT",
              runId: effect.runId,
              ok: result.ok,
              reason: result.reason,
            }),
          () =>
            this.dispatch({
              type: "LISTEN_RESULT",
              runId: effect.runId,
              ok: false,
              reason: "unavailable",
            }),
        );
        break;
      case "STOP_LISTENING":
        ports.stopListening(effect.reason);
        break;
      case "PLAY_MODEL":
        void ports.playModel(effect).then(
          () => this.dispatch({ type: "MODEL_ENDED", gen: effect.gen }),
          () => this.dispatch({ type: "MODEL_FAILED", gen: effect.gen }),
        );
        break;
      case "STOP_AUDIO":
        ports.stopAudio();
        break;
      case "SAVE_PAGE":
        void ports.savePage(effect.key, effect.attempt).then(
          (ok) => this.dispatch({ type: "SAVE_RESULT", key: effect.key, ok }),
          () =>
            this.dispatch({ type: "SAVE_RESULT", key: effect.key, ok: false }),
        );
        break;
      case "TURN_PAGE":
        ports.turnPage(effect.key);
        break;
      case "FINISH_SESSION":
        ports.finishSession();
        break;
      case "GIVE_UP_WORD":
        ports.giveUpWord(effect.wordId);
        break;
      case "NEEDS_PRACTICE":
        ports.needsPractice(effect.wordId);
        break;
      case "SHOW":
        ports.show(effect.message);
        break;
    }
  }
}

type DistributiveOmitAt<T> = T extends unknown ? Omit<T, "at"> : never;
