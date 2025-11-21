#!/usr/bin/env python3
# Minimal Flask webhook receiver for WARest
# - Verifies X-WAREST-Signature using X-WAREST-Signature-Alg
# - Supports multiple secrets via env WAREST_SECRET="s1,s2,..."

import os
import hmac
import hashlib
from flask import Flask, request, jsonify

PORT = int(os.getenv("PORT", "8081"))
SECRETS = [s.strip() for s in os.getenv("WAREST_SECRET", "secret").split(",") if s.strip()]
VERIFY_TS = os.getenv("WAREST_VERIFY_TS", "0") == "1"
TOLERANCE_SEC = int(os.getenv("WAREST_TOLERANCE_SEC", "300"))
DEBUG_SIG = os.getenv("DEBUG_SIGNATURE", "0") == "1"

app = Flask(__name__)


def algo_from_header(header: str) -> str:
    try:
        header = (header or "").upper()
        if header.startswith("HMAC-SHA"):
            bits = header.replace("HMAC-SHA", "")
            return {
                "224": "sha224",
                "256": "sha256",
                "384": "sha384",
                "512": "sha512",
            }.get(bits, "sha256")
    except Exception:
        pass
    return "sha256"


def verify(req) -> bool:
    sig_header = request.headers.get("X-WAREST-Signature", "")
    alg_header = request.headers.get("X-WAREST-Signature-Alg", "")
    username = request.headers.get("X-WAREST-Username", "")
    algo = algo_from_header(alg_header)

    try:
        token_parts = sig_header.split("=")
        hexsig = (token_parts[1] if len(token_parts) > 1 else "").strip()
        if not hexsig:
            return False
    except Exception:
        return False

    raw = request.get_data(cache=False) or b"{}"

    for base in SECRETS:
        key = (base or "") + (username or "")
        digestmod = getattr(hashlib, algo, hashlib.sha256)
        expected = hmac.new(key.encode("utf-8"), raw, digestmod=digestmod).hexdigest()
        if hmac.compare_digest(expected, hexsig):
            return True
        if DEBUG_SIG:
            print("[DEBUG] signature mismatch for secret:", base)
            print("[DEBUG] expected:", expected)
            print("[DEBUG] got:", hexsig)
    return False


@app.route("/webhook", methods=["POST"])
def webhook():
    hdrs = {
        "event": request.headers.get("X-WAREST-Event"),
        "session": request.headers.get("X-WAREST-Session"),
        "username": request.headers.get("X-WAREST-Username"),
        "ts": request.headers.get("X-WAREST-Timestamp"),
    }
    ok = verify(request)
    if ok and VERIFY_TS:
        try:
            import time

            ts = int(request.headers.get("X-WAREST-Timestamp", "0"))
            now = int(time.time() * 1000)
            if abs(now - ts) > TOLERANCE_SEC * 1000:
                return jsonify({"ok": False, "error": "stale timestamp"}), 401
        except Exception:
            return jsonify({"ok": False, "error": "timestamp error"}), 401

    print("\n[WEBHOOK] headers:", hdrs)
    print("[WEBHOOK] body:", request.get_json(silent=True))
    if not ok:
        return jsonify({"ok": False, "error": "bad signature"}), 401

    body = request.get_json(silent=True) or {}
    actions = []
    if hdrs["event"] == "preflight":
        return jsonify({"ok": True, "pong": True})
    if hdrs["event"] == "message_received":
        text = (body.get("data", {}).get("text") or "").strip().lower()
        to = body.get("data", {}).get("sender", {}).get("chatId")
        key = (body.get("data", {}).get("message") or {}).get("key")
        if text == "test" and to:
            actions.append({"type": "text", "to": to, "text": "pong"})
        if text == "react" and to and key:
            actions.append({"act": "react", "to": to, "key": key, "emoji": "👍"})
    return jsonify({"ok": True, "actions": actions, "delayMs": 600})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)

