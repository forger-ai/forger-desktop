import argparse
import asyncio
import json
import multiprocessing
import os
import audioop
import tempfile
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel


class ProcessRequest(BaseModel):
    path: str
    task: str = "transcribe"
    language: str | None = None


class RuntimeState:
    def __init__(self, metadata_root: Path, token: str, model_name: str, max_concurrent_jobs: int, max_realtime_sessions: int, log_path: Path | None = None):
        self.metadata_root = metadata_root
        self.token = token
        self.model_name = model_name
        self.jobs: list[dict[str, Any]] = []
        self.processed_files: list[dict[str, Any]] = self._read_processed_files()
        self.semaphore = asyncio.Semaphore(max(1, max_concurrent_jobs))
        self.realtime_semaphore = asyncio.Semaphore(max(1, max_realtime_sessions))
        self.active_realtime_sessions = 0
        self.realtime_queue_depth = 0
        self.realtime_active_jobs = 0
        self.last_realtime_factor = 0.0
        self.realtime_vad_mode = "unknown"
        self.model = None
        self.log_path = log_path

    @property
    def active_jobs(self) -> int:
        return len([job for job in self.jobs if job["status"] == "running"])

    @property
    def queued_jobs(self) -> int:
        return len([job for job in self.jobs if job["status"] == "queued"])

    def _processed_path(self) -> Path:
        return self.metadata_root / "processed-files.json"

    def _read_processed_files(self) -> list[dict[str, Any]]:
        try:
            return json.loads(self._processed_path().read_text(encoding="utf-8"))
        except Exception:
            return []

    def _write_processed_files(self) -> None:
        self.metadata_root.mkdir(parents=True, exist_ok=True)
        self._processed_path().write_text(json.dumps(self.processed_files[-250:], indent=2), encoding="utf-8")

    def check_token(self, authorization: str | None) -> None:
        if authorization != f"Bearer {self.token}":
            raise HTTPException(status_code=401, detail=error_payload("speech_to_text", "auth", "unauthorized", "Speech to text is not authorized.", False, {"httpStatus": 401}))

    def websocket_authorized(self, websocket: WebSocket) -> bool:
        authorization = websocket.headers.get("authorization")
        token = websocket.query_params.get("token")
        return authorization == f"Bearer {self.token}" or token == self.token

    def load_model(self):
        if self.model is not None:
            return self.model
        try:
            from faster_whisper import WhisperModel
        except Exception as exc:
            raise RuntimeError("faster_whisper_not_installed") from exc
        self.model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
        return self.model

    def log_event(self, event: str, payload: dict[str, Any] | None = None) -> None:
        if self.log_path is None:
            return
        try:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)
            with self.log_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"timestamp": now_iso(), "service": "speech_to_text", "event": event, **sanitize_details(payload or {})}, ensure_ascii=True) + "\n")
        except Exception:
            pass


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def sanitize_details(details: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "audioDurationSeconds",
        "durationSeconds",
        "elapsedMs",
        "httpStatus",
        "kind",
        "language",
        "lastRealtimeFactor",
        "model",
        "operation",
        "queueDepth",
        "realtimeActiveJobs",
        "realtimeFactor",
        "realtimeQueueDepth",
        "reportable",
        "segmentId",
        "service",
        "sizeBytes",
        "status",
        "task",
        "technicalCode",
        "vadMode",
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
            "speech_to_text",
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


def write_wav(path: Path, pcm: bytes, sample_rate: int = 16000) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm)


def pcm_duration_seconds(pcm: bytes, sample_rate: int = 16000) -> float:
    return len(pcm) / float(sample_rate * 2)


def pcm_is_speech(pcm: bytes, threshold: int = 450) -> bool:
    if len(pcm) < 2:
        return False
    try:
        return audioop.rms(pcm, 2) >= threshold
    except Exception:
        return False


