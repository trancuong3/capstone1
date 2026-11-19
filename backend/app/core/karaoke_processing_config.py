"""Independent karaoke worker settings; never changes OCR or speech settings."""
from dataclasses import dataclass
import os
from pathlib import Path


class KaraokeConfigurationError(ValueError):
    pass


def _boolean(env, name, default=False):
    value = env.get(name, str(default)).strip().lower()
    if value not in {"true", "false", "1", "0"}:
        raise KaraokeConfigurationError(name)
    return value in {"true", "1"}


def _integer(env, name, default, minimum=1, maximum=86400):
    try:
        raw = env.get(name, str(default))
        if not raw or not str(raw).isascii() or not str(raw).isdigit():
            raise ValueError()
        value = int(raw)
        if not minimum <= value <= maximum:
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise KaraokeConfigurationError(name) from None


@dataclass(frozen=True)
class KaraokeProcessingConfig:
    enabled: bool = False
    worker_enabled: bool = False
    pipeline_version: str = ""
    alignment_provider: str = "local_ctc"
    stem_provider: str = "demucs"
    python_path: str = ""
    engine_script: str = ""
    model_path: str = ""
    stem_model_path: str = ""
    temp_dir: str = ""
    concurrency: int = 1
    lease_seconds: int = 120
    heartbeat_seconds: int = 20
    poll_seconds: int = 2
    max_safe_attempts: int = 2
    max_per_admin: int = 2
    max_global: int = 10
    reserved_minutes_admin_day: int = 0
    reserved_minutes_global_day: int = 0
    queue_warning_seconds: int = 120
    provider_timeout_seconds: int = 180

    @classmethod
    def from_env(cls, env=None):
        env = os.environ if env is None else env
        enabled = _boolean(env, "KARAOKE_PROCESSING_ENABLED")
        worker = _boolean(env, "KARAOKE_PROCESSING_WORKER_ENABLED")
        values = dict(
            enabled=enabled, worker_enabled=worker,
            pipeline_version=env.get("KARAOKE_PROCESSING_PIPELINE_VERSION", "").strip(),
            alignment_provider=env.get("KARAOKE_ALIGNMENT_PROVIDER", "local_ctc").strip(),
            stem_provider=env.get("KARAOKE_STEM_PROVIDER", "demucs").strip(),
            python_path=env.get("KARAOKE_LOCAL_PYTHON", "").strip(),
            engine_script=env.get("KARAOKE_LOCAL_ENGINE_SCRIPT", "").strip(),
            model_path=env.get("KARAOKE_LOCAL_MODEL_PATH", "").strip(),
            stem_model_path=env.get("KARAOKE_LOCAL_STEM_MODEL_PATH", "").strip(),
            temp_dir=env.get("KARAOKE_TEMP_DIR", "").strip(),
        )
        fields = {
            "concurrency": ("KARAOKE_WORKER_CONCURRENCY", 1, 1, 4),
            "lease_seconds": ("KARAOKE_WORKER_LEASE_SECONDS", 120, 30, 3600),
            "heartbeat_seconds": ("KARAOKE_WORKER_HEARTBEAT_SECONDS", 20, 1, 1200),
            "poll_seconds": ("KARAOKE_WORKER_POLL_SECONDS", 2, 1, 60),
            "max_safe_attempts": ("KARAOKE_JOB_MAX_SAFE_ATTEMPTS", 2, 1, 5),
            "max_per_admin": ("KARAOKE_MAX_OUTSTANDING_PER_ADMIN", 2, 1, 100),
            "max_global": ("KARAOKE_MAX_OUTSTANDING_GLOBAL", 10, 1, 1000),
            "queue_warning_seconds": ("KARAOKE_QUEUE_WAIT_WARNING_SECONDS", 120, 10, 3600),
            "provider_timeout_seconds": ("KARAOKE_PROVIDER_TIMEOUT_SECONDS", 180, 10, 7200),
        }
        for field, args in fields.items():
            values[field] = _integer(env, *args)
        for field, name in (
            ("reserved_minutes_admin_day", "KARAOKE_MAX_RESERVED_AUDIO_MINUTES_PER_ADMIN_DAY"),
            ("reserved_minutes_global_day", "KARAOKE_MAX_RESERVED_AUDIO_MINUTES_GLOBAL_DAY"),
        ):
            values[field] = _integer(env, name, 0, 1 if enabled or worker else 0, 100000)
        config = cls(**values)
        if config.heartbeat_seconds * 3 >= config.lease_seconds:
            raise KaraokeConfigurationError("KARAOKE_WORKER_HEARTBEAT_SECONDS")
        if len(config.pipeline_version) > 80 or any(c.isspace() for c in config.pipeline_version):
            raise KaraokeConfigurationError("KARAOKE_PROCESSING_PIPELINE_VERSION")
        return config

    @property
    def configured(self):
        return bool(
            self.pipeline_version and self.alignment_provider == "local_ctc"
            and self.stem_provider == "demucs"
            and Path(self.python_path).is_file() and Path(self.engine_script).is_file()
            and (Path(self.model_path) / "pytorch_model.bin").is_file()
            and (Path(self.model_path) / "config.json").is_file()
            and (Path(self.stem_model_path) / "955717e8-8726e21a.th").is_file()
            and self.temp_dir
            and self.reserved_minutes_admin_day > 0 and self.reserved_minutes_global_day > 0
        )
