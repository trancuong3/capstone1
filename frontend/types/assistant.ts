export type AssistantRoleScope = "public" | "parent" | "admin";

export type BandwidthProfile = "low" | "medium" | "high";

export type BandwidthPreference = "auto" | "low" | "high";

export type AssistantSourceTier =
  | "cache"
  | "tier_0_kb"
  | "tier_1_cloud"
  | "tier_2_ollama"
  | "tier_3_fallback"
  | "offline";

export type AssistantVisibilityState = "open" | "minimized" | "hidden";

export interface AssistantQuickAction {
  readonly label: string;
  readonly href: string;
}

export interface AssistantNavigationOffer {
  readonly label: string;
  readonly href: string;
  readonly reason?: string | null;
}

export interface AssistantHistoryTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface AssistantChatRequest {
  readonly message: string;
  readonly current_path: string;
  readonly locale: string;
  readonly bandwidth_profile: BandwidthProfile;
  readonly history: readonly AssistantHistoryTurn[];
  readonly force_llm?: boolean;
}

export interface AssistantChatResponse {
  readonly reply: string;
  readonly source_tier: AssistantSourceTier;
  readonly provider_id: string;
  readonly model_id: string | null;
  readonly bandwidth_applied: BandwidthProfile;
  readonly latency_ms: number;
  readonly cached: boolean;
  readonly role_scope: AssistantRoleScope;
  readonly quick_actions: readonly AssistantQuickAction[];
  readonly suggested_prompts: readonly string[];
  readonly navigation_offer?: AssistantNavigationOffer | null;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly messagePath?: string;
  readonly sourceTier?: AssistantSourceTier;
  readonly providerId?: string;
  readonly modelId?: string | null;
  readonly latencyMs?: number;
  readonly cached?: boolean;
  readonly roleScope?: AssistantRoleScope;
  readonly quickActions?: readonly AssistantQuickAction[];
  readonly suggestedPrompts?: readonly string[];
  readonly navigationOffer?: AssistantNavigationOffer | null;
  readonly navigationDecision?: "pending" | "accepted" | "declined";
  readonly canDeepenWithAi?: boolean;
  readonly canRetryOnline?: boolean;
  readonly sourcePrompt?: string;
}

export interface DetectedNetworkInfo {
  readonly online: boolean;
  readonly profile: BandwidthProfile;
  readonly effectiveType: string | null;
  readonly saveData: boolean;
  readonly rtt?: number | null;
}
