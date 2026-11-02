"""SigLIP 2 takes the orchestrator's GPU lock (broll/vision_energy.py; model migration v2), around its load
and each call's forward passes, never nested: another acquire in the same process would wait on it."""

from __future__ import annotations

import sys
import types
from typing import Any, Self

import numpy as np
import pytest

from vibecut_agent.broll import vision_energy


class Lock:
    """A GpuLock stand-in that fails a nested acquire (the real one would wait for ever)."""

    held = 0
    taken: list[str] = []

    def __init__(self, what: str) -> None:
        self.what = what

    def acquire(self) -> None:
        assert Lock.held == 0, "the GPU lock was taken while held: that would deadlock"
        Lock.held += 1
        Lock.taken.append(self.what)

    def release(self) -> None:
        Lock.held -= 1

    def __enter__(self) -> Self:
        self.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()


@pytest.fixture
def fake_torch(monkeypatch: pytest.MonkeyPatch) -> Any:
    """torch, open_clip and SigLIP 2 faked: each forward pass checks the GPU lock is held."""

    class Tensor:
        def __init__(self, rows: int) -> None:
            self.rows = rows

        def to(self, device: str) -> Tensor:
            return self

        def float(self) -> Tensor:
            return self

        def cpu(self) -> Tensor:
            return self

        def numpy(self) -> np.ndarray:
            return np.ones((self.rows, 4), dtype=np.float32)

    class Model:
        def encode_image(self, batch: Tensor) -> Tensor:
            assert Lock.held == 1, "SigLIP ran without the GPU lock"
            return batch

        def encode_text(self, tokens: Tensor) -> Tensor:
            assert Lock.held == 1, "SigLIP ran without the GPU lock"
            return tokens

        def eval(self) -> None:
            pass

        def to(self, device: str) -> None:
            assert Lock.held == 1, "the model was moved to the GPU without the lock"

    class NoGrad:
        def __enter__(self) -> None:
            return None

        def __exit__(self, *exc: object) -> None:
            return None

    torch = types.SimpleNamespace(
        no_grad=NoGrad,
        stack=lambda items: Tensor(len(items)),
        backends=types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: False)),
        cuda=types.SimpleNamespace(is_available=lambda: False),
    )
    open_clip = types.SimpleNamespace(
        create_model_and_transforms=lambda arch, pretrained: (Model(), None, lambda image: image),
        get_tokenizer=lambda arch: lambda texts: Tensor(len(texts)),
    )
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "open_clip", open_clip)
    monkeypatch.setattr(vision_energy, "_models", {})
    monkeypatch.setattr(vision_energy, "_gpu", lambda: Lock("gpu"))
    Lock.held, Lock.taken = 0, []
    return torch


def test_loading_and_each_call_take_the_gpu_lock_one_at_a_time(fake_torch: Any) -> None:
    vision_energy.encode_images(["frame"] * 3)
    vision_energy.encode_texts(["a sunset"])
    vision_energy.encode_images(["frame"])
    # The load (with its prompt embeddings), then each call: never nested, always released.
    assert Lock.taken == ["gpu"] * 4 and Lock.held == 0


def test_a_failed_load_releases_the_lock(fake_torch: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(arch: str, pretrained: str) -> Any:
        raise RuntimeError("no weights")

    monkeypatch.setattr(sys.modules["open_clip"], "create_model_and_transforms", broken)
    with pytest.raises(vision_energy.VisionEnergyError, match="no weights"):
        vision_energy.encode_images(["frame"])
    assert Lock.held == 0
