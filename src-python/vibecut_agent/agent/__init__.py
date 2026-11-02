"""The editing agent's LLM loop, ported from VibeCut's rough-cut-studio backend (gemini_chat.py
and its helpers; Claude runs through the user's Claude Code, claude_code_chat.py). The tools themselves run in the app (src/lib/agent/), which answers
each ``tool_calls`` event with ``tool_result`` lines; see :mod:`vibecut_agent.agent.chat`.
"""
