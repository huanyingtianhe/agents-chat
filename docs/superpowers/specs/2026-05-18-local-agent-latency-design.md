# Local Agent Warmup Latency Design

## Problem

The first prompt to a local ACP agent is slower than later prompts because the `send` request currently waits for the agent process to spawn, initialize, create or load a session, and then handle the prompt. Remote/relay agents are out of scope for this feature.

## Goal

Reduce first-response latency for local, non-remote agents by warming their processes when the chat app loads. Warmup should only spawn and initialize agent processes; it must not create ACP chat sessions before the user sends a message.

## Approach

Add an explicit backend warmup action named `warm-local-agents`, and call it once from the frontend after `list-agents` succeeds on app load.

The backend action will:

1. Load configured agents from the existing ACP agent config.
2. Skip remote/relay agents.
3. Skip local agents that are already `ready` or `booting`.
4. Start remaining local agents with the existing `bootAgent()` path.
5. Return a per-agent summary without blocking other agents if one warmup fails.

The frontend will:

1. Continue loading agents through the existing `list-agents` flow.
2. Fire one non-blocking warmup request after the agent list is available.
3. Avoid changing selected agent, remembered agent, chat session, or composer state.
4. Avoid surfacing warmup failures in the UI.

## Behavior

Warmup is best-effort. If an agent fails to warm in the background, the failure is logged on the server and normal send behavior remains the fallback. When the user sends to that agent, the existing send flow still attempts to boot the agent and returns the normal user-visible error if boot fails.

Warmup does not call `session/new` or `session/load`. It only prepares local agent processes so the first real prompt avoids the process spawn and initialize cost.

## Scope

In scope:

- Local, non-relay ACP agents.
- App-load warmup after agents are listed.
- Server logging and per-agent warmup summary.
- Regression coverage for backend filtering and frontend trigger behavior.

Out of scope:

- Remote/relay agent warmup.
- Pre-creating ACP sessions before send.
- New UI warning states for warmup failures.
- Changing the existing send fallback behavior.

## Testing

Backend coverage should verify that the new action warms only local agents, skips relay agents, skips already ready or booting processes, and does not create sessions.

Frontend coverage should verify that app load triggers warmup after `list-agents` succeeds and that the warmup request does not block normal rendering or sending behavior.
