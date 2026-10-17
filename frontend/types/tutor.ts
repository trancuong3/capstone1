export interface TutorExplainWordRequest {
  readonly page_revision_id: string;
  readonly word_id: string;
}

export interface TutorWordSelection extends TutorExplainWordRequest {
  readonly word: string;
}

export interface TutorExplanationDTO extends TutorWordSelection {
  readonly explanation: string;
  readonly reading_hint: string;
}

export type AiTutorState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly result: TutorExplanationDTO }
  | {
      readonly status: "error";
      readonly message: string;
      readonly retryable: boolean;
    };
