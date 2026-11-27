"""Standalone Local Image-Gen Sidecar for ViRead AI Smart Book Studio V2 (Wave 2C).

EXECUTION BOUNDARY:
- Executed EXCLUSIVELY by the isolated venv at `F:\\c1\\tools\\image-gen-runtime\\.venv`.
- NEVER imported by `backend/app/` (Render Free 512 MiB invariant).
- Zero database, Supabase, or cloud API secrets required.
- Strictly binds loopback `127.0.0.1:8090` by default.
- Enforces serial execution (`max_concurrency = 1`) and 4 GB VRAM optimizations:
  - Auto-detects GTX 16xx (TU117/TU116, e.g. GTX 1650/1660/1630, or
    `VIREAD_LOCAL_SD_FORCE_FP32=1`): loads compact `variant="fp16"` weights into
    `dtype=torch.float32` (prevents GTX 1650 fp16 UNet NaNs), fuses and unloads
    LoRA (`fuse_lora()` + `unload_lora_weights()`), keeps native PyTorch 2.x SDPA
    (never overrides SDPA with legacy `enable_attention_slicing()`), enables
    `vae.enable_slicing()` + `vae.enable_tiling()`, and uses
    `enable_sequential_cpu_offload()` (`< 800 MiB` peak VRAM on GTX 1650).
  - For RTX / Ampere+ GPUs: uses `dtype=torch.float16`, native SDPA, VAE slicing
    + tiling, and `enable_model_cpu_offload()`.
  - Calls `torch.cuda.empty_cache()` after every generation.

MODEL MODES (configurable via env):
1. Default 4 GB / Drive-F-friendly mode (verified by v2-image-gen-lab):
   `Lykon/dreamshaper-8` (fp16) + `latent-consistency/lcm-lora-sdv1-5`
   (or local cached dirs under `F:\\c1\\tools\\image-gen-runtime\\hf-cache\\`).
2. Single-repo LCM mode:
   `VIREAD_IMAGE_GEN_MODEL_ID=SimianLuo/LCM_Dreamshaper_v7` with
   `VIREAD_IMAGE_GEN_LCM_LORA=""` (empty string disables LoRA fusion).
"""
import argparse
import base64
import gc
from io import BytesIO
import logging
import os
from pathlib import Path
import random
import threading
import time
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger("viread.local_image_gen_worker")
HTTP_422 = getattr(status, "HTTP_422_UNPROCESSABLE_CONTENT", 422)

DEFAULT_RUNTIME_DIR = Path(
    os.getenv("VIREAD_IMAGE_GEN_RUNTIME_DIR", r"F:\c1\tools\image-gen-runtime")
)
DEFAULT_BASE_MODEL_REPO = "Lykon/dreamshaper-8"
DEFAULT_LCM_LORA_REPO = "latent-consistency/lcm-lora-sdv1-5"
DEFAULT_SINGLE_LCM_REPO = "SimianLuo/LCM_Dreamshaper_v7"
DEFAULT_NEGATIVE_PROMPT = (
    "text, letters, words, numbers, watermark, signature, logo, typography, "
    "captions, speech bubbles, title, blurry, scary"
)
MAX_GENERATION_PIXELS = 768 * 1024
_UNSAFE_PROMPT_TOKENS = (
    "blood",
    "gore",
    "weapon",
    "nude",
    "naked",
    "sexual",
    "kill",
    "murder",
    "violence",
    "bạo lực",
    "máu me",
    "kinh dị",
    "khỏa thân",
    "vũ khí",
    "chết chóc",
)


