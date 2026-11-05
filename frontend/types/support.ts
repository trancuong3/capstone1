export type SupportFeedbackCategory =
  | "technical_issue"
  | "feature_feedback"
  | "account_support"
  | "how_to"
  | "feature_request"
  | "other";

export interface SupportFeedbackRequest {
  readonly category: SupportFeedbackCategory;
  readonly subject: string;
  readonly message: string;
  readonly contact_email: string;
}

export interface SupportFeedbackResponse {
  readonly accepted: true;
  readonly delivery_status: "accepted_by_smtp";
  readonly detail: string;
}
