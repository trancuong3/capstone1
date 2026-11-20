/** Safe, read-only rendering of backend-verified VietOCR runtime evidence.
 *
 * Legacy scan metadata and arbitrary API strings are untrusted. Never present
 * registry values or stored object paths as proof of the loaded checkpoint.
 */
export type SafeOcrRuntimeProvenance = {
  modelProfile: string;
  checkpointSha256: string | null;
  modelLoadStatus: string;
  modelInferenceStatus: string;
  fallbackReason: string | null;
  engineVersion: string | null;
  verified: boolean;
};

const PROFILES = new Set([
  "ORIGINAL",
  "FLOW1_EXTERNAL_TRDG",
  "FLOW2_ADMIN_VERIFIED",
  "FLOW1_VERIFIED",
  "FLOW2_EXTERNAL_TRDG",
]);
const LOAD_STATUSES = new Set([
  "loaded",
  "stale_loaded",
  "fallback_loaded",
  "not_run",
  "unavailable",
  "unverified",
]);
const INFERENCE_STATUSES = new Set([
  "success",
  "error",
  "no_result",
  "not_run",
  "not_installed",
  "not_initialized",
  "disabled",
]);
const SAFE_REASONS = new Set([
  "invalid_original_registry_pointer",
  "unsupported_model_profile",
  "checkpoint_unavailable_or_invalid",
  "model_initialization_failed",
  "requested_checkpoint_not_loaded",
  "vietocr_inference_error",
  "vietocr_no_result",
  "vietocr_unavailable",
  "paddle_unavailable",
  "paddle_no_text",
  "paddle_inference_error",
  "tesseract_fallback",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeOcrRuntimeProvenance(
  metadata: Record<string, unknown>,
): SafeOcrRuntimeProvenance {
  const runtime = record(metadata.vietocr_runtime_provenance);
  if (runtime?.provenance_version !== "vietocr_loaded_checkpoint_v1") {
    return {
      modelProfile: "Chưa có bằng chứng runtime (revision cũ)",
      checkpointSha256: null,
      modelLoadStatus: "unverified",
      modelInferenceStatus: "not_run",
      fallbackReason: null,
      engineVersion: null,
      verified: false,
    };
  }

  const status =
    typeof runtime.model_load_status === "string" &&
    LOAD_STATUSES.has(runtime.model_load_status)
      ? runtime.model_load_status
      : "unverified";
  const profile =
    typeof runtime.model_profile === "string" &&
    PROFILES.has(runtime.model_profile)
      ? runtime.model_profile
      : null;
  const checkpoint =
    typeof runtime.checkpoint_sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(runtime.checkpoint_sha256)
      ? runtime.checkpoint_sha256
      : null;
  const verified =
    profile !== null &&
    checkpoint !== null &&
    (status === "loaded" ||
      status === "stale_loaded" ||
      status === "fallback_loaded");
  const reason =
    typeof runtime.fallback_reason === "string" &&
    SAFE_REASONS.has(runtime.fallback_reason)
      ? runtime.fallback_reason
      : null;
  const engineVersion =
    typeof runtime.engine_version === "string" &&
    /^[0-9A-Za-z._+-]{1,40}$/u.test(runtime.engine_version)
      ? runtime.engine_version
      : null;
  return {
    modelProfile: verified ? profile : "Chưa xác minh checkpoint thực tế",
    checkpointSha256: verified ? checkpoint : null,
    modelLoadStatus: status,
    modelInferenceStatus:
      typeof runtime.model_inference_status === "string" &&
      INFERENCE_STATUSES.has(runtime.model_inference_status)
        ? runtime.model_inference_status
        : "not_run",
    fallbackReason: reason,
    engineVersion,
    verified,
  };
}
