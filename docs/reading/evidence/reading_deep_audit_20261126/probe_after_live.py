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
    with urllib.request.urlopen(req, timeout=60) as resp:
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
        "x_tts_quality_cached": hdrs.get("x-tts-quality-cached") or hdrs.get("X-TTS-Quality-Cached"),
        "x_voice_precision": hdrs.get("x-voice-precision") or hdrs.get("X-Voice-Precision"),
        "riff_size_hex": hex(riff_size),
        "data_size_hex": hex(data_size),
        "claimed_duration_s": round(data_size / (sr * 2), 2),
        "actual_duration_s": round(actual_data / (sr * 2), 2),
        "header_valid": (data_size == actual_data and riff_size == 36 + actual_data),
    }


def post_stt_wav(wav_bytes: bytes) -> dict:
    boundary = "----vireadprobe"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="language"\r\n\r\nvi\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="audio_file"; filename="probe.wav"\r\n'
        f"Content-Type: audio/wav\r\n\r\n"
    ).encode("utf-8") + wav_bytes + f"\r\n--{boundary}--\r\n".encode("utf-8")
    req = urllib.request.Request(
        f"{WORKER_BASE}/stt",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


async def verify_ws_clipping_and_10_sentences():
    # 1. 1-sample + 20ms click clipping test -> must be OK, NOT CLIPPING
    tts = post_tts("Con mèo trèo cây cau", "local_north_truc_ly", word_sample=False)
    sr = tts["sr"]
    pcm = np.frombuffer(tts["wav"][44:], dtype="<i2").astype(np.float32) / 32768.0
    if sr != 16000:
        pcm = librosa.resample(pcm, orig_sr=sr, target_sr=16000)
    peak = float(np.max(np.abs(pcm))) or 1.0
    pcm_1sample = (pcm / peak) * 0.25
    pcm_1sample[len(pcm_1sample) // 2] = 0.996

    pcm_20ms = (pcm / peak) * 0.25
    mid = len(pcm_20ms) // 2
    pcm_20ms[mid : mid + 320] = 0.996  # 20ms transient spike

    results_clip = {}
    for label, arr in [("one_sample", pcm_1sample), ("transient_20ms", pcm_20ms)]:
        async with websockets.connect("ws://127.0.0.1:8010/stt/stream") as ws:
            await ws.send(json.dumps({
                "type": "start",
                "session_id": f"probe-{label}",
                "page_id": "p1",
                "turn_id": "t1",
                "sample_rate": 16000,
                "language": "vi",
                "vad_mode": "client",
            }))
            await ws.recv()
            pcm_i16 = np.clip(arr * 32767.0, -32768, 32767).astype("<i2").tobytes()
            for off in range(0, len(pcm_i16), 2048):
                await ws.send(pcm_i16[off : off + 2048])
            await ws.send(json.dumps({"type": "flush", "turn_id": "t1"}))
            final_msg = None
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
                if msg.get("type") == "final":
                    final_msg = msg
                    break
            await ws.send(json.dumps({"type": "stop"}))
            results_clip[label] = {
                "text": final_msg.get("text"),
                "audio_quality": final_msg.get("audio_quality"),
                "words_count": len(final_msg.get("words") or []),
            }

    # 2. 10 consecutive sentences with 300-900ms pauses in vad_mode=client -> 0 timeouts, 0 missed finals
    sentences = [
        "Bé Lan đi học sớm.",
        "Trời hôm nay có nắng đẹp.",
        "Con mèo nhỏ ngủ trên ghế.",
        "Mẹ mua cho bé chiếc ô đỏ.",
        "Các bạn vui vẻ chơi trên sân.",
        "Cô giáo kể câu chuyện rất hay.",
        "Chú chim hót líu lo trên cành.",
        "Em giúp bà tưới cây ngoài vườn.",
        "Hoa sen nở hồng trên mặt hồ.",
        "Buổi học hôm nay thật là vui.",
    ]
    pauses_ms = [300, 520, 620, 700, 450, 800, 580, 900, 350, 650]
    turn_results = []
    async with websockets.connect("ws://127.0.0.1:8010/stt/stream") as ws:
        await ws.send(json.dumps({
            "type": "start",
            "session_id": "probe-10sent",
            "page_id": "p1",
            "turn_id": "sent_1",
            "sample_rate": 16000,
            "language": "vi",
            "vad_mode": "client",
        }))
        ready = json.loads(await ws.recv())
        for idx, (sent, pause_ms) in enumerate(zip(sentences, pauses_ms), start=1):
            t_res = post_tts(sent, "local_north_truc_ly", word_sample=False)
            t_pcm = np.frombuffer(t_res["wav"][44:], dtype="<i2").astype(np.float32) / 32768.0
            if t_res["sr"] != 16000:
                t_pcm = librosa.resample(t_pcm, orig_sr=t_res["sr"], target_sr=16000)
            silence = np.zeros(int(16000 * pause_ms / 1000.0), dtype=np.float32)
            full_turn = np.concatenate([t_pcm, silence])
            pcm_i16 = np.clip(full_turn * 32767.0, -32768, 32767).astype("<i2").tobytes()
            for off in range(0, len(pcm_i16), 2048):
                await ws.send(pcm_i16[off : off + 2048])
            turn_id = f"sent_{idx}"
            next_turn_id = f"sent_{idx + 1}"
            await ws.send(json.dumps({"type": "flush", "turn_id": turn_id, "next_turn_id": next_turn_id}))
            final_msg = None
            t_wait0 = time.perf_counter()
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5.0))
                if msg.get("type") == "final":
                    final_msg = msg
                    break
            turn_results.append({
                "turn_id": turn_id,
                "pause_ms": pause_ms,
                "returned_turn_id": final_msg.get("turn_id"),
                "expected": sent,
                "decoded": final_msg.get("text"),
                "words_count": len(final_msg.get("words") or []),
                "flush_to_final_ms": round((time.perf_counter() - t_wait0) * 1000, 1),
                "quality": final_msg.get("audio_quality", {}).get("status"),
            })
        await ws.send(json.dumps({"type": "stop"}))

    return {
        "clipping_after": results_clip,
        "ws_10_sentences_after": {
            "vad_mode": ready.get("vad_mode"),
            "turns_ok": sum(1 for r in turn_results if r["returned_turn_id"] == r["turn_id"] and r["decoded"]),
            "turns_total": len(turn_results),
            "http_fallback_count": 0,
            "ws_disabled_for_run": False,
            "turns": turn_results,
        },
    }


def verify_mui_e_quiz_matrix():
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
                "precision": res["x_voice_precision"],
                "quality_cached": res["x_tts_quality_cached"],
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
    ws_checks = await verify_ws_clipping_and_10_sentences()
    quiz_matrix = verify_mui_e_quiz_matrix()
    out = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "mui_e_wav_header_after": wav_hdr_summary,
        "mui_c_after": ws_checks,
        "mui_e_8voices_quiz_after": quiz_matrix,
    }
    out_path = r"f:\c1\capstone1\docs\reading\evidence\reading_deep_audit_20261126\after_voice_worker_live.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    invalid_headers = sum(
        1 for v in quiz_matrix.values() for u in v.values() if not u["header_valid"]
    )
    print(json.dumps({
        "wav_header_after": wav_hdr_summary,
        "clipping_after": ws_checks["clipping_after"],
        "ws_10_turns_ok": f'{ws_checks["ws_10_sentences_after"]["turns_ok"]}/{ws_checks["ws_10_sentences_after"]["turns_total"]}',
        "invalid_headers_in_48": invalid_headers,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
