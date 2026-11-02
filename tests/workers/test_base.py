"""The workers' shared interface and GPU lock (workers/base.py)."""

import base64
import json
import os
import threading

import pytest
import requests

from tests.workers.fakes import Response, Session
from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.workers.base import (
    MODEL_ALIASES,
    CircuitBreaker,
    CircuitOpen,
    GpuLock,
    GpuLockTimeout,
    LocalLlmClient,
    LocalLlmError,
    LocalWorker,
    WorkerHealth,
)


def test_lock_creates_the_index_dir_and_records_its_holder(tmp_path):
    index_dir = tmp_path / "vector-index"
    with GpuLock(index_dir) as lock:
        assert lock.locked
        assert lock.path == index_dir / ".gpu.lock"
        assert lock.path.read_text(encoding="utf-8").strip() == str(os.getpid())
    assert not lock.locked
    assert lock.path.read_text(encoding="utf-8") == ""


def test_a_second_holder_waits_until_the_first_releases(tmp_path):
    first = GpuLock(tmp_path)
    first.acquire()
    with pytest.raises(GpuLockTimeout):
        GpuLock(tmp_path, timeout=0.05, poll_interval=0.01).acquire()
    first.release()
    with GpuLock(tmp_path, timeout=0) as second:
        assert second.locked


def test_threads_in_one_process_take_turns(tmp_path):
    holder = GpuLock(tmp_path)
    holder.acquire()
    acquired = threading.Event()

    def wait_for_lock():
        with GpuLock(tmp_path, timeout=5, poll_interval=0.01):
            acquired.set()

    thread = threading.Thread(target=wait_for_lock)
    thread.start()
    assert not acquired.wait(0.1)
    holder.release()
    thread.join(5)
    assert acquired.is_set()


def test_lock_is_released_when_the_work_fails(tmp_path):
    lock = GpuLock(tmp_path)
    with pytest.raises(ValueError), lock:
        raise ValueError("model crashed")
    assert not lock.locked
    with GpuLock(tmp_path, timeout=0):
        pass


def test_one_lock_cannot_be_acquired_twice(tmp_path):
    with GpuLock(tmp_path) as lock, pytest.raises(RuntimeError):
        lock.acquire()
    lock.release()


def test_for_config_uses_the_index_dir(monkeypatch, tmp_path):
    monkeypatch.setenv("VIBECUT_INDEX_DIR", str(tmp_path))
    lock = GpuLock.for_config(OrchestratorConfig.from_env(), timeout=1)
    assert lock.path == tmp_path / ".gpu.lock"
    assert lock.timeout == 1


def test_local_worker_protocol():
    class StubWorker:
        name = "whisper"

        def health(self) -> WorkerHealth:
            return {
                "worker": "whisper",
                "backend": "mlx-whisper",
                "model": "m",
                "available": True,
                "detail": "",
            }

    assert isinstance(StubWorker(), LocalWorker)
    assert not isinstance(object(), LocalWorker)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_circuit_breaker_opens_and_half_opens():
    clock = FakeClock()
    breaker = CircuitBreaker("the model", failure_threshold=2, reset_seconds=10, clock=clock)
    for _ in range(2):
        with pytest.raises(OSError), breaker.guard():
            raise OSError("down")
    assert breaker.state == "open"
    with pytest.raises(CircuitOpen, match="the model failed 2 times"), breaker.guard():
        pass
    clock.now = 10
    assert breaker.state == "half-open"
    with breaker.guard():
        pass
    assert breaker.state == "closed"


def test_circuit_breaker_resets_on_success():
    breaker = CircuitBreaker("m", failure_threshold=2)
    breaker.record_failure()
    breaker.record_success()
    breaker.record_failure()
    assert breaker.state == "closed"


def ollama_chat(answer: dict) -> Response:
    return Response(200, {"message": {"content": json.dumps(answer)}})


def test_client_speaks_ollama(tmp_path):
    image = tmp_path / "frame.jpg"
    image.write_bytes(b"\xff\xd8jpeg")
    session = Session(
        {
            "/api/chat": lambda body: ollama_chat({"echo": body["format"]["title"]}),
            "/api/embed": Response(200, {"embeddings": [[1, 0], [0, 1]]}),
            "/api/tags": Response(200, {"models": [{"name": "gemma3:4b-it"}, {"name": "bge-m3:latest"}]}),
        }
    )
    client = LocalLlmClient("http://local:11434/", session=session)
    assert client.chat_json("m", "hi", {"title": "T"}, images=[image]) == {"echo": "T"}
    route, body = session.calls[0]
    assert (
        route == "/api/chat"
        and body["messages"][0]["images"] == [base64.b64encode(b"\xff\xd8jpeg").decode()]
        and body["stream"] is False
    )
    assert client.embed("bge-m3", ["a", "b"]) == [[1.0, 0.0], [0.0, 1.0]]
    assert "keep_alive" not in session.calls[-1][1]
    client.embed("bge-m3", ["a", "b"], keep_alive="30m")
    assert session.calls[-1][1]["keep_alive"] == "30m"
    assert client.has_model("gemma3:4b-it")[0]
    assert client.has_model("bge-m3")[0]
    assert not client.has_model("qwen2.5-vl:7b-instruct")[0]