def _resolve_model_config() -> tuple[str, str | None, str]:
    """Return `(base_model_source, lcm_lora_source_or_none, display_model_id)`."""
    explicit_model = (os.getenv("VIREAD_IMAGE_GEN_MODEL_ID") or "").strip()
    explicit_lora_env = os.getenv("VIREAD_IMAGE_GEN_LCM_LORA")

    if explicit_model:
        # If user explicitly chose single-repo SimianLuo/LCM_Dreamshaper_v7 and did not set LoRA,
        # default LoRA to None.
        if explicit_lora_env is None:
            lora_source = (
                None
                if "lcm_dreamshaper" in explicit_model.lower()
                else DEFAULT_LCM_LORA_REPO
            )
        else:
            lora_source = explicit_lora_env.strip() or None
        display = f"{explicit_model}+{lora_source}" if lora_source else explicit_model
        return explicit_model, lora_source, display

    # Prefer verified local fp16 cache on Drive F: when provisioned
    hf_cache_dir = Path(os.getenv("HF_HOME") or (DEFAULT_RUNTIME_DIR / "hf-cache"))
    local_base = hf_cache_dir / "dreamshaper-8-fp16"
    local_lora = hf_cache_dir / "lcm-lora-sdv1-5"
    if local_base.is_dir() and local_lora.is_dir():
        lora_val = (
            (explicit_lora_env.strip() or None)
            if explicit_lora_env is not None
            else str(local_lora)
        )
        display = (
            f"{DEFAULT_BASE_MODEL_REPO}+{DEFAULT_LCM_LORA_REPO}"
            if lora_val
            else DEFAULT_BASE_MODEL_REPO
        )
        return str(local_base), lora_val, display

    lora_fallback = (
        (explicit_lora_env.strip() or None)
        if explicit_lora_env is not None
        else DEFAULT_LCM_LORA_REPO
    )
    display = (
        f"{DEFAULT_BASE_MODEL_REPO}+{lora_fallback}"
        if lora_fallback
        else DEFAULT_BASE_MODEL_REPO
    )
    return DEFAULT_BASE_MODEL_REPO, lora_fallback, display


class GenerateImageRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    prompt: str = Field(..., min_length=1, max_length=2000)
    negative_prompt: str = Field(default=DEFAULT_NEGATIVE_PROMPT, max_length=1000)
    width: int = Field(default=512, ge=256, le=1024)
    height: int = Field(default=768, ge=256, le=1024)
    steps: int = Field(default=4, ge=1, le=12)
    seed: int | None = Field(default=None)
    guidance_scale: float | None = Field(default=None, ge=0.0, le=10.0)
    response_format: Literal["json", "png", "webp"] = "json"


class GenerateImageResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    image_base64: str
    mime_type: str
    width: int
    height: int
    elapsed_ms: int
    model_id: str
    seed: int


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ok: bool
    model_id: str
    device: str
    vram_free_mb: int | None = None
    ready: bool
    busy: bool = False
    pipeline_loaded: bool = False


_GTX_16XX_SUBSTRINGS = ("1650", "1660", "1630")


