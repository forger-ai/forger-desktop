import argparse
import asyncio
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.responses import JSONResponse


class RuntimeState:
    def __init__(self, metadata_root: Path, token: str, log_path: Path | None = None):
        self.metadata_root = metadata_root
        self.token = token
        self.log_path = log_path
        self.active_sessions = 0
        self.last_confidence = 0.0
        self.last_detection: dict[str, Any] | None = None

    def websocket_authorized(self, websocket: WebSocket) -> bool:
        authorization = websocket.headers.get("authorization")
        token = websocket.query_params.get("token")
        return authorization == f"Bearer {self.token}" or token == self.token

    def log_event(self, event: str, payload: dict[str, Any] | None = None) -> None:
        if self.log_path is None:
            return
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"timestamp": now_iso(), "service": "wake_word", "event": event, **sanitize_details(payload or {})}, ensure_ascii=True) + "\n")
        except Exception:
            pass


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sanitize_details(details: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "activeSessions",
        "confidence",
        "cooldownMs",
        "frameBytes",
        "format",
        "modelId",
        "patience",
        "sampleRate",
        "status",
        "technicalCode",
        "threshold",
    }
    result: dict[str, Any] = {}
    for key, value in details.items():
        if key not in allowed:
            continue
        if isinstance(value, str):
            result[key] = value[:240]
        elif isinstance(value, (int, float, bool)) or value is None:
            result[key] = value
    return result


def start_parent_watchdog(parent_pid: int | None, state: RuntimeState) -> None:
    if not parent_pid or parent_pid <= 0:
        return

    def watch_parent() -> None:
        while True:
            time.sleep(2)
            try:
                os.kill(parent_pid, 0)
            except OSError:
                state.log_event("parent_exit", {"technicalCode": "parent_process_missing"})
                os._exit(0)

    threading.Thread(target=watch_parent, daemon=True).start()


