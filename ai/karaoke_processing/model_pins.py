"""Verified files of the pinned Vietnamese singing checkpoint, not remote code."""
import hashlib
from pathlib import Path

MODEL_SHA256 = {
    "pytorch_model.bin": "0c25b2cd0aaea6417a0ed325493300d1a46799c2e123dafd73412cafa1886123",
    "added_tokens.json": "2a414043a349f4e700923daad59bf62a4a760bce33863d8fe5057e25a4f0ad2d",
    "config.json": "dd48bbeef9fe203d700dc7a6b55534c136f3761a8cc19d88fcacca2e87836421",
    "preprocessor_config.json": "8cdfd65ff4115423185a1512bdae100e2e0cd744f5b322417429944aaafd0827",
    "special_tokens_map.json": "3bc2262731c0b1e7daa3025ce4f2879c0932183d1d02e6ec196907989f29d1e7",
    "tokenizer_config.json": "88eec20f24c51d11084bfddb7983fb1e4e22ac71f7e95f1fc628f72290d3ec6d",
    "vocab.json": "4339e2cb5c97554f089fe317120e794efce3f7626ad205fb496d34bddd2c6ae7"
}


def verify_model_files(model_path):
    root = Path(model_path).resolve(strict=True)
    for name, expected in MODEL_SHA256.items():
        path = root / name
        digest = hashlib.sha256()
        if not path.is_file():
            raise ValueError("PROCESSING_CONFIGURATION_INVALID")
        with path.open("rb") as stream:
            while block := stream.read(1024 * 1024):
                digest.update(block)
        if digest.hexdigest() != expected:
            raise ValueError("PROCESSING_CONFIGURATION_INVALID")