class VoiceActivityDetector:
    frame_duration_ms = 20
    frame_bytes = 640

    def __init__(self, state: RuntimeState):
        self.state = state
        self.mode = "rms"
        self.vad = None
        try:
            import webrtcvad
            self.vad = webrtcvad.Vad(2)
            self.mode = "webrtcvad"
        except Exception:
            self.state.log_event("vad_fallback_rms", {"vadMode": "rms", "technicalCode": "webrtcvad_unavailable"})
        self.state.realtime_vad_mode = self.mode

    def is_speech(self, pcm: bytes, sample_rate: int) -> bool:
        if self.vad is not None and sample_rate in {8000, 16000, 32000, 48000} and len(pcm) in {sample_rate // 100 * 2, sample_rate // 50 * 2, sample_rate * 3 // 100 * 2}:
            try:
                return bool(self.vad.is_speech(pcm, sample_rate))
            except Exception:
                self.vad = None
                self.mode = "rms"
                self.state.realtime_vad_mode = self.mode
                self.state.log_event("vad_fallback_rms", {"vadMode": "rms", "technicalCode": "webrtcvad_failed"})
        return pcm_is_speech(pcm)


def transcribe_pcm_sync(model: Any, pcm: bytes, task: str, language: str | None, sample_rate: int = 16000) -> dict[str, Any]:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as handle:
        temp_path = Path(handle.name)
    try:
        write_wav(temp_path, pcm, sample_rate)
        kwargs: dict[str, Any] = {"task": task}
        if language:
            kwargs["language"] = language
        segments, info = model.transcribe(str(temp_path), **kwargs)
        text = " ".join(segment.text.strip() for segment in segments).strip()
        return {
            "text": text,
            "language": str(getattr(info, "language", "") or ""),
            "durationSeconds": float(getattr(info, "duration", 0) or 0),
        }
    finally:
        temp_path.unlink(missing_ok=True)


def realtime_transcription_worker(model_name: str, job_queue: Any, result_queue: Any) -> None:
    model = None
    while True:
        job = job_queue.get()
        if job is None:
            return
        started = time.monotonic()
        try:
            if model is None:
                from faster_whisper import WhisperModel
                model = WhisperModel(model_name, device="cpu", compute_type="int8")
            result = transcribe_pcm_sync(
                model,
                job["pcm"],
                job.get("task") or "transcribe",
                job.get("language"),
                int(job.get("sampleRate") or 16000),
            )
            elapsed_ms = int((time.monotonic() - started) * 1000)
            audio_duration = float(job.get("audioDurationSeconds") or 0)
            result_queue.put({
                **job,
                **result,
                "success": True,
                "elapsedMs": elapsed_ms,
                "realtimeFactor": (elapsed_ms / 1000.0) / audio_duration if audio_duration > 0 else 0.0,
            })
        except Exception as exc:
            elapsed_ms = int((time.monotonic() - started) * 1000)
            result_queue.put({
                **job,
                "success": False,
                "elapsedMs": elapsed_ms,
                "technicalCode": str(exc) or "speech_realtime_transcribe_failed",
            })


class RealtimeTranscriptionWorker:
    def __init__(self, state: RuntimeState, session_id: str, task: str, language: str | None, sample_rate: int):
        self.state = state
        self.session_id = session_id
        self.task = task
        self.language = language
        self.sample_rate = sample_rate
        ctx = multiprocessing.get_context("spawn")
        self.job_queue = ctx.Queue()
        self.result_queue = ctx.Queue()
        self.process = ctx.Process(
            target=realtime_transcription_worker,
            args=(state.model_name, self.job_queue, self.result_queue),
            daemon=True,
        )
        self.busy = False
        self.next_final: dict[str, Any] | None = None
        self.next_partial: dict[str, Any] | None = None
        self.process.start()

    def submit(self, kind: str, segment_id: str, pcm: bytes) -> None:
        if pcm_duration_seconds(pcm, self.sample_rate) < 0.35:
            return
        job = {
            "id": str(uuid.uuid4()),
            "sessionId": self.session_id,
            "segmentId": segment_id,
            "kind": kind,
            "pcm": pcm,
            "task": self.task,
            "language": self.language,
            "sampleRate": self.sample_rate,
            "audioDurationSeconds": pcm_duration_seconds(pcm, self.sample_rate),
        }
        if not self.busy:
            self._send(job)
            return
        if kind == "final":
            self.next_final = job
            self.next_partial = None
            self._sync_metrics()
            self.state.log_event("realtime_transcribe_job_queued", self._log_payload(job))
            return
        if self.next_final is not None:
            return
        if self.next_partial is not None:
            self.state.log_event("realtime_partial_coalesced", self._log_payload(job))
        self.next_partial = job
        self._sync_metrics()

    def complete_current(self) -> dict[str, Any] | None:
        self.busy = False
        next_job = self.next_final or self.next_partial
        self.next_final = None
        self.next_partial = None
        if next_job is not None:
            self._send(next_job)
        else:
            self._sync_metrics()
        return next_job

    def _send(self, job: dict[str, Any]) -> None:
        self.busy = True
        self.job_queue.put(job)
        self._sync_metrics()
        self.state.log_event("realtime_transcribe_job_queued", self._log_payload(job))
        self.state.log_event("realtime_transcribe_job_started", self._log_payload(job))

    def _sync_metrics(self) -> None:
        self.state.realtime_active_jobs = 1 if self.busy else 0
        self.state.realtime_queue_depth = int(self.next_final is not None) + int(self.next_partial is not None)

    def _log_payload(self, job: dict[str, Any]) -> dict[str, Any]:
        return {
            "segmentId": str(job.get("segmentId") or ""),
            "kind": str(job.get("kind") or ""),
            "audioDurationSeconds": float(job.get("audioDurationSeconds") or 0),
            "queueDepth": self.state.realtime_queue_depth,
            "model": self.state.model_name,
            "vadMode": self.state.realtime_vad_mode,
        }

    def stop(self) -> None:
        try:
            self.job_queue.put(None)
        except Exception:
            pass
        if self.process.is_alive():
            self.process.join(timeout=0.5)
        if self.process.is_alive():
            self.process.terminate()
        self.state.realtime_active_jobs = 0
        self.state.realtime_queue_depth = 0


async def transcribe_pcm_window(state: RuntimeState, pcm: bytes, task: str, language: str | None) -> dict[str, Any]:
    model = await asyncio.to_thread(state.load_model)
    return await asyncio.to_thread(transcribe_pcm_sync, model, pcm, task, language, 16000)


def make_app(state: RuntimeState) -> FastAPI:
    app = FastAPI(title="Forger Speech to Text")

    @app.exception_handler(HTTPException)
    async def http_exception_handler(_request, exc: HTTPException):
        if isinstance(exc.detail, dict) and exc.detail.get("technicalCode"):
            return JSONResponse(status_code=exc.status_code, content=exc.detail)
        return error_response(exc.status_code, "request", str(exc.detail), "Speech to text request failed.", exc.status_code >= 500)

    @app.get("/health")
    async def health(authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return {
            "ok": True,
            "model": state.model_name,
            "activeJobs": state.active_jobs,
            "queuedJobs": state.queued_jobs,
            "activeRealtimeSessions": state.active_realtime_sessions,
            "realtimeQueueDepth": state.realtime_queue_depth,
            "realtimeActiveJobs": state.realtime_active_jobs,
            "lastRealtimeFactor": state.last_realtime_factor,
            "vadMode": state.realtime_vad_mode,
        }

    @app.get("/v1/jobs")
    async def list_jobs(authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return {"jobs": state.jobs[-100:]}

    @app.get("/v1/processed-files")
    async def list_processed_files(authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return {"processedFiles": state.processed_files[-250:]}

    async def process_audio(input_data: ProcessRequest) -> dict[str, Any]:
        task = input_data.task if input_data.task in {"transcribe", "translate"} else "transcribe"
        audio_path = Path(input_data.path).expanduser().resolve()
        if not audio_path.exists() or not audio_path.is_file():
            raise HTTPException(status_code=400, detail=error_payload("speech_to_text", task, "audio_file_missing", "Audio file is missing.", False))
        size_bytes = audio_path.stat().st_size

        job = {
            "id": str(uuid.uuid4()),
            "task": task,
            "path": str(audio_path),
            "model": state.model_name,
            "status": "queued",
            "createdAt": now_iso(),
            "updatedAt": now_iso(),
            "sizeBytes": size_bytes,
        }
        state.jobs.append(job)
        state.jobs = state.jobs[-100:]
        state.log_event("job_queued", {"task": task, "sizeBytes": size_bytes, "queueDepth": state.queued_jobs, "model": state.model_name})
        async with state.semaphore:
            job["status"] = "running"
            job["updatedAt"] = now_iso()
            state.log_event("job_started", {"task": task, "sizeBytes": size_bytes, "model": state.model_name})
            try:
                model = await asyncio.to_thread(state.load_model)
                kwargs: dict[str, Any] = {"task": task}
                if input_data.language:
                    kwargs["language"] = input_data.language
                segments, info = await asyncio.to_thread(model.transcribe, str(audio_path), **kwargs)
                text = " ".join(segment.text.strip() for segment in segments).strip()
                duration = float(getattr(info, "duration", 0) or 0)
                language = str(getattr(info, "language", "") or "")
                job.update({
                    "status": "completed",
                    "updatedAt": now_iso(),
                    "durationSeconds": duration,
                    "language": language,
                    "model": state.model_name,
                    "text": text,
                })
                state.processed_files.append({
                    "path": str(audio_path),
                    "task": task,
                    "processedAt": job["updatedAt"],
                    "durationSeconds": duration,
                    "sizeBytes": size_bytes,
                    "language": language,
                    "model": state.model_name,
                    "textPreview": text[:240],
                })
                state._write_processed_files()
                state.log_event("job_completed", {"task": task, "sizeBytes": size_bytes, "durationSeconds": duration, "language": language, "model": state.model_name})
            except Exception as exc:
                technical_code = str(exc) or "speech_to_text_failed"
                job.update({
                    "status": "failed",
                    "updatedAt": now_iso(),
                    "error": technical_code,
                    "technicalCode": technical_code,
                })
                state.log_event("job_failed", {"task": task, "sizeBytes": size_bytes, "technicalCode": technical_code, "reportable": True, "model": state.model_name})
            return job

    @app.post("/v1/transcribe")
    async def transcribe(input_data: ProcessRequest, authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return await process_audio(ProcessRequest(**{**input_data.model_dump(), "task": "transcribe"}))

    @app.post("/v1/translate")
    async def translate(input_data: ProcessRequest, authorization: str | None = Header(default=None)):
        state.check_token(authorization)
        return await process_audio(ProcessRequest(**{**input_data.model_dump(), "task": "translate"}))

    @app.websocket("/v1/realtime/transcribe")
    async def realtime_transcribe(websocket: WebSocket):
        if not state.websocket_authorized(websocket):
            await websocket.close(code=1008, reason="unauthorized")
            return
        try:
            await asyncio.wait_for(state.realtime_semaphore.acquire(), timeout=0.01)
        except asyncio.TimeoutError:
            await websocket.close(code=1013, reason="too_many_realtime_sessions")
            return

        await websocket.accept()
        state.active_realtime_sessions += 1
        session_id = str(uuid.uuid4())
        state.log_event("realtime_started", {"model": state.model_name})
        task = "transcribe"
        language: str | None = None
        sample_rate = 16000
        vad = VoiceActivityDetector(state)
        vad_buffer = bytearray()
        segment_id = str(uuid.uuid4())
        speech_buffer: bytearray = bytearray()
        speech_active = False
        silence_seconds = 0.0
        last_partial_at = 0.0
        min_partial_seconds = 2.0
        max_window_seconds = 8.0
        final_silence_seconds = 0.8
        worker: RealtimeTranscriptionWorker | None = None
        result_task: asyncio.Task[None] | None = None
        send_lock = asyncio.Lock()
        async def emit(kind: str, payload: dict[str, Any] | None = None) -> None:
            async with send_lock:
                await websocket.send_text(json.dumps({"type": kind, "sessionId": session_id, **(payload or {})}))

        def submit_current(final: bool) -> None:
            nonlocal speech_buffer, last_partial_at, speech_active, silence_seconds, segment_id
            if worker is None:
                return
            if pcm_duration_seconds(speech_buffer, sample_rate) < 0.35:
                return
            worker.submit("final" if final else "partial", segment_id, bytes(speech_buffer))
            if final:
                state.log_event("realtime_segment_finalized", {
                    "segmentId": segment_id,
                    "audioDurationSeconds": pcm_duration_seconds(speech_buffer, sample_rate),
                    "model": state.model_name,
                    "vadMode": vad.mode,
                })
                speech_buffer = bytearray()
                speech_active = False
                silence_seconds = 0.0
                segment_id = str(uuid.uuid4())
            else:
                last_partial_at = time.monotonic()

        async def result_pump() -> None:
            assert worker is not None
            while True:
                result = await asyncio.to_thread(worker.result_queue.get)
                state.realtime_active_jobs = 0
                if result.get("success") is True:
                    state.last_realtime_factor = float(result.get("realtimeFactor") or 0)
                    event = "final_transcript" if result.get("kind") == "final" else "partial_transcript"
                    state.log_event("realtime_transcribe_job_completed", {
                        "segmentId": str(result.get("segmentId") or ""),
                        "kind": str(result.get("kind") or ""),
                        "audioDurationSeconds": float(result.get("audioDurationSeconds") or 0),
                        "elapsedMs": int(result.get("elapsedMs") or 0),
                        "realtimeFactor": state.last_realtime_factor,
                        "model": state.model_name,
                        "vadMode": vad.mode,
                    })
                    await emit(event, {
                        "segmentId": result.get("segmentId"),
                        "kind": result.get("kind"),
                        "text": result.get("text") or "",
                        "language": result.get("language") or "",
                        "durationSeconds": result.get("durationSeconds") or 0,
                        "audioDurationSeconds": result.get("audioDurationSeconds") or 0,
                        "transcribeElapsedMs": result.get("elapsedMs") or 0,
                    })
                    if result.get("kind") == "final":
                        await emit("speech_ended", {"segmentId": result.get("segmentId")})
                else:
                    technical_code = str(result.get("technicalCode") or "speech_realtime_transcribe_failed")
                    state.log_event("realtime_transcribe_failed", {"task": task, "technicalCode": technical_code, "reportable": True, "model": state.model_name})
                    await emit("error", {"error": technical_code, "technicalCode": technical_code, "reportable": True})
                worker.complete_current()

        try:
            await emit("ready", {"sampleRate": sample_rate, "format": "pcm_s16le", "vadMode": vad.mode})
            while True:
                message = await websocket.receive()
                if "bytes" in message and message["bytes"] is not None:
                    frame = message["bytes"]
                elif "text" in message and message["text"] is not None:
                    control = json.loads(message["text"])
                    control_type = control.get("type")
                    if control_type == "start":
                        task = control.get("task") if control.get("task") in {"transcribe", "translate"} else "transcribe"
                        language = control.get("language") if isinstance(control.get("language"), str) else None
                        sample_rate = int(control.get("sampleRate") or 16000)
                        if sample_rate != 16000 or control.get("format", "pcm_s16le") != "pcm_s16le":
                            await emit("error", {"error": "unsupported_realtime_audio_format", "technicalCode": "unsupported_realtime_audio_format", "reportable": False})
                            await websocket.close(code=1003, reason="unsupported_realtime_audio_format")
                            return
                        worker = RealtimeTranscriptionWorker(state, session_id, task, language, sample_rate)
                        result_task = asyncio.create_task(result_pump())
                        continue
                    if control_type == "end":
                        submit_current(final=True)
                        await websocket.close(code=1000)
                        return
                    if control_type == "cancel":
                        await websocket.close(code=1000)
                        return
                    continue
                else:
                    continue

                if len(frame) % 2 != 0:
                    await emit("error", {"error": "invalid_pcm_frame", "technicalCode": "invalid_pcm_frame", "reportable": False})
                    continue
                vad_buffer.extend(frame)
                while len(vad_buffer) >= VoiceActivityDetector.frame_bytes:
                    vad_frame = bytes(vad_buffer[:VoiceActivityDetector.frame_bytes])
                    del vad_buffer[:VoiceActivityDetector.frame_bytes]
                    frame_is_speech = vad.is_speech(vad_frame, sample_rate)
                    if frame_is_speech:
                        if not speech_active:
                            speech_active = True
                            silence_seconds = 0.0
                            speech_buffer = bytearray()
                            state.log_event("realtime_segment_started", {"segmentId": segment_id, "model": state.model_name, "vadMode": vad.mode})
                            await emit("speech_started", {"segmentId": segment_id})
                        silence_seconds = 0.0
                        speech_buffer.extend(vad_frame)
                    elif speech_active:
                        silence_seconds += VoiceActivityDetector.frame_duration_ms / 1000.0
                        speech_buffer.extend(vad_frame)

                    speech_seconds = pcm_duration_seconds(speech_buffer, sample_rate)
                    if speech_active and speech_seconds >= max_window_seconds:
                        submit_current(final=True)
                    elif speech_active and speech_seconds >= min_partial_seconds and time.monotonic() - last_partial_at >= 1.2:
                        submit_current(final=False)
                    if speech_active and silence_seconds >= final_silence_seconds:
                        submit_current(final=True)
        except WebSocketDisconnect:
            return
        except Exception as exc:
            technical_code = str(exc) or "speech_realtime_failed"
            state.log_event("realtime_failed", {"task": task, "technicalCode": technical_code, "reportable": True, "model": state.model_name})
            await emit("error", {"error": technical_code, "technicalCode": technical_code, "reportable": True})
        finally:
            if result_task is not None:
                result_task.cancel()
            if worker is not None:
                worker.stop()
            state.active_realtime_sessions = max(0, state.active_realtime_sessions - 1)
            state.realtime_semaphore.release()
            state.log_event("realtime_closed", {"model": state.model_name})

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--token", default=os.environ.get("FORGER_SPEECH_TOKEN"))
    parser.add_argument("--metadata-root", required=True)
    parser.add_argument("--log-path")
    parser.add_argument("--model", default="base")
    parser.add_argument("--max-concurrent-jobs", type=int, default=1)
    parser.add_argument("--max-realtime-sessions", type=int, default=3)
    parser.add_argument("--parent-pid", type=int)
    args = parser.parse_args()

    import uvicorn

    if not args.token:
        raise SystemExit("FORGER_SPEECH_TOKEN is required")
    metadata_root = Path(args.metadata_root)
    metadata_root.mkdir(parents=True, exist_ok=True)
    state = RuntimeState(
        metadata_root=metadata_root,
        token=args.token,
        model_name=args.model,
        max_concurrent_jobs=args.max_concurrent_jobs,
        max_realtime_sessions=args.max_realtime_sessions,
        log_path=Path(args.log_path) if args.log_path else metadata_root / "logs" / "server.jsonl",
    )
    start_parent_watchdog(args.parent_pid, state)
    state.log_event("server_start", {"status": "starting", "model": args.model})
    uvicorn.run(make_app(state), host=args.host, port=args.port, log_level=os.environ.get("FORGER_SPEECH_LOG_LEVEL", "warning"))


if __name__ == "__main__":
    main()
