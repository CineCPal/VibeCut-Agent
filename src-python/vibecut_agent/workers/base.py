"""What every local worker shares (ORCHESTRATOR_SPEC.md §1.2, §2): the health report it gives the About
modal (`WorkerHealth`), the interface it implements (`LocalWorker`), and the GPU lock (`GpuLock`).

Whisper, the VLM and the embedding model each want most of Apple Silicon's unified memory (or a GPU's
VRAM). `GpuLock` is a file lock at `<index_dir>/.gpu.lock`, so they take turns across every sidecar
process: an ingest job and a chat turn never load two models at once.

`CircuitBreaker` stops a worker calling a local model server that keeps failing, for a while, so a chat
turn reports it at once instead of waiting out a timeout per shot. `LocalLlmClient` is the HTTP client
for that server (`VIBECUT_LOCAL_LLM_BASE_URL`): Ollama's API, or the OpenAI-compatible one that
llama.cpp's server speaks when Ollama's isn't there."""

from __future__ import annotations

import base64
import fcntl
import json
import os
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from types import TracebackType
from typing import IO, TYPE_CHECKING, Any, Literal, Protocol, Self, TypedDict, runtime_checkable

import requests

if TYPE_CHECKING:
    from vibecut_agent.config import OrchestratorConfig

LOCK_FILE_NAME = ".gpu.lock"


class WorkerHealth(TypedDict):
    """One worker's state, as the About modal shows it."""

    worker: str
    backend: str
    model: str
    available: bool
    detail: str


@runtime_checkable
class LocalWorker(Protocol):
    """A local sub-agent worker (whisper_worker, vlm_worker, vector_store, gemma_validator)."""

    name: str

    def health(self) -> WorkerHealth: ...


class GpuLockTimeout(TimeoutError):
    """Another process (or thread) held the GPU lock past the caller's timeout."""


class GpuLock:
    """The inter-process GPU/Metal lock at `<index_dir>/.gpu.lock`.

    `timeout=None` waits as long as it takes; `0` tries once. Each acquire opens its own file, and
    `flock` locks belong to the open file, so two threads in one process also wait for each other.
    The holder's pid is written into the file, to tell who has it."""

    def __init__(
        self, index_dir: str | os.PathLike[str], timeout: float | None = None, poll_interval: float = 0.1
    ):
        self.path = Path(index_dir) / LOCK_FILE_NAME
        self.timeout = timeout
        self.poll_interval = poll_interval
        self._file: IO[str] | None = None

    @classmethod
    def for_config(cls, config: OrchestratorConfig, timeout: float | None = None) -> GpuLock:
        return cls(config.index_dir, timeout=timeout)

    @property
    def locked(self) -> bool:
        return self._file is not None

    def acquire(self) -> None:
        if self._file is not None:
            raise RuntimeError(f"{self.path} is already held by this GpuLock")
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+", encoding="utf-8")
        deadline = None if self.timeout is None else time.monotonic() + self.timeout
        try:
            while True:
                try:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if deadline is not None and time.monotonic() >= deadline:
                        raise GpuLockTimeout(
                            f"The GPU lock ({self.path}) was still held after {self.timeout:g} s"
                        ) from None
                    time.sleep(self.poll_interval)
            handle.seek(0)
            handle.truncate()
            handle.write(f"{os.getpid()}\n")
            handle.flush()
        except BaseException:
            handle.close()
            raise
        self._file = handle

    def release(self) -> None:
        handle, self._file = self._file, None
        if handle is None:
            return
        try:
            handle.seek(0)
            handle.truncate()
            handle.flush()
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def __enter__(self) -> Self:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.release()


class CircuitOpen(RuntimeError):
    """The worker's model server failed too often lately; it isn't called until the breaker resets."""


