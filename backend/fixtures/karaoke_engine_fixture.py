"""Test-only protocol subprocess. Never selected by production configuration."""
import json
from pathlib import Path
import sys
import time

request = json.load(sys.stdin)
mode = (request.get("texts") or [""])[0]
if mode == "__WAIT__":
    (Path(request["workspace"]) / "started.marker").write_text("ready", encoding="utf-8")
    time.sleep(30)
elif mode == "__OVERSIZE__":
    print("X" * (2 * 1024 * 1024 + 1))
elif mode == "__ERROR__":
    print(json.dumps({"ok": False, "error": "NO_USABLE_VOCALS"}))
    raise SystemExit(2)
else:
    evidence = dict(units=[dict(index=0, text=mode, start_ms=0, end_ms=800,
                               acoustic_support=0.9, end_evidence="silence_boundary")],
                    recognized_text=mode, frames=49, duration_ms=1000,
                    model_revision="2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed",
                    boundary_version="ctc-delimiter-envelope-v3")
    if mode == "__OLD_BOUNDARY__":
        evidence.pop("boundary_version")
    if mode == "__UNKNOWN_BOUNDARY__":
        evidence["boundary_version"] = "unknown"
    if mode == "__PREVIOUS_BOUNDARY__":
        evidence["boundary_version"] = "ctc-delimiter-envelope-v2"
    if mode == "__DUPLICATE__":
        print('{"ok":true,"result":null,"result":' + json.dumps(evidence) + '}')
    else:
        print(json.dumps({"ok": True, "result": evidence}))
