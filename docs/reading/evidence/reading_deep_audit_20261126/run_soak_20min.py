import asyncio
import ctypes
import json
import os
import struct
import subprocess
import time
import urllib.request
from datetime import datetime, timezone

import librosa
import numpy as np
import websockets

WORKER_BASE = "http://127.0.0.1:8010"
SOAK_DURATION_S = 1230  # 20.5 minutes (> 20 min requirement)
EVIDENCE_DIR = r"f:\c1\capstone1\docs\reading\evidence\reading_deep_audit_20261126"


def find_worker_pid() -> int | None:
    try:
        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "(Get-NetTCPConnection -LocalPort 8010 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess",
            ],
            text=True,
            timeout=5,
        ).strip()
        return int(out) if out.isdigit() else None
    except Exception:
        return None


def get_process_rss_mb(pid: int) -> float | None:
    try:
        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                f"[math]::Round((Get-Process -Id {pid}).WorkingSet64 / 1MB, 2)",
            ],
            text=True,
            timeout=5,
        ).strip()
        return float(out)
    except Exception:
        return None


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
        "header_valid": (data_size == actual_data and riff_size == 36 + actual_data),
        "claimed_duration_s": round(data_size / (sr * 2), 2),
        "actual_duration_s": round(actual_data / (sr * 2), 2),
        "quality_cached": hdrs.get("x-tts-quality-cached") or hdrs.get("X-TTS-Quality-Cached"),
    }


def post_stt_wav(wav_bytes: bytes) -> dict:
    boundary = "----vireadsoak"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="language"\r\n\r\nvi\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="audio_file"; filename="soak.wav"\r\n'
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


async def run_ws_turn(pcm_i16: bytes, idx: int) -> tuple[float, str, bool]:
    t0 = time.perf_counter()
    async with websockets.connect("ws://127.0.0.1:8010/stt/stream") as ws:
        await ws.send(json.dumps({
            "type": "start",
            "session_id": f"soak-{idx}",
            "page_id": "p1",
            "turn_id": f"t_{idx}",
            "sample_rate": 16000,
            "language": "vi",
            "vad_mode": "client",
        }))
        await ws.recv()
        for off in range(0, len(pcm_i16), 2048):
            await ws.send(pcm_i16[off : off + 2048])
        t_flush = time.perf_counter()
        await ws.send(json.dumps({"type": "flush", "turn_id": f"t_{idx}"}))
        final_msg = None
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=10.0))
            if msg.get("type") == "final":
                final_msg = msg
                break
        flush_ms = round((time.perf_counter() - t_flush) * 1000, 1)
        await ws.send(json.dumps({"type": "stop"}))
        ok = bool(final_msg and final_msg.get("turn_id") == f"t_{idx}" and final_msg.get("text"))
        return flush_ms, (final_msg.get("text") if final_msg else ""), ok


