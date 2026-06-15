import argparse
import asyncio
import base64
import json
import os
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel


VOICE_OPTIONS = [
    {"id": "af_heart", "model": "kokoro", "label": "Heart", "language": "English", "locale": "en-US"},
    {"id": "af_bella", "model": "kokoro", "label": "Bella", "language": "English", "locale": "en-US"},
    {"id": "am_adam", "model": "kokoro", "label": "Adam", "language": "English", "locale": "en-US"},
    {"id": "bf_emma", "model": "kokoro", "label": "Emma", "language": "English", "locale": "en-GB"},
    {"id": "bm_george", "model": "kokoro", "label": "George", "language": "English", "locale": "en-GB"},
    {"id": "ef_dora", "model": "kokoro", "label": "Dora", "language": "Spanish", "locale": "es"},
    {"id": "em_alex", "model": "kokoro", "label": "Alex", "language": "Spanish", "locale": "es"},
    {"id": "ff_siwis", "model": "kokoro", "label": "Siwis", "language": "French", "locale": "fr"},
    {"id": "if_sara", "model": "kokoro", "label": "Sara", "language": "Italian", "locale": "it"},
    {"id": "pf_dora", "model": "kokoro", "label": "Dora", "language": "Portuguese", "locale": "pt-BR"},
    {"id": "pm_alex", "model": "kokoro", "label": "Alex", "language": "Portuguese", "locale": "pt-BR"},
    {"id": "jf_alpha", "model": "kokoro", "label": "Alpha", "language": "Japanese", "locale": "ja"},
    {"id": "zf_xiaobei", "model": "kokoro", "label": "Xiaobei", "language": "Mandarin Chinese", "locale": "zh-CN"},
    {"id": "hf_alpha", "model": "kokoro", "label": "Alpha", "language": "Hindi", "locale": "hi"},
]

MODEL_OPTIONS = [{"id": "kokoro", "label": "Kokoro", "installed": True}]


class SynthesizeRequest(BaseModel):
    text: str
    model: str
    voice: str
    speed: float = 1.0
    format: str = "wav"


class RuntimeState:
    def __init__(self, metadata_root: Path, token: str, max_text_characters: int, max_concurrent_jobs: int, log_path: Path | None = None):
        self.metadata_root = metadata_root
        self.token = token
        self.max_text_characters = max_text_characters
        self.semaphore = asyncio.Semaphore(max(1, max_concurrent_jobs))
        self.jobs: list[dict[str, Any]] = []
        self.pipelines: dict[str, Any] = {}
        self.log_path = log_path

    @property
    def active_jobs(self) -> int:
        return len([job for job in self.jobs if job["status"] == "running"])

    @property
    def queued_jobs(self) -> int:
        return len([job for job in self.jobs if job["status"] == "queued"])

    def output_root(self) -> Path:
        root = self.metadata_root / "outputs"
        root.mkdir(parents=True, exist_ok=True)
        return root

    def log_event(self, event: str, payload: dict[str, Any] | None = None) -> None:
        if self.log_path is None:
            return
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"timestamp": now_iso(), "service": "text_to_speech", "event": event, **sanitize_details(payload or {})}, ensure_ascii=True) + "\n")
        except Exception:
            pass

    def check_token(self, authorization: str | None) -> None:
        if authorization != f"Bearer {self.token}":
            raise HTTPException(status_code=401, detail=error_payload("text_to_speech", "auth", "unauthorized", "Text to speech is not authorized.", False, {"httpStatus": 401}))

    def load_model(self, model: str, lang_code: str):
        if model != "kokoro":
            raise RuntimeError("text_to_speech_model_not_supported")
        key = f"{model}:{lang_code}"
        if key in self.pipelines:
            return self.pipelines[key]
        try:
            from kokoro import KPipeline
        except Exception as exc:
            raise RuntimeError("kokoro_not_installed") from exc
        try:
            self.pipelines[key] = KPipeline(lang_code=lang_code)
        except Exception as exc:
            raise RuntimeError("kokoro_pipeline_load_failed") from exc
        return self.pipelines[key]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sanitize_details(details: dict[str, Any]) -> dict[str, Any]:
    allowed = {"format", "httpStatus", "language", "locale", "model", "operation", "queueDepth", "reportable", "service", "status", "technicalCode", "textLength", "voice"}
    result: dict[str, Any] = {}
    for key, value in details.items():
        if key not in allowed:
            continue
        if isinstance(value, str):
            result[key] = value[:240]
        elif isinstance(value, (int, float, bool)) or value is None:
            result[key] = value
    return result