def test_the_configured_model_or_the_first_alias_the_server_has():
    """Model migration v2: a machine with only an older tag pulled still runs the worker."""
    tags = {"models": [{"name": "qwen2.5vl:7b"}, {"name": "gemma3:4b-it"}, {"name": "bge-m3:latest"}]}
    client = LocalLlmClient("http://local", session=Session({"/api/tags": Response(200, tags)}))
    assert client.resolve_available_model("qwen3-vl:8b-instruct") == "qwen2.5vl:7b"
    assert client.resolve_available_model("gemma3:4b") == "gemma3:4b-it"
    assert client.resolve_available_model("bge-m3") == "bge-m3", "an untagged name is its :latest"
    # Nothing to stand in: the configured name, so the call's own error names it.
    assert client.resolve_available_model("llava:13b") == "llava:13b"
    available, detail = client.has_model("qwen3-vl:8b-instruct")
    assert available and detail == "qwen2.5vl:7b is ready on http://local (in place of qwen3-vl:8b-instruct)"
    # The reasoning qwen3-vl:8b never stands in: it took two minutes a shot (seen live, 2026-11-02).
    assert (
        all("qwen3-vl:8b" not in aliases for aliases in MODEL_ALIASES.values())
        and "qwen3-vl:8b" not in MODEL_ALIASES
    )
    # An embedding model is never stood in for: an index is bound to the model that built it.
    assert "bge-m3" not in MODEL_ALIASES and "nomic-embed-text" not in MODEL_ALIASES
    down = LocalLlmClient("http://local", session=Session({}))
    assert down.resolve_available_model("qwen3-vl:8b-instruct") == "qwen3-vl:8b-instruct"


def test_chat_json_keeps_the_model_loaded_when_asked_and_takes_image_bytes():
    session = Session({"/api/chat": lambda body: ollama_chat({"ok": True})})
    client = LocalLlmClient("http://local", session=session)
    client.chat_json("m", "hi", {}, images=[b"\xff\xd8raw"], keep_alive="10m", think=False)
    body = session.calls[-1][1]
    assert body["keep_alive"] == "10m" and body["think"] is False
    assert body["messages"][0]["images"] == [base64.b64encode(b"\xff\xd8raw").decode()]
    client.chat_json("m", "hi", {})
    assert "keep_alive" not in session.calls[-1][1] and "think" not in session.calls[-1][1]


def test_client_falls_back_to_openai_routes():
    session = Session(
        {
            "/v1/chat/completions": Response(200, {"choices": [{"message": {"content": '{"ok": true}'}}]}),
            "/v1/embeddings": Response(
                200, {"data": [{"index": 1, "embedding": [2]}, {"index": 0, "embedding": [1]}]}
            ),
            "/v1/models": Response(200, {"data": [{"id": "gemma"}]}),
        }
    )
    client = LocalLlmClient("http://local:8080", session=session)
    assert client.chat_json("m", "hi", {}) == {"ok": True}
    assert client.embed("e", ["a", "b"]) == [[1.0], [2.0]]
    # Once it knows, it goes straight to the OpenAI routes.
    assert [route for route, _ in session.calls] == ["/api/chat", "/v1/chat/completions", "/v1/embeddings"]
    assert client.has_model("gemma")[0]


def test_client_errors():
    client = LocalLlmClient("http://local", session=Session({"/api/chat": Response(500, text="boom")}))
    with pytest.raises(LocalLlmError, match="refused the request \\(500\\): boom"):
        client.chat_json("m", "hi", {})
    client = LocalLlmClient("http://local", session=Session({"/api/chat": ollama_chat([1, 2])}))  # type: ignore[arg-type]
    with pytest.raises(LocalLlmError, match="isn't an object"):
        client.chat_json("m", "hi", {})
    client = LocalLlmClient(
        "http://local", session=Session({"/api/embed": Response(200, {"embeddings": [[1]]})})
    )
    with pytest.raises(LocalLlmError, match="1 embeddings for 2 texts"):
        client.embed("e", ["a", "b"])
    assert client.embed("e", []) == []


def test_client_unreachable():
    class Down:
        def post(self, *args, **kwargs):
            raise requests.ConnectionError("refused")

        def get(self, *args, **kwargs):
            raise requests.ConnectionError("refused")

    client = LocalLlmClient("http://local", session=Down())  # type: ignore[arg-type]
    with pytest.raises(LocalLlmError, match="didn't answer"):
        client.embed("e", ["a"])
    available, detail = client.has_model("m")
    assert not available and "isn't answering" in detail
