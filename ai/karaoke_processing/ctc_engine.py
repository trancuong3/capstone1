"""Local Vietnamese singing alignment. Import only inside the isolated AI env.

Checkpoint: nguyenvulebinh/lyric-alignment, revision 2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed.
Weights are CC-BY-NC-4.0; use for noncommercial research under that license.
The checkpoint's inference architecture includes its trained feature-transform
head, as documented by https://github.com/nguyenvulebinh/lyric-alignment
(Apache-2.0 source). Loading it with the stock HF CTC head is not equivalent.
"""
from collections import OrderedDict
import math
from pathlib import Path
import subprocess
import unicodedata

import imageio_ffmpeg
import numpy as np
import torch
from torch import nn
import torchaudio.functional as AF
from transformers import AutoProcessor, Wav2Vec2ForCTC
from transformers.modeling_outputs import CausalLMOutput
from acoustic_boundaries import refine_held_notes
from ctc_boundaries import BOUNDARY_VERSION, trusted_delimiters
from model_pins import verify_model_files

SAMPLE_RATE = 16000
MODEL_REVISION = "2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed"


class SingingCTCModel(Wav2Vec2ForCTC):
    def __init__(self, config):
        super().__init__(config)
        layers = []
        for index in range(1, 4):
            layers.extend([
                (f"linear{index}", nn.Linear(config.hidden_size, config.hidden_size)),
                (f"bn{index}", nn.BatchNorm1d(config.hidden_size)),
                (f"activation{index}", nn.LeakyReLU()),
                (f"drop{index}", nn.Dropout(config.final_dropout)),
            ])
        self.feature_transform = nn.Sequential(OrderedDict(layers))

    def forward(self, input_values, attention_mask=None, **kwargs):
        features = self.wav2vec2(input_values, attention_mask=attention_mask).last_hidden_state
        batch, frames, width = features.shape
        transformed = self.feature_transform(self.dropout(features).reshape(batch * frames, width))
        return CausalLMOutput(logits=self.lm_head(transformed.reshape(batch, frames, width)))


def decode_audio(path, *, timeout=60):
    path = Path(path).resolve(strict=True)
    if not path.is_file() or path.stat().st_size > 20 * 1024 * 1024:
        raise ValueError("INVALID_AUDIO")
    result = subprocess.run([
        imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error",
        "-protocol_whitelist", "file,pipe",
        *(["-f", "mp3"] if path.suffix.lower() == ".mp3" else []), "-i", str(path),
        "-t", "300.1", "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "f32le", "pipe:1",
    ], check=True, capture_output=True, timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0)
    samples = np.frombuffer(result.stdout, dtype="<f4").copy()
    if not 400 <= samples.size <= 300 * SAMPLE_RATE or not np.isfinite(samples).all():
        raise ValueError("INVALID_AUDIO")
    return samples


def spoken_form(text):
    # Preserve the user's text separately; punctuation is not an acoustic token.
    return "".join(char for char in unicodedata.normalize("NFC", text).lower()
                   if unicodedata.category(char).startswith(("L", "M")))


class LocalSingingAligner:
    def __init__(self, model_path, *, threads=2):
        verify_model_files(model_path)
        torch.set_num_threads(threads)
        self.processor = AutoProcessor.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
        self.model, loading = SingingCTCModel.from_pretrained(
            model_path, local_files_only=True, trust_remote_code=False, output_loading_info=True,
        )
        if loading["missing_keys"] or loading["unexpected_keys"] or loading.get("mismatched_keys"):
            raise ValueError("MODEL_ARCHITECTURE_MISMATCH")
        self.model.eval()
        self.vocabulary = self.processor.tokenizer.get_vocab()
        self.blank = self.model.config.pad_token_id
        self.separator = self.processor.tokenizer.word_delimiter_token

    @torch.inference_mode()
    def emissions(self, samples):
        # Bound attention memory with overlapping 20-second cores. Frames retain
        # their global audio positions; no silence trimming or tempo changes.
        if len(samples) <= SAMPLE_RATE * 24:
            values = self.processor(samples, sampling_rate=SAMPLE_RATE, return_tensors="pt").input_values
            return self.model(values).logits[0].log_softmax(-1).cpu(), 0.02
        chunks = []
        core, context = SAMPLE_RATE * 20, SAMPLE_RATE * 2
        for start in range(0, len(samples), core):
            left, right = max(0, start - context), min(len(samples), start + core + context)
            values = self.processor(samples[left:right], sampling_rate=SAMPLE_RATE, return_tensors="pt").input_values
            logits = self.model(values).logits[0].log_softmax(-1).cpu()
            first = (start - left) // 320
            count = min(core, len(samples) - start) // 320
            chunks.append(logits[first:first + count])
        return torch.cat(chunks), 0.02

    @torch.inference_mode()
    def align(self, samples, texts):
        words = [spoken_form(text) for text in texts]
        if not words or any(not word for word in words):
            raise ValueError("UNSUPPORTED_LYRIC_UNIT")
        transcript = self.separator.join(words)
        if any(char not in self.vocabulary for char in transcript):
            raise ValueError("UNSUPPORTED_LYRIC_UNIT")
        token_ids = [self.vocabulary[char] for char in transcript]
        emission, seconds_per_frame = self.emissions(samples)
        targets = torch.tensor([token_ids], dtype=torch.int32)
        paths, scores = AF.forced_align(emission.unsqueeze(0), targets, blank=self.blank)
        spans = AF.merge_tokens(paths[0], scores[0].exp(), blank=self.blank)
        if len(spans) != len(token_ids):
            raise ValueError("INVALID_ALIGNMENT_PATH")
        greedy = self.processor.decode(emission.argmax(-1)).strip()
        def token_records(items):
            return [dict(text=self.processor.tokenizer.convert_ids_to_tokens(span.token),
                         start=int(span.start), end=int(span.end), support=float(span.score)) for span in items]
        greedy_path = emission.argmax(-1)
        greedy_spans = AF.merge_tokens(greedy_path, emission.max(-1).values.exp(), blank=self.blank)
        boundaries = trusted_delimiters(words, token_records(spans), token_records(greedy_spans), self.separator)
        results, cursor = [], 0
        for word in words:
            pieces = spans[cursor:cursor + len(word)]
            start_ms = round(pieces[0].start * seconds_per_frame * 1000)
            end_ms = round(pieces[-1].end * seconds_per_frame * 1000)
            support = sum(float(span.score) for span in pieces) / len(pieces)
            results.append(dict(start_ms=start_ms, end_ms=end_ms, acoustic_support=support))
            cursor += len(word) + 1
        return dict(units=refine_held_notes(samples, results, ctc_boundaries=boundaries), recognized_text=greedy,
                    frames=len(emission), model_revision=MODEL_REVISION, boundary_version=BOUNDARY_VERSION,
                    duration_ms=round(len(samples) * 1000 / SAMPLE_RATE))