def error_payload(service: str, operation: str, technical_code: str, user_message: str, reportable: bool = True, details: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "success": False,
        "service": service,
        "operation": operation,
        "technicalCode": technical_code,
        "userMessage": user_message,
        "reportable": reportable,
        "details": sanitize_details(details or {}),
    }


def error_response(status_code: int, operation: str, technical_code: str, user_message: str, reportable: bool = True, details: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content=error_payload(
            "text_to_speech",
            operation,
            technical_code,
            user_message,
            reportable,
            {"httpStatus": status_code, **(details or {})},
        ),
    )


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


def voice_for(model: str, voice_id: str) -> dict[str, str] | None:
    for voice in VOICE_OPTIONS:
        if voice["model"] == model and voice["id"] == voice_id:
            return voice
    return None


def lang_code_for_voice(voice_id: str) -> str:
    prefix = voice_id[0].lower() if voice_id else "a"
    return {
        "a": "a",
        "b": "b",
        "e": "e",
        "f": "f",
        "h": "h",
        "i": "i",
        "j": "j",
        "p": "p",
        "z": "z",
    }.get(prefix, "a")


def write_wav(path: Path, samples: Any, sample_rate: int = 24000) -> None:
    try:
        import numpy as np
        if isinstance(samples, list):
            normalized = []
            for item in samples:
                if hasattr(item, "detach"):
                    item = item.detach().cpu().numpy()
                normalized.append(np.asarray(item, dtype=np.float32).reshape(-1))
            samples = np.concatenate(normalized) if normalized else np.asarray([], dtype=np.float32)
        elif hasattr(samples, "detach"):
            samples = samples.detach().cpu().numpy()
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        pcm = np.clip(samples, -1.0, 1.0)
        pcm16 = (pcm * 32767).astype(np.int16)
        data = pcm16.tobytes()
    except Exception:
        data = bytes(samples)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(data)


def audio_from_kokoro_chunk(chunk: Any) -> Any:
    audio = getattr(chunk, "audio", None)
    if audio is not None:
        return audio
    output = getattr(chunk, "output", None)
    output_audio = getattr(output, "audio", None) if output is not None else None
    if output_audio is not None:
        return output_audio
    if isinstance(chunk, dict) and chunk.get("audio") is not None:
        return chunk["audio"]
    if isinstance(chunk, (tuple, list)) and len(chunk) >= 3:
        return chunk[2]
    raise RuntimeError("text_to_speech_audio_missing")