async def main():
    pid = find_worker_pid()
    assert pid is not None, "Voice worker PID not found on 8010"

    # First: verify Choice C across all 8 voices with updated 0.36s gap
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
    choice_c_v7 = {}
    for vid in voices:
        r = post_tts("Đáp án C: Quả táo.", vid, word_sample=False)
        s = post_stt_wav(r["wav"])
        choice_c_v7[vid] = {
            "stt_text": s.get("text", ""),
            "header_valid": r["header_valid"],
            "quality_cached": r["quality_cached"],
            "total_ms": r["total_ms"],
        }
    with open(os.path.join(EVIDENCE_DIR, "after_choice_c_v7.json"), "w", encoding="utf-8") as f:
        json.dump(choice_c_v7, f, ensure_ascii=False, indent=2)

    # Prepare clean 16kHz PCM audio for WS STT soak turns
    sample_tts = post_tts("Bé Lan đi học sớm cùng bạn An.", "local_north_truc_ly", word_sample=False)
    pcm = np.frombuffer(sample_tts["wav"][44:], dtype="<i2").astype(np.float32) / 32768.0
    if sample_tts["sr"] != 16000:
        pcm = librosa.resample(pcm, orig_sr=sample_tts["sr"], target_sr=16000)
    pcm_i16 = np.clip(pcm * 32767.0, -32768, 32767).astype("<i2").tobytes()

    soak_phrases = [
        "Con đọc tốt lắm.",
        "Đáp án A: Chiếc ô.",
        "Đáp án B: Quyển sách.",
        "Đáp án C: Quả táo.",
        "Con nhớ lại chi tiết trong bài đọc: “Bé cầm … màu đỏ đi học.” rồi chọn lại nhé!",
        "Mình cùng đọc tiếp nhé.",
    ]

    rss_start = get_process_rss_mb(pid)
    assert rss_start is not None, "Could not measure starting worker RSS"
    t_start = time.monotonic()
    started_iso = datetime.now(timezone.utc).isoformat()

    rss_timeline = [{"elapsed_s": 0, "rss_mb": rss_start}]
    last_rss_sample = t_start
    tts_latencies = []
    ws_latencies = []
    tts_count = 0
    ws_count = 0
    errors = 0
    invalid_wav_headers = 0
    cycle = 0

    while (time.monotonic() - t_start) < SOAK_DURATION_S:
        cycle += 1
        vid = voices[cycle % len(voices)]
        phrase = soak_phrases[cycle % len(soak_phrases)]
        try:
            res = post_tts(phrase, vid, word_sample=False)
            tts_count += 1
            if not res["header_valid"]:
                invalid_wav_headers += 1
            tts_latencies.append((round(time.monotonic() - t_start, 1), res["total_ms"]))
        except Exception:
            errors += 1

        try:
            ws_ms, _txt, ok = await run_ws_turn(pcm_i16, cycle)
            ws_count += 1
            if not ok:
                errors += 1
            ws_latencies.append((round(time.monotonic() - t_start, 1), ws_ms))
        except Exception:
            errors += 1

        now = time.monotonic()
        if now - last_rss_sample >= 60.0:
            cur_rss = get_process_rss_mb(pid)
            if cur_rss is not None:
                rss_timeline.append({"elapsed_s": round(now - t_start, 1), "rss_mb": cur_rss})
            last_rss_sample = now

        await asyncio.sleep(1.5)

    elapsed_s = round(time.monotonic() - t_start, 1)
    rss_end = get_process_rss_mb(pid)
    assert rss_end is not None, "Could not measure ending worker RSS"
    rss_delta = round(rss_end - rss_start, 2)
    rss_timeline.append({"elapsed_s": elapsed_s, "rss_mb": rss_end})

    def window_p50_p95(samples, lo_s, hi_s):
        vals = [v for ts, v in samples if lo_s <= ts <= hi_s]
        if not vals:
            return {"count": 0, "p50_ms": None, "p95_ms": None}
        arr = np.array(vals, dtype=np.float64)
        return {
            "count": len(vals),
            "p50_ms": round(float(np.percentile(arr, 50)), 1),
            "p95_ms": round(float(np.percentile(arr, 95)), 1),
        }

    first_5m_tts = window_p50_p95(tts_latencies, 0, 300)
    last_5m_tts = window_p50_p95(tts_latencies, max(0, elapsed_s - 300), elapsed_s)
    first_5m_ws = window_p50_p95(ws_latencies, 0, 300)
    last_5m_ws = window_p50_p95(ws_latencies, max(0, elapsed_s - 300), elapsed_s)

    report = {
        "started_at": started_iso,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "duration_seconds": elapsed_s,
        "worker_pid": pid,
        "worker_rss_mb_start": rss_start,
        "worker_rss_mb_end": rss_end,
        "worker_rss_delta_mb": rss_delta,
        "rss_timeline": rss_timeline,
        "cycles_completed": cycle,
        "tts_requests": tts_count,
        "ws_stt_turns": ws_count,
        "errors": errors,
        "invalid_wav_headers": invalid_wav_headers,
        "latency_drift": {
            "tts_first_5m": first_5m_tts,
            "tts_last_5m": last_5m_tts,
            "tts_p50_drift_ms": (
                round(last_5m_tts["p50_ms"] - first_5m_tts["p50_ms"], 1)
                if first_5m_tts["p50_ms"] is not None and last_5m_tts["p50_ms"] is not None
                else None
            ),
            "ws_first_5m": first_5m_ws,
            "ws_last_5m": last_5m_ws,
            "ws_p50_drift_ms": (
                round(last_5m_ws["p50_ms"] - first_5m_ws["p50_ms"], 1)
                if first_5m_ws["p50_ms"] is not None and last_5m_ws["p50_ms"] is not None
                else None
            ),
        },
        "choice_c_v7": choice_c_v7,
    }
    out_path = os.path.join(EVIDENCE_DIR, "soak_20min_report.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps({
        "duration_seconds": elapsed_s,
        "worker_rss_mb_start": rss_start,
        "worker_rss_mb_end": rss_end,
        "worker_rss_delta_mb": rss_delta,
        "tts_requests": tts_count,
        "ws_stt_turns": ws_count,
        "errors": errors,
        "invalid_wav_headers": invalid_wav_headers,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
