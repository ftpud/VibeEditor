#!/usr/bin/env python3
"""Small concurrent ACP v1 fixture used by the stdio integration tests."""
import json
import os
import sys
import threading
import time

MODELS = {"model-a": ["low", "medium", "high"], "model-b": []}
MODEL_META = {
    "model-a": {"description": "Fast test model", "_meta": {"copilotUsage": "0.33x", "copilotPriceCategory": "low", "copilotEnablement": "enabled"}},
    "model-b": {"_meta": {"copilotUsage": "10x", "copilotPriceCategory": "high", "copilotEnablement": "disabled"}},
}
STEERING = os.environ.get("FAKE_STEERING") == "on"
SLOW = os.environ.get("FAKE_SLOW") == "on"
LOAD = os.environ.get("FAKE_LOAD") == "on"
PERMISSION = os.environ.get("FAKE_PERMISSION") == "on"
state = {"live": None, "model": "model-a", "effort": "medium", "cancelled": False}
write_lock = threading.Lock()
permission_event = threading.Event()


def send(payload):
    with write_lock:
        sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def notify(session_id, update):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session_id, "update": update}})


def options():
    model = state["model"]
    result = [{"type": "select", "id": "model", "name": "Model", "category": "model", "currentValue": model,
               "options": [{"value": key, "name": key.upper(), **MODEL_META[key]} for key in MODELS]}]
    if MODELS[model]:
        result.append({"type": "select", "id": "reasoning_effort", "name": "Reasoning", "category": "thought_level", "currentValue": state["effort"],
                       "options": [{"value": value, "name": value, "description": f"{value} effort"} for value in MODELS[model]]})
    result.append({"type": "select", "id": "allow_all", "name": "Allow all", "category": "permissions", "currentValue": "off",
                   "options": [{"value": "on", "name": "On"}, {"value": "off", "name": "Off"}]})
    return result


def handle(request):
    method = request.get("method")
    request_id = request.get("id")
    params = request.get("params") or {}

    def ok(result):
        send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def fail(message):
        send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": message}})

    if method is None and request.get("id") == "permission-1":
        state["permission"] = request.get("result", {}).get("outcome", {})
        permission_event.set()
    elif method == "initialize":
        ok({"protocolVersion": 1, "agentCapabilities": {**({"loadSession": True} if LOAD else {})}, "agentInfo": {"name": "fake", "version": "1"},
            **({"_meta": {"steering": {"supported": True}}} if STEERING else {})})
    elif method == "session/new":
        ok({"sessionId": "fake-session", "modes": None, "configOptions": options()})
        notify("fake-session", {"sessionUpdate": "available_commands_update", "availableCommands": [{"name": "review", "description": "Review changes", "input": {"hint": "optional scope"}}]})
    elif method == "session/load":
        notify(params["sessionId"], {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Restored authoritative history"}})
        ok({"modes": None, "configOptions": options()})
    elif method == "session/set_config_option":
        config_id, value = params.get("configId"), params.get("value")
        if config_id == "model":
            if value not in MODELS:
                fail(f"unknown model {value}")
                return
            state["model"] = value
            state["effort"] = MODELS[value][1] if len(MODELS[value]) > 1 else ""
        elif config_id == "reasoning_effort":
            if not MODELS[state["model"]]:
                fail("The selected model does not support reasoning_effort configuration.")
                return
            state["effort"] = value
        ok({"configOptions": options()})
    elif method == "_session/steering":
        if state["live"]:
            notify(state["live"], {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": f"[steered: {params['prompt'][0]['text']}]"}})
            ok({"outcome": "injected"})
        else:
            ok({"outcome": "startedNewTurn"})
    elif method == "session/cancel":
        if state["live"]:
            notify(state["live"], {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "trailing output after cancel"}})
            state["cancelled"] = True
    elif method == "session/prompt":
        session_id = params["sessionId"]
        state.update(live=session_id, cancelled=False)
        if PERMISSION:
            permission_event.clear()
            send({"jsonrpc": "2.0", "id": "permission-1", "method": "session/request_permission", "params": {"sessionId": session_id, "toolCall": {"toolCallId": "danger", "title": "Write protected file", "rawInput": {"command": "touch /protected"}}, "options": [{"optionId": "yes", "name": "Allow once", "kind": "allow_once"}, {"optionId": "no", "name": "Reject", "kind": "reject_once"}]}})
            if not permission_event.wait(3):
                fail("permission response timed out")
                return
            notify(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": f"Permission: {state.get('permission', {}).get('optionId', 'cancelled')}"}})
        if SLOW:
            notify(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "working"}})
            for _ in range(100):
                if state["cancelled"]:
                    break
                time.sleep(0.02)
            state["live"] = None
            ok({"stopReason": "end_turn"})
            return
        notify(session_id, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "thinking "}})
        notify(session_id, {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hard"}})
        for text in ("Hello", ", ", "world"):
            notify(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})
        notify(session_id, {"sessionUpdate": "tool_call", "toolCallId": "tool-1", "title": "Run echo", "kind": "execute", "status": "pending", "rawInput": {"command": "echo hi"}})
        notify(session_id, {"sessionUpdate": "tool_call_update", "toolCallId": "tool-1", "status": "completed", "content": [{"type": "content", "content": {"type": "text", "text": "hi"}}]})
        for text in ("Done", "!"):
            notify(session_id, {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})
        notify(session_id, {"sessionUpdate": "usage_update", "used": 120, "size": 1000})
        time.sleep(0.02)
        state["live"] = None
        ok({"stopReason": "end_turn", "usage": {"totalTokens": 30, "inputTokens": 20, "outputTokens": 10, "thoughtTokens": 4}})
    elif request_id is not None:
        ok({})


for line in sys.stdin:
    if line.strip():
        threading.Thread(target=handle, args=(json.loads(line),), daemon=True).start()
