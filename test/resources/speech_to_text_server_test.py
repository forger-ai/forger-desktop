import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

import importlib.util


SERVER_PATH = Path(__file__).parents[2] / "resources" / "speech-to-text" / "server.py"
SPEC = importlib.util.spec_from_file_location("forger_speech_to_text_server", SERVER_PATH)
assert SPEC is not None and SPEC.loader is not None
SERVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SERVER)


class FakeSegment:
    def __init__(self, text: str):
        self.text = text


class FakeModel:
    def transcribe(self, _path: str, **_kwargs):
        return [FakeSegment(" private "), FakeSegment(" transcript ")], SimpleNamespace(
            duration=1.25,
            language="es",
        )


class SpeechToTextServerPersistenceTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.audio_path = self.root / "recording.wav"
        self.audio_path.write_bytes(b"fake wav")
        self.state = SERVER.RuntimeState(
            metadata_root=self.root / "metadata",
            token="test-token",
            model_name="base",
            max_concurrent_jobs=1,
            max_realtime_sessions=1,
        )
        self.state.model = FakeModel()
        self.client = TestClient(SERVER.make_app(self.state))
        self.headers = {"authorization": "Bearer test-token"}

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_ephemeral_job_returns_transcript_without_persisting_path_or_preview(self):
        response = self.client.post(
            "/v1/transcribe",
            headers=self.headers,
            json={"path": str(self.audio_path), "language": "es", "ephemeral": True},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "private transcript")
        self.assertEqual(self.state.processed_files, [])
        self.assertFalse((self.root / "metadata" / "processed-files.json").exists())
        self.assertEqual(
            self.client.get("/v1/processed-files", headers=self.headers).json(),
            {"processedFiles": []},
        )

    def test_ordinary_job_still_persists_path_and_preview_by_default(self):
        response = self.client.post(
            "/v1/transcribe",
            headers=self.headers,
            json={"path": str(self.audio_path), "language": "es"},
        )

        self.assertEqual(response.status_code, 200)
        persisted = json.loads((self.root / "metadata" / "processed-files.json").read_text())
        self.assertEqual(persisted[0]["path"], str(self.audio_path.resolve()))
        self.assertEqual(persisted[0]["textPreview"], "private transcript")


if __name__ == "__main__":
    unittest.main()
