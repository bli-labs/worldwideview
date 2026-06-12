# Voice Agent ("Ask SpatialCore")

The in-app voice agent (ported from the DAVE prototype) lets a signed-in user
control and interrogate the globe by voice. It is an ElevenLabs Conversational
AI session whose **client tools are the live WWV MCP surface** — the agent has
exact parity with external MCP clients, automatically including future tools.

## Architecture

```
VoiceButton (mercury orb, bottom-center)
   └─ useVoiceAgent (src/core/voice/useVoiceAgent.ts)
        ├─ McpToolBridge ──► /api/agent/mcp   (session-authed MCP twin)
        │                       └─ registerCapabilities()  ◄── shared with /api/mcp
        └─ VoiceAgentHandler ──► ElevenLabs Conversation (mic + audio handled by SDK)
```

- `/api/agent/mcp` authenticates with the Auth.js **session cookie** (the
  Bearer-key route `/api/mcp` is unchanged). Both register capabilities via
  `src/lib/mcp/registerCapabilities.ts`, so the two surfaces cannot drift.
- On session start the bridge calls `tools/list` and registers every tool name
  as an ElevenLabs client tool. Tool calls round-trip through MCP; camera
  commands (e.g. `fly_to`) flow through the globe command queue that the same
  browser tab already polls — so the globe reacts live.
- Demo edition: the overlay does not render, and the server route is blocked.

## Configuration

| What | Where |
|---|---|
| Agent ID | `NEXT_PUBLIC_ELEVENLABS_AGENT_ID` (falls back to the DAVE prototype agent) |
| Persona / system prompt / voice | ElevenLabs dashboard (overrides are intentionally never sent — unauthorized overrides close the socket with code 1000) |
| Tool declarations | ElevenLabs dashboard → Agent → Tools (must be **Client tools** whose names match the MCP tool names) |

## Registering the tools on the ElevenLabs dashboard

The agent can only call tools that are declared on its dashboard config. Add a
**client tool** per MCP tool you want voice-accessible. The canonical list and
schemas come from the MCP surface itself — in dev, connect once and the console
logs `[VoiceAgent] Registering N MCP tools as client tools: [...]`, or call
`tools/list` against `/api/mcp` with an API key.

Core tools worth declaring:

| Tool | Purpose |
|---|---|
| `list_available_plugins` | What data is streaming right now |
| `search_entities` | Find entities by name across active plugins |
| `get_entities_in_region` | Entities inside a lat/lng bounding box |
| `get_entity_details` | Full details for one entity |
| `get_plugin_data` | Snapshot of one plugin's entities |
| `geocode_location` | Place name → coordinates/bbox |
| `fly_to` | Fly the live globe camera |
| `get_plugin_filters` / `set_filter` / `clear_filter` | Live layer filtering |
| `save_favorite` / `list_favorites` / `remove_favorite` | Bookmarks |

Give each dashboard tool the same JSON parameter schema the MCP tool declares,
and instruct the agent (system prompt) that it is SpatialCore's operator:
verify data with the query tools, move the camera with `fly_to`, and narrate
insight from tool results rather than guessing.

## Files

- `src/core/voice/` — `VoiceAgentHandler.ts`, `McpToolBridge.ts`, `useVoiceAgent.ts`, `types.ts`
- `src/components/voice/` — `VoiceAgentOverlay.tsx`, `VoiceButton.tsx`, `VoiceTranscript.tsx`
- `src/styles/voice-agent.css` — orb + transcript styling (global, `voice-` prefixed)
- `src/app/api/agent/mcp/route.ts` — session-authed MCP endpoint
- `src/lib/mcp/registerCapabilities.ts` — shared capability registration
