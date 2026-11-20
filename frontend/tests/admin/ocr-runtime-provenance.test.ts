import { describe, expect, it } from "vitest";

import { safeOcrRuntimeProvenance } from "@/lib/ocr/runtime-provenance";

const SHA_FLOW1 = "a".repeat(64);
const SHA_FLOW2 = "b".repeat(64);

function scan(
  profile: string,
  checkpoint_sha256: string | null,
  model_load_status = "loaded",
  fallback_reason: string | null = null,
) {
  return {
    engine: "paddleocr_vietocr_dual",
    vietocr_runtime_provenance: {
      provenance_version: "vietocr_loaded_checkpoint_v1",
      model_profile: profile,
      checkpoint_sha256,
      model_load_status,
      fallback_reason,
      engine_version: "0.3.12",
      model_inference_status: "success",
    },
  };
}

describe("Admin OCR runtime checkpoint diagnostics", () => {
  it("shows a verified Original checkpoint", () => {
    const evidence = safeOcrRuntimeProvenance(scan("ORIGINAL", SHA_FLOW1));
    expect(evidence.verified).toBe(true);
    expect(evidence.modelProfile).toBe("ORIGINAL");
    expect(evidence.checkpointSha256).toBe(SHA_FLOW1);
  });

  it("distinguishes verified Flow 1 from Flow 2", () => {
    const flow1 = safeOcrRuntimeProvenance(
      scan("FLOW1_EXTERNAL_TRDG", SHA_FLOW1),
    );
    const flow2 = safeOcrRuntimeProvenance(
      scan("FLOW2_ADMIN_VERIFIED", SHA_FLOW2),
    );
    expect(flow1.modelProfile).toBe("FLOW1_EXTERNAL_TRDG");
    expect(flow2.modelProfile).toBe("FLOW2_ADMIN_VERIFIED");
    expect(flow1.checkpointSha256).not.toEqual(flow2.checkpointSha256);
  });

  it("makes stale loaded Flow 1 and reason explicit, not Flow 2", () => {
    const evidence = safeOcrRuntimeProvenance(
      scan(
        "FLOW1_EXTERNAL_TRDG",
        SHA_FLOW1,
        "stale_loaded",
        "checkpoint_unavailable_or_invalid",
      ),
    );
    expect(evidence.modelLoadStatus).toBe("stale_loaded");
    expect(evidence.fallbackReason).toBe("checkpoint_unavailable_or_invalid");
    expect(evidence.modelProfile).toBe("FLOW1_EXTERNAL_TRDG");
  });

  it("hides SHA and profile when metadata has no loaded runtime proof", () => {
    const evidence = safeOcrRuntimeProvenance(
      scan("FLOW1_EXTERNAL_TRDG", SHA_FLOW1, "unverified"),
    );
    expect(evidence.verified).toBe(false);
    expect(evidence.checkpointSha256).toBeNull();
    expect(evidence.modelProfile).not.toContain("FLOW1");
  });

  it("does not mistake a registry pointer for Predictor provenance", () => {
    const evidence = safeOcrRuntimeProvenance({
      active_model: {
        profile: "FLOW2_ADMIN_VERIFIED",
        checkpoint_sha256: SHA_FLOW2,
        storage_path: "private/signed-url",
      },
    });
    expect(evidence.verified).toBe(false);
    expect(evidence.checkpointSha256).toBeNull();
  });

  it("fails closed for invalid SHA, version, and arbitrary secret-like text", () => {
    const evidence = safeOcrRuntimeProvenance({
      vietocr_runtime_provenance: {
        provenance_version: "vietocr_loaded_checkpoint_v1",
        model_profile: "FLOW1_EXTERNAL_TRDG",
        checkpoint_sha256: "https://private.example/secret?token=test",
        model_load_status: "loaded",
        model_inference_status: "success",
        engine_version: "secret=do-not-display",
        fallback_reason: "https://signed.example/secret",
      },
    });
    expect(evidence.verified).toBe(false);
    expect(evidence.checkpointSha256).toBeNull();
    expect(evidence.engineVersion).toBeNull();
    expect(evidence.fallbackReason).toBeNull();
  });

  it("retains safe not-run and fallback reason for a Tesseract scan", () => {
    const evidence = safeOcrRuntimeProvenance(
      scan("ORIGINAL", null, "not_run", "paddle_unavailable"),
    );
    expect(evidence.verified).toBe(false);
    expect(evidence.modelLoadStatus).toBe("not_run");
    expect(evidence.fallbackReason).toBe("paddle_unavailable");
  });

  it("keeps legacy Scan metadata unverified", () => {
    const evidence = safeOcrRuntimeProvenance({
      engine: "paddleocr_vietocr_dual",
      engine_version: "PP-OCRv4 + VietOCR-vgg_transformer",
    });
    expect(evidence.verified).toBe(false);
    expect(evidence.checkpointSha256).toBeNull();
  });
});
