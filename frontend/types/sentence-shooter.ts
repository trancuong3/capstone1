import type { UUID } from "@/types/profile";

export type SentenceShooterDifficulty = "easy" | "medium" | "challenge";
export type SentenceShooterLearningMode =
  "WORD_ORDER" | "FILL_BLANK" | "GRAMMAR_FOCUS";
export type SentenceShooterStatus = "IN_PROGRESS" | "COMPLETED" | "ABANDONED";

export interface SentenceShooterBookDTO {
  readonly id: UUID;
  readonly name: string | null;
  readonly title: string;
  readonly author: string | null;
  readonly min_grade: number;
  readonly max_grade: number;
  readonly available_rounds: number;
  readonly matched_difficult_words?: readonly string[];
}

export interface SentenceShooterTokenDTO {
  readonly id: UUID;
  readonly text: string;
  readonly is_difficult_word?: boolean;
}

export interface SentenceShooterPromptSlotDTO {
  readonly position: number;
  readonly text: string | null;
  readonly is_blank: boolean;
  readonly is_difficult_word?: boolean;
}

export interface SentenceShooterRoundDTO {
  readonly round_id: UUID;
  readonly round_number: number;
  readonly token_count: number;
  readonly tokens: readonly SentenceShooterTokenDTO[];
  readonly learning_mode?: SentenceShooterLearningMode;
  readonly prompt_slots?: readonly SentenceShooterPromptSlotDTO[];
  readonly practiced_difficult_words?: readonly string[];
  readonly prompt_hint?: string | null;
}

export interface SentenceShooterSessionDTO {
  readonly session_id: UUID;
  readonly book: SentenceShooterBookDTO;
  readonly difficulty: SentenceShooterDifficulty;
  readonly learning_mode?: SentenceShooterLearningMode;
  readonly total_rounds: number;
  readonly completed_rounds: number;
  readonly total_stars: number;
  readonly practiced_difficult_words?: readonly string[];
  readonly round: SentenceShooterRoundDTO;
}

export interface SentenceShooterShotDTO {
  readonly is_correct: boolean;
  readonly correct_count: number;
  readonly token_count: number;
  readonly mistakes_total: number;
  readonly completed_rounds: number;
  readonly total_stars: number;
  readonly round_completed: boolean;
  readonly session_completed: boolean;
  readonly next_expected_position: number;
  readonly stars_awarded: number;
  readonly score?: number;
  readonly completed_sentence: string | null;
  readonly next_round?: SentenceShooterRoundDTO | null;
  readonly message: string;
  readonly client_shot_id?: string | null;
  readonly learning_mode?: SentenceShooterLearningMode;
  readonly grammar_tip?: string | null;
  readonly practiced_difficult_words?: readonly string[];
}

export interface SentenceShooterHintDTO {
  readonly target_token_id: UUID;
  readonly hint_count: number;
  readonly message: string;
}

export interface SentenceShooterNextRoundDTO {
  readonly session_id: UUID;
  readonly completed_rounds: number;
  readonly total_rounds: number;
  readonly total_stars: number;
  readonly round: SentenceShooterRoundDTO;
}

export interface SentenceShooterResultDTO {
  readonly session_id: UUID;
  readonly book: SentenceShooterBookDTO;
  readonly difficulty: SentenceShooterDifficulty;
  readonly learning_mode?: SentenceShooterLearningMode;
  readonly status: SentenceShooterStatus;
  readonly total_rounds: number;
  readonly completed_rounds: number;
  readonly correct_count: number;
  readonly mistakes_total: number;
  readonly hint_count: number;
  readonly total_stars: number;
  readonly duration_seconds: number;
  readonly started_at: string;
  readonly completed_at: string | null;
  readonly practiced_difficult_words?: readonly string[];
}
