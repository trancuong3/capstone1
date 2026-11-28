export type PictureSourceType = "BOOK_PAGE" | "CUSTOM_UPLOAD" | "SAMPLE";
export type PictureSessionStatus = "ACTIVE" | "COMPLETED";
export type PictureInputMode = "VOICE" | "TEXT";
export type PictureEvaluationSource = "AI" | "FALLBACK";
export type PictureTeachingMode =
  "OBSERVE" | "VOCABULARY" | "SENTENCE" | "STORY" | "INFER" | "CREATE";
export type PictureScaffoldingStep =
  "PRAISE" | "EXPAND" | "PROMPT" | "NEXT_CHALLENGE";
export type PictureProviderTier =
  | "CURATED"
  | "GEMINI_PRIMARY"
  | "GEMINI_FALLBACK"
  | "GROQ_FREE"
  | "LOCAL_OLLAMA"
  | "DETERMINISTIC_FALLBACK";

export interface PictureVocabItemDTO {
  readonly word: string;
  readonly hint: string;
}

export interface PictureSampleItemDTO {
  readonly sample_key: string;
  readonly title: string;
  readonly theme: string;
  readonly description: string;
  readonly image_url: string;
  readonly matched_difficult_words?: readonly string[];
}

export interface PictureBookPageItemDTO {
  readonly book_id: string;
  readonly book_title: string;
  readonly page_id: string;
  readonly page_number: number;
  readonly image_url: string;
  readonly matched_difficult_words?: readonly string[];
  readonly has_verified_illustration?: boolean;
  readonly page_kind?: string | null;
  readonly ocr_excerpt?: string | null;
}

export interface PictureCatalogDTO {
  readonly samples: readonly PictureSampleItemDTO[];
  readonly book_pages: readonly PictureBookPageItemDTO[];
  readonly focus_difficult_words?: readonly string[];
  readonly recommended_sample_key?: string | null;
  readonly recommended_book_page_id?: string | null;
}

export interface PictureGuideDTO {
  readonly is_child_safe: boolean;
  readonly scene_title: string;
  readonly scene_summary: string;
  readonly guiding_questions: readonly string[];
  readonly suggested_vocabulary: readonly PictureVocabItemDTO[];
  readonly model_sample_sentences: readonly string[];
  readonly teaching_mode?: PictureTeachingMode;
  readonly target_words?: readonly string[];
}

export interface PictureEvaluationFeedbackDTO {
  readonly is_relevant: boolean;
  readonly score_out_of_10: number;
  readonly stars: number;
  readonly matched_details: readonly string[];
  readonly missed_details: readonly string[];
  readonly praise_message: string;
  readonly improvement_tip: string;
  readonly upgraded_sentences: readonly string[];
  readonly vocabulary_highlights: readonly string[];
  readonly teaching_mode?: PictureTeachingMode;
  readonly scaffolding_step?: PictureScaffoldingStep | null;
  readonly next_prompt_question?: string | null;
  readonly used_target_words?: readonly string[];
  readonly practiced_difficult_words?: readonly string[];
  readonly provider_tier?: PictureProviderTier | null;
}

export interface PictureAttemptDTO {
  readonly attempt_id: string;
  readonly attempt_number: number;
  readonly input_mode: PictureInputMode;
  readonly transcript_text: string;
  readonly score_out_of_10: number;
  readonly stars: number;
  readonly evaluation_source?: PictureEvaluationSource;
  readonly provider_tier?: PictureProviderTier | null;
  readonly practiced_difficult_words?: readonly string[];
  readonly feedback: PictureEvaluationFeedbackDTO;
  readonly created_at: string;
}

export interface PictureSessionDTO {
  readonly session_id: string;
  readonly child_id: string;
  readonly child_grade: number;
  readonly source_type: PictureSourceType;
  readonly sample_key: string | null;
  readonly book_id: string | null;
  readonly book_page_id: string | null;
  readonly image_url: string;
  readonly scene_title: string;
  readonly status: PictureSessionStatus;
  readonly best_stars: number;
  readonly best_score: number;
  readonly attempts_count: number;
  readonly teaching_mode?: PictureTeachingMode;
  readonly target_words?: readonly string[];
  readonly target_vocabulary?: readonly string[];
  readonly practiced_difficult_words?: readonly string[];
  readonly provider_tier?: PictureProviderTier | null;
  readonly guide: PictureGuideDTO;
  readonly attempts: readonly PictureAttemptDTO[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PictureSessionSummaryDTO {
  readonly session_id: string;
  readonly child_id: string;
  readonly source_type: PictureSourceType;
  readonly sample_key?: string | null;
  readonly book_page_id?: string | null;
  readonly scene_title: string;
  readonly image_url: string;
  readonly status: PictureSessionStatus;
  readonly best_stars: number;
  readonly best_score: number;
  readonly attempts_count: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PictureEvaluateResponseDTO {
  readonly session: PictureSessionDTO;
  readonly latest_attempt: PictureAttemptDTO;
  readonly practiced_difficult_words?: readonly string[];
}