class CircuitBreaker:
    """Opens after `failure_threshold` failures in a row and stays open for `reset_seconds`; then one
    trial call goes through (half-open), and its success closes the breaker again."""

    def __init__(
        self,
        name: str,
        failure_threshold: int = 3,
        reset_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.name = name
        self.failure_threshold = failure_threshold
        self.reset_seconds = reset_seconds
        self._clock = clock
        self._failures = 0
        self._opened_at: float | None = None
        self._lock = threading.Lock()

    @property
    def state(self) -> Literal["closed", "open", "half-open"]:
        with self._lock:
            if self._opened_at is None:
                return "closed"
            return "half-open" if self._clock() - self._opened_at >= self.reset_seconds else "open"

    def check(self) -> None:
        """Raises CircuitOpen while the breaker is open."""
        if self.state == "open":
            raise CircuitOpen(
                f"{self.name} failed {self.failure_threshold} times in a row; it is tried again "
                f"{self.reset_seconds:g} s after the last failure"
            )

    def record_success(self) -> None:
        with self._lock:
            self._failures = 0
            self._opened_at = None

    def record_failure(self) -> None:
        with self._lock:
            self._failures += 1
            if self._failures >= self.failure_threshold:
                self._opened_at = self._clock()

    @contextmanager
    def guard(self) -> Iterator[None]:
        """Runs the block if the breaker allows it, recording whether it raised."""
        self.check()
        try:
            yield
        except Exception:
            self.record_failure()
            raise
        self.record_success()


class LocalLlmError(RuntimeError):
    """The local model server couldn't be reached, refused the request, or answered with no usable JSON."""


Dialect = Literal["ollama", "openai"]

# Other tags for the same job, in order, for a machine that has pulled one of them and not the configured
# one (model migration v2, PLAN.md D3/D14): the VLM and the validator's Gemma. Each list stays within what
# the worker's prompt and schema were written for. Embedding models have none: an index is bound to the
# model that built it (vector_store.py), so a missing one is pulled, never stood in for.
MODEL_ALIASES: dict[str, tuple[str, ...]] = {
    "qwen3-vl:8b": ("qwen2.5vl:7b", "qwen2.5-vl:7b-instruct"),
    "qwen2.5vl:7b": ("qwen2.5-vl:7b-instruct", "qwen3-vl:8b"),
    "qwen2.5-vl:7b-instruct": ("qwen2.5vl:7b", "qwen3-vl:8b"),
    "gemma3:4b": ("gemma3:4b-it-qat", "gemma3:4b-it"),
    "gemma3:4b-it": ("gemma3:4b", "gemma3:4b-it-qat"),
}


class LocalLlmClient:
    """JSON chat (with images) and embeddings from the local model server at `base_url`.

    Ollama's API (`/api/chat`, `/api/embed`, `/api/tags`) is tried first; a 404 there means llama.cpp's
    (or another) OpenAI-compatible server, and its `/v1/...` routes are used from then on. Answers are
    constrained to a JSON Schema (Ollama's `format`, OpenAI's `response_format`) and parsed here."""

    def __init__(
        self, base_url: str, timeout: float = 120.0, session: requests.Session | None = None
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._session = session or requests.Session()
        self._dialect: Dialect | None = None

    def _post(self, route: str, body: dict[str, Any]) -> requests.Response:
        try:
            return self._session.post(f"{self.base_url}{route}", json=body, timeout=self.timeout)
        except requests.RequestException as e:
            raise LocalLlmError(f"The local model server ({self.base_url}) didn't answer: {e}") from None

    def _request(
        self, ollama: tuple[str, dict[str, Any]], openai: tuple[str, dict[str, Any]]
    ) -> tuple[Dialect, Any]:
        if self._dialect != "openai":
            response = self._post(*ollama)
            if response.status_code != 404:
                self._dialect = "ollama"
                return "ollama", self._json(response)
        response = self._post(*openai)
        if response.status_code != 404:
            self._dialect = "openai"
        return "openai", self._json(response)

    @staticmethod
    def _json(response: requests.Response) -> Any:
        if response.status_code >= 400:
            detail = response.text.strip()[:300]
            raise LocalLlmError(
                f"The local model server refused the request ({response.status_code}): {detail}"
            )
        try:
            return response.json()
        except ValueError:
            raise LocalLlmError("The local model server's answer wasn't JSON") from None

    def chat_json(
        self,
        model: str,
        prompt: str,
        schema: dict[str, Any],
        *,
        images: Sequence[str | os.PathLike[str] | bytes] = (),
        system: str | None = None,
        keep_alive: str | int | None = None,
    ) -> dict[str, Any]:
        """The model's answer to `prompt` (with `images`, small JPEGs: paths, or the bytes themselves), as
        a JSON object fitting `schema`. `keep_alive` (Ollama's, as for `embed`) keeps the model loaded
        between the calls of a batch."""
        encoded = [
            base64.b64encode(image if isinstance(image, bytes) else Path(image).read_bytes()).decode("ascii")
            for image in images
        ]
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}] if system else []
        ollama_messages = [
            *messages,
            {"role": "user", "content": prompt, **({"images": encoded} if encoded else {})},
        ]
        parts: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
        parts += [
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}} for b64 in encoded
        ]
        openai_messages = [*messages, {"role": "user", "content": parts}]
        ollama: dict[str, Any] = {
            "model": model,
            "messages": ollama_messages,
            "format": schema,
            "stream": False,
            "options": {"temperature": 0},
        }
        if keep_alive is not None:
            ollama["keep_alive"] = keep_alive
        dialect, answer = self._request(
            ("/api/chat", ollama),
            (
                "/v1/chat/completions",
                {
                    "model": model,
                    "messages": openai_messages,
                    "temperature": 0,
                    "response_format": {
                        "type": "json_schema",
                        "json_schema": {"name": "result", "schema": schema, "strict": True},
                    },
                },
            ),
        )
        try:
            if dialect == "ollama":
                content = answer["message"]["content"]
            else:
                content = answer["choices"][0]["message"]["content"]
            parsed = json.loads(content)
        except (KeyError, IndexError, TypeError, ValueError):
            raise LocalLlmError(f"{model} answered with no JSON object") from None
        if not isinstance(parsed, dict):
            raise LocalLlmError(f"{model} answered with JSON that isn't an object")
        return parsed

    def embed(
        self, model: str, texts: Sequence[str], keep_alive: str | int | None = None
    ) -> list[list[float]]:
        """One embedding per text, in order. `keep_alive` (Ollama's: "30m", seconds, -1 for ever) keeps the
        model loaded after the call; the OpenAI-compatible route has no such field."""
        if not texts:
            return []
        ollama: dict[str, Any] = {"model": model, "input": list(texts)}
        if keep_alive is not None:
            ollama["keep_alive"] = keep_alive
        dialect, answer = self._request(
            ("/api/embed", ollama),
            ("/v1/embeddings", {"model": model, "input": list(texts)}),
        )
        try:
            if dialect == "ollama":
                vectors = answer["embeddings"]
            else:
                vectors = [
                    item["embedding"] for item in sorted(answer["data"], key=lambda item: item["index"])
                ]
            result = [[float(x) for x in vector] for vector in vectors]
        except (KeyError, TypeError, ValueError):
            raise LocalLlmError(f"{model} answered with no embeddings") from None
        if len(result) != len(texts):
            raise LocalLlmError(f"{model} gave {len(result)} embeddings for {len(texts)} texts")
        return result

    def model_names(self) -> list[str]:
        """The models the server has (Ollama's `/api/tags`, else `/v1/models`). Raises LocalLlmError."""
        try:
            response = self._session.get(f"{self.base_url}/api/tags", timeout=5)
            if response.status_code == 404:
                response = self._session.get(f"{self.base_url}/v1/models", timeout=5)
                return [str(m.get("id", "")) for m in self._json(response).get("data", [])]
            return [str(m.get("name", "")) for m in self._json(response).get("models", [])]
        except (requests.RequestException, AttributeError) as e:
            raise LocalLlmError(f"The local model server ({self.base_url}) isn't answering: {e}") from None

    def resolve_available_model(self, preferred: str) -> str:
        """`preferred`, or the first of its MODEL_ALIASES the server has; `preferred` itself when it has
        none of them (or can't be asked), so the call's own error names the configured model."""
        try:
            names = set(self.model_names())
        except LocalLlmError:
            return preferred
        for candidate in (preferred, *MODEL_ALIASES.get(preferred, ())):
            if _wanted(candidate) & names:
                return candidate
        return preferred

    def has_model(self, model: str) -> tuple[bool, str]:
        """(whether the server is up and has `model` or one of its aliases, a sentence for the About
        modal)."""
        try:
            names = set(self.model_names())
        except LocalLlmError as e:
            return False, str(e)
        if _wanted(model) & names:
            return True, f"{model} is ready on {self.base_url}"
        for alias in MODEL_ALIASES.get(model, ()):
            if _wanted(alias) & names:
                return True, f"{alias} is ready on {self.base_url} (in place of {model})"
        return False, f"{model} isn't on {self.base_url} (ollama pull {model})"


def _wanted(model: str) -> set[str]:
    """The names the server may list `model` under (an untagged name is its `:latest`)."""
    return {model, f"{model}:latest"} if ":" not in model else {model}