def _env_truthy(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _detect_gpu_profile(torch_mod: Any) -> tuple[bool, bool, str]:
    """Return `(use_cuda, use_fp32_sequential, gpu_name)` for the active device.

    GTX 16xx (TU117/TU116, no Tensor Cores) suffers fp16 UNet NaNs and benefits
    from loading compact fp16 weights in float32 + sequential CPU offload while
    preserving native PyTorch 2.x SDPA.
    """
    use_cuda = bool(torch_mod.cuda.is_available())
    if not use_cuda:
        return False, True, "cpu"
    try:
        gpu_name = str(torch_mod.cuda.get_device_name(0) or "")
    except Exception:
        gpu_name = ""
    lowered = gpu_name.lower()
    is_gtx_16xx = any(token in lowered for token in _GTX_16XX_SUBSTRINGS)
    force_fp32 = _env_truthy("VIREAD_LOCAL_SD_FORCE_FP32", default=False)
    return True, (is_gtx_16xx or force_fp32), gpu_name


def _has_fp16_variant_files(base_model: str) -> bool:
    base_path = Path(base_model)
    if base_path.is_dir():
        return any(base_path.rglob("*.fp16.safetensors")) or any(
            base_path.rglob("*.fp16.bin")
        )
    return "dreamshaper-8" in base_model.lower()


def _supports_pytorch_sdpa(torch_mod: Any) -> bool:
    nn_mod = getattr(torch_mod, "nn", None)
    functional_mod = getattr(nn_mod, "functional", None)
    return hasattr(functional_mod, "scaled_dot_product_attention")


class LocalDiffusersRuntime:
    """Lazy-loading, serial-locked SD 1.5 + LCM runtime engineered for 4 GB VRAM GPUs."""

    def __init__(self) -> None:
        self._base_model, self._lora_model, self.model_id = _resolve_model_config()
        self._lock = threading.Lock()
        self._busy = False
        self._pipeline: Any = None
        self._device: str = "cpu"
        self._compute_dtype: str = "float32"
        self._offload_mode: str = "cpu"
        self._load_error: str | None = None

    def probe_device_status(self) -> tuple[str, int | None]:
        """Inspect CUDA availability and free VRAM without allocating tensors or loading weights."""
        try:
            import torch

            if torch.cuda.is_available():
                free_bytes, _total_bytes = torch.cuda.mem_get_info(0)
                return "cuda", int(free_bytes // (1024 * 1024))
            return "cpu", None
        except Exception:
            return "cpu", None

    def health_snapshot(self) -> HealthResponse:
        device, vram_free_mb = self.probe_device_status()
        self._device = device
        return HealthResponse(
            ok=self._load_error is None,
            model_id=self.model_id,
            device=device,
            vram_free_mb=vram_free_mb,
            ready=self._load_error is None,
            busy=self._busy,
            pipeline_loaded=self._pipeline is not None,
        )

    def _ensure_pipeline_loaded(self) -> Any:
        if self._pipeline is not None:
            return self._pipeline

        import torch
        from diffusers import LCMScheduler, StableDiffusionPipeline

        use_cuda, use_fp32_sequential, gpu_name = _detect_gpu_profile(torch)
        self._device = "cuda" if use_cuda else "cpu"
        dtype = torch.float32 if (not use_cuda or use_fp32_sequential) else torch.float16
        self._compute_dtype = "float32" if dtype == torch.float32 else "float16"

        load_kwargs: dict[str, Any] = {
            "dtype": dtype,
            "safety_checker": None,
            "feature_extractor": None,
            "requires_safety_checker": False,
        }
        is_local_dir = Path(self._base_model).is_dir()
        if is_local_dir:
            load_kwargs["local_files_only"] = True
        if _has_fp16_variant_files(self._base_model):
            # Compact fp16 safetensors on disk loaded cleanly into fp32 (GTX 16xx) or fp16 (RTX)
            load_kwargs["variant"] = "fp16"

        try:
            pipe = StableDiffusionPipeline.from_pretrained(self._base_model, **load_kwargs)
        except TypeError:
            # Compatibility fallback for diffusers < 0.35 expecting torch_dtype
            legacy_kwargs = dict(load_kwargs)
            legacy_kwargs["torch_dtype"] = legacy_kwargs.pop("dtype")
            try:
                pipe = StableDiffusionPipeline.from_pretrained(self._base_model, **legacy_kwargs)
            except Exception:
                legacy_kwargs.pop("variant", None)
                pipe = StableDiffusionPipeline.from_pretrained(self._base_model, **legacy_kwargs)
        except Exception:
            load_kwargs.pop("variant", None)
            pipe = StableDiffusionPipeline.from_pretrained(self._base_model, **load_kwargs)

        pipe.scheduler = LCMScheduler.from_config(pipe.scheduler.config)

        if self._lora_model:
            lora_kwargs: dict[str, Any] = {}
            if Path(self._lora_model).is_dir():
                lora_kwargs["local_files_only"] = True
            pipe.load_lora_weights(self._lora_model, **lora_kwargs)
            if hasattr(pipe, "fuse_lora"):
                pipe.fuse_lora()
            if hasattr(pipe, "unload_lora_weights"):
                pipe.unload_lora_weights()

        # Preserve native PyTorch 2.x O(N) SDPA — NEVER call enable_attention_slicing()
        # when PyTorch SDPA is available (it regresses to O(N^2) SlicedAttnProcessor & OOMs on 4 GB VRAM).
        if not _supports_pytorch_sdpa(torch) and hasattr(pipe, "enable_attention_slicing"):
            pipe.enable_attention_slicing()

        # Enable VAE slicing + tiling (diffusers 0.43+ exposes them on pipe.vae)
        vae = getattr(pipe, "vae", None)
        if vae is not None and hasattr(vae, "enable_slicing"):
            vae.enable_slicing()
        elif hasattr(pipe, "enable_vae_slicing"):
            pipe.enable_vae_slicing()

        if vae is not None and hasattr(vae, "enable_tiling"):
            vae.enable_tiling()
        elif hasattr(pipe, "enable_vae_tiling"):
            pipe.enable_vae_tiling()

        if use_cuda and use_fp32_sequential and hasattr(pipe, "enable_sequential_cpu_offload"):
            pipe.enable_sequential_cpu_offload()
            self._offload_mode = "sequential_cpu_offload"
            logger.info(
                "Loaded local SD pipeline in fp32 + sequential_cpu_offload for GPU '%s'",
                gpu_name or "cuda",
            )
        elif use_cuda and hasattr(pipe, "enable_model_cpu_offload"):
            pipe.enable_model_cpu_offload()
            self._offload_mode = "model_cpu_offload"
            logger.info(
                "Loaded local SD pipeline in fp16 + model_cpu_offload for GPU '%s'",
                gpu_name or "cuda",
            )
        else:
            pipe.to("cuda" if use_cuda else "cpu")
            self._offload_mode = "cuda" if use_cuda else "cpu"

        self._pipeline = pipe
        self._load_error = None
        return pipe

    def generate(
        self,
        *,
        prompt: str,
        negative_prompt: str,
        width: int,
        height: int,
        steps: int,
        seed: int | None,
        guidance_scale: float | None,
        output_format: Literal["PNG", "WEBP"] = "PNG",
    ) -> tuple[bytes, str, int, int, int, int]:
        """Generate one image under strict serial GPU lock (max concurrency = 1)."""
        aligned_w = max(256, (int(width) // 8) * 8)
        aligned_h = max(256, (int(height) // 8) * 8)
        if aligned_w * aligned_h > MAX_GENERATION_PIXELS:
            raise HTTPException(
                status_code=HTTP_422,
                detail="IMAGE_DIMENSIONS_EXCEED_4GB_VRAM_LIMIT",
            )

        used_seed = int(seed) if seed is not None else random.randint(1, 2_147_483_646)
        effective_guidance = 1.5 if guidance_scale is None else float(guidance_scale)
        started = time.perf_counter()

        with self._lock:
            self._busy = True
            try:
                import torch

                pipe = self._ensure_pipeline_loaded()
                gen_device = (
                    "cpu"
                    if (self._offload_mode == "sequential_cpu_offload" or not torch.cuda.is_available())
                    else "cuda"
                )
                generator = torch.Generator(device=gen_device).manual_seed(used_seed)

                with torch.inference_mode():
                    result = pipe(
                        prompt=prompt,
                        negative_prompt=negative_prompt,
                        width=aligned_w,
                        height=aligned_h,
                        num_inference_steps=max(1, min(12, int(steps))),
                        guidance_scale=effective_guidance,
                        generator=generator,
                    )
                pil_image = result.images[0]
                buf = BytesIO()
                if output_format == "WEBP":
                    pil_image.save(buf, format="WEBP", quality=86, method=6)
                    mime_type = "image/webp"
                else:
                    pil_image.save(buf, format="PNG")
                    mime_type = "image/png"
                elapsed_ms = max(1, int((time.perf_counter() - started) * 1000))
                return (
                    buf.getvalue(),
                    mime_type,
                    pil_image.width,
                    pil_image.height,
                    elapsed_ms,
                    used_seed,
                )
            except HTTPException:
                raise
            except Exception as exc:
                self._load_error = type(exc).__name__
                logger.exception("Local image generation failed")
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=f"LOCAL_IMAGE_GEN_FAILED:{type(exc).__name__}",
                ) from exc
            finally:
                self._busy = False
                try:
                    import torch

                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except Exception:
                    pass
                gc.collect()


def _validate_safe_prompt(prompt: str) -> str:
    cleaned = prompt.strip()
    lowered = cleaned.lower()
    if any(token in lowered for token in _UNSAFE_PROMPT_TOKENS):
        raise HTTPException(
            status_code=HTTP_422,
            detail="UNSAFE_PROMPT_CONTENT",
        )
    return cleaned


def create_app(runtime: LocalDiffusersRuntime | None = None) -> FastAPI:
    active_runtime = runtime or LocalDiffusersRuntime()
    worker_app = FastAPI(
        title="ViRead Local Image-Gen Sidecar",
        version="2.0.0",
        docs_url=None,
        redoc_url=None,
    )
    worker_app.state.runtime = active_runtime

    @worker_app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return active_runtime.health_snapshot()

    @worker_app.post("/generate", response_model=None)
    def generate(payload: GenerateImageRequest, request: Request) -> Response | GenerateImageResponse:
        safe_prompt = _validate_safe_prompt(payload.prompt)
        accept = (request.headers.get("accept") or "").lower()
        want_binary = payload.response_format in ("png", "webp") or (
            accept.startswith("image/") and payload.response_format == "json"
        )
        fmt: Literal["PNG", "WEBP"] = (
            "WEBP"
            if (payload.response_format == "webp" or "image/webp" in accept)
            else "PNG"
        )
        image_bytes, mime_type, out_w, out_h, elapsed_ms, used_seed = active_runtime.generate(
            prompt=safe_prompt,
            negative_prompt=payload.negative_prompt,
            width=payload.width,
            height=payload.height,
            steps=payload.steps,
            seed=payload.seed,
            guidance_scale=payload.guidance_scale,
            output_format=fmt,
        )
        if want_binary:
            return Response(
                content=image_bytes,
                media_type=mime_type,
                headers={
                    "Cache-Control": "no-store",
                    "X-Content-Type-Options": "nosniff",
                    "X-ViRead-Elapsed-Ms": str(elapsed_ms),
                    "X-ViRead-Seed": str(used_seed),
                },
            )
        return GenerateImageResponse(
            image_base64=base64.b64encode(image_bytes).decode("ascii"),
            mime_type=mime_type,
            width=out_w,
            height=out_h,
            elapsed_ms=elapsed_ms,
            model_id=active_runtime.model_id,
            seed=used_seed,
        )

    return worker_app


app = create_app()


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="ViRead Local Image-Gen Sidecar Worker")
    parser.add_argument(
        "--host",
        default=os.getenv("VIREAD_IMAGE_GEN_HOST", "127.0.0.1"),
        help="Bind host (defaults to loopback 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("VIREAD_IMAGE_GEN_PORT", "8090")),
        help="Bind port (defaults to 8090)",
    )
    parser.add_argument(
        "--allow-lan",
        action="store_true",
        help="Explicit opt-in to bind non-loopback address",
    )
    parser.add_argument(
        "--preload",
        action="store_true",
        help="Eagerly load diffusion pipeline before serving requests",
    )
    return parser.parse_args()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = _parse_args()
    allow_lan = args.allow_lan or (
        os.getenv("LOCAL_IMAGE_GEN_ALLOW_LAN", "").strip().lower() in {"1", "true", "yes", "on"}
    )
    if args.host not in ("127.0.0.1", "localhost", "::1") and not allow_lan:
        raise SystemExit(
            f"Refusing non-loopback bind '{args.host}' without --allow-lan or LOCAL_IMAGE_GEN_ALLOW_LAN=true"
        )
    if args.preload:
        app.state.runtime._ensure_pipeline_loaded()

    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, workers=1, log_level="info")


if __name__ == "__main__":
    main()
