"""
vision_energy.py
Optional, fully local content-aware scoring for video frames: an
"excitement / high energy" score, plus (when the editor types a brief)
a "does this frame show what I asked for" relevance score. Also the
text/image encoder behind B-roll search (semantic.py, spyglass_index.py).

Uses SigLIP 2 (via the open-source `open_clip` library) -- the same
model, same weights, same ID string as Spyglass's own sidecar
(the suite's apps/spyglass/sidecar/analyze_clip.py EMBED_MODEL_ID), so
VibeCut, Spyglass and the B-Roll Analyzer download and cache one vision
model. Each sampled frame becomes one L2-normalized image embedding;
every score here is derived from that one embedding by comparing it
against text targets:

  - energy:    fixed "exciting / high energy" vs "calm / static" prompt
               sets (unchanged idea from the CLIP version of this module)
  - relevance: an editor-typed brief vs a small set of neutral prompts

Embeddings are returned to the caller (and cached by result_cache.py in
a binary sidecar file) so a new brief or weight only needs a cheap
numpy rescore, never a re-decode. energy_from_embeddings /
relevance_from_embeddings are pure numpy for exactly that reason.

VibeCut-specific: models are held in a small registry keyed by
Spyglass-style model ids (KNOWN_MODELS), so one process can hold more
than one. Spyglass archives that haven't been re-indexed since the suite
moved to SigLIP 2 still carry `ViT-B-32-quickgelu/openai` vectors, and a
query has to be embedded with the model that produced the vectors it is
compared with (see spyglass_index.py).

IMPORTANT - this is intentionally NOT connected to Anthropic's API (or
any other cloud API) in any way:
  - The models (open_clip's "ViT-B-16-SigLIP2-256" with "webli" weights,
    and for older Spyglass archives "ViT-B-32-quickgelu" with OpenAI
    weights) are free, open-source checkpoints. Each is downloaded once,
    on first use, from its normal public host (Hugging Face Hub) via the
    open_clip library itself, and then cached locally (typically under
    ~/.cache).
  - After that one-time download, every frame is scored entirely
    on-device (CPU or GPU, whatever's available) with zero network
    calls, zero external API keys, and no data leaving the machine.

This module is optional: if `torch` / `open_clip_torch` / `transformers`
aren't installed, `is_available()` returns False and the rest of the app
degrades gracefully (technical scoring still works normally).
"""

import threading
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np

MODEL_NAME = "ViT-B-16-SigLIP2-256"
PRETRAINED = "webli"
# Stored on every cache entry whose samples carry content scores, so a
# future model change invalidates exactly those entries (see
# result_cache.is_entry_usable). Must match Spyglass's EMBED_MODEL_ID
# string format so the two apps' caches describe the same thing.
EMBED_MODEL_ID = f"{MODEL_NAME}/{PRETRAINED}"
# What a cache entry with energy data but no embed_model field was
# produced by: this module's previous CLIP model.
LEGACY_EMBED_MODEL_ID = "ViT-B-32/openai"
# What every Spyglass vector written before the suite's migration 013 was
# embedded with (search.rs LEGACY_EMBEDDING_MODEL).
SPYGLASS_LEGACY_MODEL_ID = "ViT-B-32-quickgelu/openai"
EMBED_DIM = 768

# Model id -> (open_clip architecture, pretrained tag). Only these can be
# loaded; a Spyglass archive carrying any other id is searched by tags
# and transcripts only.
KNOWN_MODELS: dict[str, tuple[str, str]] = {
    EMBED_MODEL_ID: (MODEL_NAME, PRETRAINED),
    SPYGLASS_LEGACY_MODEL_ID: ("ViT-B-32-quickgelu", "openai"),
}

# Averaging several phrasings smooths out the sensitivity the model has
# to exact wording, giving a steadier score than any single prompt would.
POSITIVE_PROMPTS = [
    "an exciting, high energy, dynamic action shot",
    "fast motion, adrenaline, a thrilling moment",
    "intense action with rapid movement and energy",
    "a dramatic, high-intensity moment",
]
NEGATIVE_PROMPTS = [
    "a calm, static, low energy shot",
    "a still, quiet, boring scene",
    "a slow, motionless, uneventful moment",
    "a plain, low-intensity everyday scene",
]
# What a brief competes against. A frame that matches the brief better
# than these generic descriptions scores high; one that's just "some
# footage" scores low. Absolute per frame, not min-maxed per folder, so a
# folder where nothing matches the brief doesn't still produce 90s.
NEUTRAL_PROMPTS = [
    "an ordinary video frame",
    "a photo",
    "an empty scene",
    "a random everyday moment",
]

# Softmax temperatures turning similarity gaps into 0-100 scores. SigLIP 2
# cosines sit in a much narrower band than CLIP's (its own learned logit
# scale is ~113, i.e. ~0.0089), so the CLIP-era 0.05 would flatten every
# score to ~50. Calibrated by the suite 2026-10-01 on 600 real archive
# keyframes:
#   energy 0.012    -> sports-captioned shots ~76 avg, calm/static ~45
#   relevance 0.015 -> caption-matching shots ~80-85, non-matching ~15
ENERGY_TEMPERATURE = 0.012
RELEVANCE_TEMPERATURE = 0.015

