import type { UUID } from "@/types/profile";

export type SentenceShooterDifficulty = "easy" | "medium" | "challenge";
export type SentenceShooterStatus = "IN_PROGRESS" | "COMPLETED" | "ABANDONED";

export interface SentenceShooterBookDTO {
  readonly id: UUID;
  readonly name: string | null;
  readonly title: string;
  readonly author: string | null;
  readonly min_grade: number;
  readonly max_grade: number;
  readonly available_rounds: number;
}

export interface SentenceShooterTokenDTO {
  readonly id: UUID;
  readonly text: string;
}

export interface SentenceShooterRoundDTO {
  readonly round_id: UUID;
  readonly round_number: number;
  readonly token_count: number;
  readonly tokens: readonly SentenceShooterTokenDTO[];
}

export interface SentenceShooterSessionDTO {
  readonly session_id: UUID;
  readonly book: SentenceShooterBookDTO;
  readonly difficulty: SentenceShooterDifficulty;
  readonly total_rounds: number;
  readonly completed_rounds: number;
  readonly total_stars: number;
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
  readonly completed_sentence: string | null;
  readonly message: string;
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
}