def clamp_float(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    try:
        parsed = float(value)
    except Exception:
        return fallback
    return max(minimum, min(maximum, parsed))


def clamp_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except Exception:
        return fallback
    return max(minimum, min(maximum, parsed))


def clean_model_id(value: Any) -> str:
    if not isinstance(value, str):
        return "hey jarvis"
    cleaned = value.strip()
    aliases = {
        "hey_jarvis": "hey jarvis",
        "hey_mycroft": "hey mycroft",
        "hey_rhasspy": "hey rhasspy",
    }
    return aliases.get(cleaned, cleaned[:160] or "hey jarvis")


def create_wake_detector(model_id: str):
    try:
        from openwakeword.model import Model
    except Exception as exc:
        raise RuntimeError("openwakeword_not_installed") from exc
    try:
        if Path(model_id).expanduser().exists():
            return Model(wakeword_models=[str(Path(model_id).expanduser().resolve())])
        try:
            from openwakeword.utils import download_models
            download_models()
        except Exception:
            pass
        return Model(wakeword_models=[model_id])
    except Exception as exc:
        raise RuntimeError("wake_model_unavailable") from exc


def predict_wake_confidence(model: Any, pcm: bytes) -> float:
    try:
        import numpy as np
    except Exception as exc:
        raise RuntimeError("numpy_not_installed") from exc
    samples = np.frombuffer(pcm, dtype=np.int16)
    if samples.size == 0:
        return 0.0
    result = model.predict(samples)
    if isinstance(result, dict):
        values = [float(value) for value in result.values() if isinstance(value, (int, float))]
        return max(values) if values else 0.0
    return 0.0


def create_app(state: RuntimeState) -> FastAPI:
    app = FastAPI(title="Forger Wake Word")

    @app.get("/health")
    async def health():
        return {
            "ok": True,
            "activeSessions": state.active_sessions,
            "lastConfidence": state.last_confidence,
        }

    @app.websocket("/v1/wake-word/listen")
    async def listen(websocket: WebSocket):
        if not state.websocket_authorized(websocket):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        state.active_sessions += 1
        session_id = str(uuid.uuid4())
        state.log_event("session_started", {"activeSessions": state.active_sessions})
        model = None
        model_id = "hey jarvis"
        threshold = 0.5
        patience = 2
        cooldown_ms = 2500
        hits = 0
        last_detected_at = 0.0
        first_audio_frame_logged = False
        start_received = False
        send_lock = asyncio.Lock()

        async def emit(kind: str, payload: dict[str, Any] | None = None) -> None:
            async with send_lock:
                await websocket.send_text(json.dumps({"type": kind, "sessionId": session_id, **(payload or {})}))

        try:
            while True:
                try:
                    message = await asyncio.wait_for(websocket.receive(), timeout=15 if not start_received else None)
                except asyncio.TimeoutError:
                    await emit("wake_unavailable", {"technicalCode": "wake_start_timeout"})
                    state.log_event("unavailable", {"technicalCode": "wake_start_timeout"})
                    await websocket.close(code=1000)
                    return
                if "text" in message and message["text"] is not None:
                    control = json.loads(message["text"])
                    control_type = control.get("type")
                    if control_type == "start":
                        start_received = True
                        sample_rate = int(control.get("sampleRate") or 16000)
                        state.log_event("start_received", {
                            "sampleRate": sample_rate,
                            "format": control.get("format", "pcm_s16le"),
                            "modelId": clean_model_id(control.get("modelId")),
                        })
                        if sample_rate != 16000 or control.get("format", "pcm_s16le") != "pcm_s16le":
                            await emit("wake_unavailable", {"technicalCode": "unsupported_wake_audio_format"})
                            state.log_event("unavailable", {"technicalCode": "unsupported_wake_audio_format"})
                            await websocket.close(code=1003, reason="unsupported_wake_audio_format")
                            return
                        model_id = clean_model_id(control.get("modelId"))
                        threshold = clamp_float(control.get("threshold"), 0.5, 0.05, 0.99)
                        patience = clamp_int(control.get("patience"), 2, 1, 8)
                        cooldown_ms = clamp_int(control.get("cooldownMs"), 2500, 250, 60000)
                        state.log_event("model_loading", {
                            "modelId": model_id,
                            "threshold": threshold,
                            "patience": patience,
                            "cooldownMs": cooldown_ms,
                        })
                        try:
                            model = await asyncio.wait_for(asyncio.to_thread(create_wake_detector, model_id), timeout=30)
                            await emit("wake_ready", {"modelId": model_id})
                            state.log_event("ready", {"modelId": model_id})
                        except asyncio.TimeoutError:
                            model = None
                            technical_code = "wake_model_load_timeout"
                            await emit("wake_unavailable", {"modelId": model_id, "technicalCode": technical_code})
                            state.log_event("unavailable", {"modelId": model_id, "technicalCode": technical_code})
                        except Exception as exc:
                            model = None
                            technical_code = str(exc) or "wake_model_unavailable"
                            await emit("wake_unavailable", {"modelId": model_id, "technicalCode": technical_code})
                            state.log_event("unavailable", {"modelId": model_id, "technicalCode": technical_code})
                        continue
                    if control_type in {"end", "cancel"}:
                        await websocket.close(code=1000)
                        return
                    continue
                if "bytes" not in message or message["bytes"] is None:
                    continue
                frame = message["bytes"]
                if not first_audio_frame_logged:
                    first_audio_frame_logged = True
                    state.log_event("first_audio_frame", {"modelId": model_id, "frameBytes": len(frame)})
                if len(frame) % 2 != 0:
                    await emit("wake_unavailable", {"modelId": model_id, "technicalCode": "invalid_pcm_frame"})
                    state.log_event("unavailable", {"modelId": model_id, "technicalCode": "invalid_pcm_frame", "frameBytes": len(frame)})
                    continue
                if model is None:
                    continue
                try:
                    confidence = await asyncio.to_thread(predict_wake_confidence, model, frame)
                    state.last_confidence = confidence
                    await emit("wake_confidence", {"modelId": model_id, "confidence": confidence})
                    hits = hits + 1 if confidence >= threshold else 0
                    now = time.monotonic()
                    if hits >= patience and ((now - last_detected_at) * 1000) >= cooldown_ms:
                        hits = 0
                        last_detected_at = now
                        state.last_detection = {"modelId": model_id, "confidence": confidence}
                        await emit("wake_detected", {"modelId": model_id, "confidence": confidence})
                        state.log_event("detected", {"modelId": model_id, "confidence": confidence})
                except Exception as exc:
                    model = None
                    technical_code = str(exc) or "wake_detection_failed"
                    await emit("wake_unavailable", {"modelId": model_id, "technicalCode": technical_code})
                    state.log_event("unavailable", {"modelId": model_id, "technicalCode": technical_code})
        finally:
            state.active_sessions = max(0, state.active_sessions - 1)
            state.log_event("session_closed", {"activeSessions": state.active_sessions})

    @app.exception_handler(Exception)
    async def generic_exception_handler(_request, exc: Exception):
        return JSONResponse(status_code=500, content={"success": False, "technicalCode": str(exc) or "wake_word_failed"})

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--metadata-root", required=True)
    parser.add_argument("--log-path")
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()
    token = os.environ.get("FORGER_WAKE_WORD_TOKEN", "")
    if not token:
        raise SystemExit("FORGER_WAKE_WORD_TOKEN is required")
    state = RuntimeState(Path(args.metadata_root), token, Path(args.log_path) if args.log_path else None)
    start_parent_watchdog(args.parent_pid, state)
    state.log_event("server_start", {"status": "starting"})
    import uvicorn
    uvicorn.run(create_app(state), host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