# How many frames go through the model per forward pass in embed_frames.
# Large enough to amortize per-call dispatch overhead, small enough that
# a batch of preprocessed 256x256 tensors plus activations stays
# comfortably bounded in memory. Callers that accumulate frames across a
# decode loop (analyzer.analyze_clip) also use this as their flush
# threshold, so a long clip never holds more than one batch of frames at
# a time.
BATCH_SIZE = 32

_INSTALL_HINT = "Run: uv sync --extra energy (torch, open_clip_torch, transformers)"


@dataclass
class _Loaded:
    model: Any
    preprocess: Any
    tokenizer: Any
    device: str


_lock = threading.Lock()
_models: dict[str, _Loaded] = {}
_energy_targets = None  # (2, D) numpy: [pos_mean, neg_mean], set when SigLIP 2 loads
_neutral_targets = None  # (K, D) numpy, set when SigLIP 2 loads


class VisionEnergyError(Exception):
    """Raised when the optional local vision model can't be used."""


def is_available() -> bool:
    """Cheap check for whether the optional dependencies are installed.
    Does not load the (larger) model weights."""
    try:
        import open_clip  # noqa: F401
        import torch  # noqa: F401
        import transformers  # noqa: F401  (SigLIP 2's HF tokenizer)

        return True
    except ImportError:
        return False


def _normalize_rows(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float32)
    norms = np.linalg.norm(x, axis=-1, keepdims=True)
    return x / np.maximum(norms, 1e-12)


def _pick_device(torch) -> str:
    # Prefer Apple's Metal backend (MPS) when present -- this app's
    # primary deployment is Apple Silicon Macs, where torch never
    # reports CUDA. getattr() guards torch builds old enough to predate
    # torch.backends.mps entirely.
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def _ensure_loaded(model_id: str = EMBED_MODEL_ID) -> _Loaded:
    global _energy_targets, _neutral_targets
    loaded = _models.get(model_id)
    if loaded is not None:
        return loaded
    if model_id not in KNOWN_MODELS:
        raise VisionEnergyError(f"Unknown vision model: {model_id}")
    with _lock:
        loaded = _models.get(model_id)
        if loaded is not None:
            return loaded
        try:
            import open_clip
            import torch
        except ImportError as e:
            raise VisionEnergyError(
                f"Local vision model dependencies aren't installed. {_INSTALL_HINT}"
            ) from e

        arch, pretrained = KNOWN_MODELS[model_id]
        try:
            device = _pick_device(torch)
            # Kept in float32 even on MPS, matching Spyglass's sidecar:
            # the score temperatures above were calibrated on fp32
            # embeddings, and SigLIP's narrow cosine band leaves little
            # headroom for half-precision rounding.
            model, _, preprocess = open_clip.create_model_and_transforms(arch, pretrained=pretrained)
            model.eval()
            model.to(device)
            tokenizer = open_clip.get_tokenizer(arch)
            loaded = _Loaded(model, preprocess, tokenizer, device)

            if model_id == EMBED_MODEL_ID:
                pos_mean = _normalize_rows(_encode_texts(loaded, POSITIVE_PROMPTS).mean(axis=0))
                neg_mean = _normalize_rows(_encode_texts(loaded, NEGATIVE_PROMPTS).mean(axis=0))
                _energy_targets = np.stack([pos_mean, neg_mean])
                _neutral_targets = _encode_texts(loaded, NEUTRAL_PROMPTS)
        except Exception as e:
            raise VisionEnergyError(f"Failed to load local vision model: {e}") from e

        _models[model_id] = loaded
        return loaded


def _encode_texts(loaded: _Loaded, texts: Sequence[str]) -> np.ndarray:
    import torch

    with torch.no_grad():
        feat = loaded.model.encode_text(loaded.tokenizer(list(texts)).to(loaded.device))
    return _normalize_rows(feat.float().cpu().numpy())


def preload(model_id: str = EMBED_MODEL_ID) -> None:
    """Loads a model now (downloading its weights on first use), so a failure shows up at once
    instead of once per clip. `model_id` is one of KNOWN_MODELS; several can be loaded side by
    side. Raises VisionEnergyError."""
    _ensure_loaded(model_id or EMBED_MODEL_ID)


def encode_images(pil_images: Sequence, model_id: str = EMBED_MODEL_ID) -> np.ndarray:
    """L2-normalised float32 embeddings of PIL RGB images, shape (N, D), in input order, from the
    model `model_id`. One forward pass per BATCH_SIZE chunk. Used to match frames against text
    (see semantic.py). Raises VisionEnergyError if the model cannot be used."""
    loaded = _ensure_loaded(model_id)
    import torch

    if not len(pil_images):
        return np.zeros((0, 0), dtype=np.float32)
    chunks: list[np.ndarray] = []
    with torch.no_grad():
        # Chunked rather than one giant stack so callers can hand us an
        # arbitrarily long list without memory scaling with clip length.
        for start in range(0, len(pil_images), BATCH_SIZE):
            chunk = pil_images[start : start + BATCH_SIZE]
            batch = torch.stack([loaded.preprocess(img) for img in chunk]).to(loaded.device)
            feat = loaded.model.encode_image(batch)
            # One device->host sync per chunk, not per image.
            chunks.append(_normalize_rows(feat.float().cpu().numpy()))
    return np.concatenate(chunks, axis=0)


