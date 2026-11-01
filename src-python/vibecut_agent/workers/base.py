"""What every local worker shares (ORCHESTRATOR_SPEC.md §1.2, §2): the health report it gives the About
modal (`WorkerHealth`), the interface it implements (`LocalWorker`), and the GPU lock (`GpuLock`).

Whisper, the VLM and the embedding model each want most of Apple Silicon's unified memory (or a GPU's
VRAM). `GpuLock` is a file lock at `<index_dir>/.gpu.lock`, so they take turns across every sidecar
process: an ingest job and a chat turn never load two models at once."""

from __future__ import annotations

import fcntl
import os
import time
from pathlib import Path
from types import TracebackType
from typing import IO, TYPE_CHECKING, Protocol, Self, TypedDict, runtime_checkable

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