class TTSProvider:
    def __init__(self, state: RuntimeState):
        self.state = state

    async def synthesize(self, request: SynthesizeRequest) -> dict[str, Any]:
        text = request.text.strip()
        model = request.model.strip()
        voice = request.voice.strip()
        if not text:
            raise HTTPException(status_code=400, detail=error_payload("text_to_speech", "synthesize", "text_to_speech_text_required", "Text is required.", False))
        if len(text) > self.state.max_text_characters:
            raise HTTPException(status_code=413, detail=error_payload("text_to_speech", "synthesize", "text_to_speech_text_too_long", "Text is too long.", False, {"textLength": len(text)}))
        selected_voice = voice_for(model, voice)
        if not selected_voice:
            raise HTTPException(status_code=400, detail=error_payload("text_to_speech", "synthesize", "text_to_speech_voice_not_supported", "Voice is not supported.", False, {"model": model, "voice": voice}))
        if request.format != "wav":
            raise HTTPException(status_code=400, detail=error_payload("text_to_speech", "synthesize", "text_to_speech_format_not_supported", "Audio format is not supported.", False, {"format": request.format}))

        job = {
            "id": str(uuid.uuid4()),
            "status": "queued",
            "model": model,
            "voice": voice,
            "textLength": len(text),
            "format": request.format,
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
        }
        self.state.jobs.append(job)
        self.state.jobs = self.state.jobs[-100:]
        self.state.log_event("job_queued", {"model": model, "voice": voice, "textLength": len(text), "format": request.format, "queueDepth": self.state.queued_jobs})
        async with self.state.semaphore:
            job["status"] = "running"
            job["updatedAt"] = now_iso()
            self.state.log_event("job_started", {"model": model, "voice": voice, "textLength": len(text), "format": request.format})
            try:
                pipeline = await asyncio.to_thread(self.state.load_model, model, lang_code_for_voice(voice))
                chunks = await asyncio.to_thread(lambda: list(pipeline(text, voice=voice, speed=max(0.25, min(4.0, request.speed)))))
                audio_chunks = []
                for chunk in chunks:
                    audio_chunks.append(audio_from_kokoro_chunk(chunk))
                if not audio_chunks:
                    raise RuntimeError("text_to_speech_empty_audio")
                audio = audio_chunks[0] if len(audio_chunks) == 1 else audio_chunks
                output_path = self.state.output_root() / f"{job['id']}.wav"
                await asyncio.to_thread(write_wav, output_path, audio)
                raw = output_path.read_bytes()
                duration_seconds = max(0.0, (len(raw) - 44) / float(24000 * 2))
                job["status"] = "completed"
                job["updatedAt"] = now_iso()
                job["durationSeconds"] = duration_seconds
                self.state.log_event("job_completed", {"model": model, "voice": voice, "textLength": len(text), "format": request.format})
                return {
                    "success": True,
                    "text": text,
                    "model": model,
                    "voice": voice,
                    "language": selected_voice["language"],
                    "locale": selected_voice.get("locale"),
                    "format": "wav",
                    "audioPath": str(output_path),
                    "audioDataBase64": base64.b64encode(raw).decode("ascii"),
                    "mimeType": "audio/wav",
                    "durationSeconds": duration_seconds,
                    "userMessage": "Speech synthesized.",
                }
            except Exception as exc:
                technical_code = str(exc) or "text_to_speech_synthesis_failed"
                job["status"] = "failed"
                job["updatedAt"] = now_iso()
                job["error"] = technical_code
                job["technicalCode"] = technical_code
                self.state.log_event("job_failed", {"model": model, "voice": voice, "textLength": len(text), "format": request.format, "technicalCode": technical_code, "reportable": True})
                return error_payload(
                    "text_to_speech",
                    "synthesize",
                    technical_code,
                    "Text to speech failed.",
                    True,
                    {"model": model, "voice": voice, "format": request.format, "textLength": len(text)},
                )


def make_app(state: RuntimeState) -> FastAPI:
    app = FastAPI(title="Forger Text to Speech")
    provider = TTSProvider(state)

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_request, exc: HTTPException):
        if isinstance(exc.detail, dict) and exc.detail.get("technicalCode"):
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return error_response(exc.status_code, "request", str(exc.detail), "Text to speech request failed.", exc.status_code >= 500)

    @app.get("/health")
    async def health(authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return {"ok": True, "activeJobs": state.active_jobs, "queuedJobs": state.queued_jobs}

    @app.get("/v1/models")
    async def models(authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return {"models": MODEL_OPTIONS}

    @app.get("/v1/voices")
    async def voices(authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return {"voices": [{**voice, "installed": True, "enabled": True} for voice in VOICE_OPTIONS]}

    @app.get("/v1/jobs")
    async def jobs(authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return {"jobs": state.jobs[-100:]}

    @app.post("/v1/synthesize")
    async def synthesize(request: SynthesizeRequest, authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return await provider.synthesize(request)

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", default=os.environ.get("FORGER_TTS_TOKEN"))
    parser.add_argument("--metadata-root", required=True)
    parser.add_argument("--log-path")
    parser.add_argument("--max-text-characters", type=int, default=4000)
    parser.add_argument("--max-concurrent-jobs", type=int, default=1)
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()

    import uvicorn

    if not args.token:
        raise SystemExit("FORGER_TTS_TOKEN is required")
    metadata_root = Path(args.metadata_root)
    metadata_root.mkdir(parents=True, exist_ok=True)
    state = RuntimeState(
        metadata_root=metadata_root,
        token=args.token,
        max_text_characters=args.max_text_characters,
        max_concurrent_jobs=args.max_concurrent_jobs,
        log_path=Path(args.log_path) if args.log_path else metadata_root / "logs" / "server.jsonl",
    )
    start_parent_watchdog(args.parent_pid, state)
    state.log_event("server_start", {"status": "starting"})
    uvicorn.run(make_app(state), host=args.host, port=args.port, log_level=os.environ.get("FORGER_TTS_LOG_LEVEL", "warning"))


if __name__ == "__main__":
    main()
