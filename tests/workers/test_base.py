"""The workers' shared interface and GPU lock (workers/base.py)."""

import os
import threading

import pytest

from vibecut_agent.config import OrchestratorConfig
from vibecut_agent.workers.base import GpuLock, GpuLockTimeout, LocalWorker, WorkerHealth


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
