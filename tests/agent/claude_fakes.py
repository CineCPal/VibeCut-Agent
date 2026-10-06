"""tests/claude_fakes.py — an in-process stand-in for the `anthropic` client's streaming beta Messages
API, so the Claude tests run with no network. Install with `install(monkeypatch, replies)`: each
`client.beta.messages.stream(**params)` call records a deep copy of `params` and plays the next reply
(a message dict, or an exception to raise)."""

import copy
from types import SimpleNamespace

import anthropic
import httpx2

from vibecut_agent.agent import claude_client


class FakeModel:
    def __init__(self, data):
        self._data = data

    def model_dump(self, exclude_none=False):
        return copy.deepcopy(self._data)


class FakeStream:
    def __init__(self, message):
        self._message = message

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        for index, block in enumerate(self._message.get("content") or []):
            yield SimpleNamespace(type="content_block_stop", index=index, content_block=FakeModel(block))

    def get_final_message(self):
        return FakeModel(self._message)


class FakeClient:
    def __init__(self, replies):
        self.replies = list(replies)
        self.requests = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **params):
        self.requests.append(copy.deepcopy(params))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return FakeStream(reply)


def install(monkeypatch, replies):
    client = FakeClient(replies)
    monkeypatch.setattr(claude_client, "_make_client", lambda api_key, timeout: client)
    monkeypatch.setattr(claude_client, "_wait_before_retry", lambda *a, **k: None)
    return client


def message(*content, stop_reason="end_turn", usage=None):
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-opus-5-5",
        "content": list(content),
        "stop_reason": stop_reason,
        "usage": usage or {"input_tokens": 10, "output_tokens": 5},
    }


def text(value):
    return {"type": "text", "text": value}


def tool_use(call_id, name, args):
    return {"type": "tool_use", "id": call_id, "name": name, "input": args}


def thinking(note, signature="sig"):
    return {"type": "thinking", "thinking": note, "signature": signature}


def status_error(cls, status, headers=None, msg="error"):
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return cls(msg, response=httpx2.Response(status, headers=headers or {}, request=request), body=None)


def connection_error():
    return anthropic.APIConnectionError(
        request=httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    )
