import asyncio
import io
import json
import struct
import time
import urllib.request
from datetime import datetime, timezone

import librosa
import numpy as np
import soundfile as sf
import websockets

WORKER_BASE = "http://127.0.0.1:8010"


def post_tts(text: str, voice_id: str, word_sample: bool = False):
    t0 = time.perf_counter()
    req = urllib.request.Request(
        f"{WORKER_BASE}/tts",
        data=json.dumps(
            {
                "text": text,
                "voice_id": voice_id,
                "speed": 1.0,
                "word_sample": word_sample,
            }
        ).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=45) as resp:
        first_chunk = resp.read(1024)
        ttfa_ms = round((time.perf_counter() - t0) * 1000, 1)
        rest = resp.read()
        total_ms = round((time.perf_counter() - t0) * 1000, 1)
        hdrs = dict(resp.headers.items())
    wav = first_chunk + rest
    riff_size = struct.unpack("<I", wav[4:8])[0]
    data_size = struct.unpack("<I", wav[40:44])[0]
    sr = struct.unpack("<I", wav[24:28])[0]
    actual_data = len(wav) - 44
    return {
        "wav": wav,
        "sr": sr,
        "ttfa_ms": ttfa_ms,
        "total_ms": total_ms,
        "x_tts_streamed": hdrs.get("x-tts-streamed") or hdrs.get("X-TTS-Streamed"),
        "riff_size_hex": hex(riff_size),
        "data_size_hex": hex(data_size),
        "claimed_duration_s": round(data_size / (sr * 2), 2),
        "actual_duration_s": round(actual_data / (sr * 2), 2),
        "header_valid": (data_size == actual_data and riff_size == 36 + actual_data),
    }


def post_stt_wav(wav_bytes: bytes) -> dict:
    sr = struct.unpack("<I", wav_bytes[24:28])[0]
    pcm = np.frombuffer(wav_bytes[44:], dtype="<i2").astype(np.float32) / 32768.0
    buf = io.BytesIO()
    sf.write(buf, pcm, sr, format="WAV", subtype="PCM_16")
    fixed_wav = buf.getvalue()

    boundary = "----vireadprobe"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="language"\r\n\r\nvi\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="audio_file"; filename="probe.wav"\r\n'
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8") + fixed_wav + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        f"{WORKER_BASE}/stt",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def repro_ws_clipping():
    tts = post_tts("Con mèo trèo cây cau", "local_north_truc_ly", word_sample=False)
    sr = tts["sr"]
    pcm = np.frombuffer(tts["wav"][44:], dtype="<i2").astype(np.float32) / 32768.0
    if sr != 16000:
        pcm = librosa.resample(pcm, orig_sr=sr, target_sr=16000)
    peak = float(np.max(np.abs(pcm))) or 1.0
    pcm = (pcm / peak) * 0.25
    pcm[len(pcm) // 2] = 0.996

    async with websockets.connect("ws://127.0.0.1:8010/stt/stream") as ws:
        await ws.send(json.dumps({
            "type": "start",
            "session_id": "probe-clip",
            "page_id": "p1",
            "turn_id": "t1",
            "sample_rate": 16000,
            "language": "vi",
        }))
        ready = json.loads(await ws.recv())
        pcm_i16 = np.clip(pcm * 32767.0, -32768, 32767).astype("<i2").tobytes()
        for off in range(0, len(pcm_i16), 2048):
            await ws.send(pcm_i16[off : off + 2048])
        await ws.send(json.dumps({"type": "flush", "turn_id": "t1"}))
        final_msg = None
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            msg = json.loads(raw)
            if msg.get("type") == "final":
                final_msg = msg
                break
        await ws.send(json.dumps({"type": "stop"}))
        return {
            "ready": ready.get("type"),
            "final_text": final_msg.get("text") if final_msg else None,
            "audio_quality": final_msg.get("audio_quality") if final_msg else None,
            "words_count": len(final_msg.get("words") or []) if final_msg else 0,
        }


def repro_mui_e_quiz_matrix():
    voices = [
        "local_north_truc_ly",
        "local_north_ngoc_linh",
        "local_north_thien_minh",
        "local_central_ngoc_tran",
        "local_central_quang_son",
        "local_south_thuc_doan",
        "local_south_my_duyen",
        "local_south_thai_son",
    ]
    utterances = {
        "q_prompt": "Trong câu chuyện, bé mang theo đồ vật gì khi trời mưa?",
        "choice_a": "Đáp án A: Chiếc ô.",
        "choice_b": "Đáp án B: Quyển sách.",
        "choice_c": "Đáp án C: Quả táo.",
        "hint_wrong": "Con nhớ lại chi tiết trong bài đọc: “Bé cầm … màu đỏ đi học.” rồi chọn lại nhé!",
        "short_word": "Chiếc ô",
    }
    matrix = {}
    for vid in voices:
        matrix[vid] = {}
        for key, text in utterances.items():
            res = post_tts(text, vid, word_sample=(key == "short_word"))
            stt = post_stt_wav(res["wav"])
            matrix[vid][key] = {
                "tts_text": text,
                "stt_text": stt.get("text", ""),
                "ttfa_ms": res["ttfa_ms"],
                "total_ms": res["total_ms"],
                "header_valid": res["header_valid"],
                "claimed_duration_s": res["claimed_duration_s"],
                "actual_duration_s": res["actual_duration_s"],
            }
    return matrix


async def main():
    unique_sentence = "Hôm nay trời nắng đẹp và các bạn nhỏ cùng nhau đọc bài mới trên sân trường."
    wav_hdr = post_tts(unique_sentence, "local_north_truc_ly", word_sample=False)
    wav_hdr_summary = {k: v for k, v in wav_hdr.items() if k != "wav"}
    ws_clip = await repro_ws_clipping()
    quiz_matrix = repro_mui_e_quiz_matrix()
    out = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "mui_c_ws_1sample_clip_before": ws_clip,
        "mui_e_wav_header_before": wav_hdr_summary,
        "mui_e_8voices_quiz_before": quiz_matrix,
    }
    out_path = r"f:\c1\capstone1\docs\reading\evidence\reading_deep_audit_20261126\before_voice_worker_live.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(json.dumps({
        "mui_c_ws_1sample_clip_before": ws_clip,
        "mui_e_wav_header_before": wav_hdr_summary,
        "voices_tested": len(quiz_matrix),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