def encode_texts(texts: Sequence[str], model_id: str = EMBED_MODEL_ID) -> np.ndarray:
    """L2-normalised float32 embeddings of texts, shape (N, D), from the model `model_id`. Text
    beyond the model's context (64 tokens for SigLIP 2, 77 for CLIP) is cut off."""
    loaded = _ensure_loaded(model_id)
    if not len(texts):
        return np.zeros((0, 0), dtype=np.float32)
    return _encode_texts(loaded, texts)


def embed_frames(pil_images: Sequence) -> np.ndarray:
    """Embed a sequence of PIL RGB images with SigLIP 2. Returns an (N, EMBED_DIM) float16 array
    of L2-normalized embeddings, in input order (float16 halves the on-disk cache size; scores are
    computed in float32 from it, well within the calibration's tolerance). Raises
    VisionEnergyError if the optional dependencies aren't installed or the model fails to load."""
    if not pil_images:
        _ensure_loaded()
        return np.zeros((0, EMBED_DIM), dtype=np.float16)
    return encode_images(pil_images).astype(np.float16)


def _contrast_scores(embeddings: np.ndarray, targets: np.ndarray, temperature: float) -> np.ndarray:
    """Softmax over [target 0, target 1, ...] similarities; returns the
    probability of target 0, scaled to 0-100, per row."""
    emb = np.asarray(embeddings, dtype=np.float32)
    if emb.ndim != 2 or emb.shape[0] == 0:
        return np.zeros((0,), dtype=np.float32)
    logits = (emb @ np.asarray(targets, dtype=np.float32).T) / temperature
    logits -= logits.max(axis=1, keepdims=True)
    exp = np.exp(logits)
    return (exp[:, 0] / exp.sum(axis=1) * 100.0).astype(np.float32)


def energy_from_embeddings(embeddings: np.ndarray, energy_targets: np.ndarray | None = None) -> np.ndarray:
    """0-100 "high energy" score per embedding row. `energy_targets` is
    a (2, D) [positive_mean, negative_mean] array; omitted, the loaded
    model's own prompt targets are used (loading the model if needed).
    Pure numpy given explicit targets -- tests pass synthetic ones."""
    if energy_targets is None:
        _ensure_loaded()
        energy_targets = _energy_targets
    assert energy_targets is not None  # _ensure_loaded sets them, or raises
    return _contrast_scores(embeddings, energy_targets, ENERGY_TEMPERATURE)


def brief_targets(brief: str) -> np.ndarray | None:
    """Embed an editor's brief once per run. Returns a (1+K, D) array --
    row 0 is the brief, rows 1..K the neutral prompts it competes
    against -- ready for relevance_from_embeddings, or None for an empty
    brief. Text-only: cheap compared with frame embedding, and done once
    in the calling process, never per clip."""
    brief = (brief or "").strip()
    if not brief:
        return None
    brief_vec = encode_texts([brief])
    return np.concatenate([brief_vec, _neutral_targets]).astype(np.float32)


def relevance_from_embeddings(embeddings: np.ndarray, targets: np.ndarray | None) -> np.ndarray:
    """0-100 "matches the brief" score per embedding row, given the
    output of brief_targets(). Pure numpy. All zeros if there's no
    brief."""
    emb = np.asarray(embeddings)
    if targets is None:
        return np.zeros((emb.shape[0] if emb.ndim == 2 else 0,), dtype=np.float32)
    return _contrast_scores(emb, targets, RELEVANCE_TEMPERATURE)


def score_frames_energy(pil_images: Sequence) -> list[float]:
    """Score a sequence of PIL RGB images for "exciting / high energy"
    content. Returns one float in [0, 100] per input image, in input
    order. Kept for callers that only want the energy number; analyzer
    itself uses embed_frames + energy_from_embeddings so the embeddings
    can be cached too."""
    return [float(s) for s in energy_from_embeddings(embed_frames(pil_images))]


def score_frame_energy(frame_bgr: np.ndarray) -> float:
    """Score a single OpenCV BGR frame for "exciting / high energy"
    content. Returns a float in [0, 100]. Raises VisionEnergyError if the
    optional dependencies aren't installed or the model fails to load."""
    from PIL import Image

    rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
    return score_frames_energy([Image.fromarray(rgb)])[0]


def availability_message() -> str | None:
    """None if ready to use; otherwise a short human-readable reason."""
    if is_available():
        return None
    return f"Optional local vision model not installed. {_INSTALL_HINT}"
