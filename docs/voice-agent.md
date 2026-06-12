# Voice Agent ("Ask SpatialCore")

The in-app voice agent lets a signed-in user control and interrogate the globe
by voice. It is an ElevenLabs Conversational AI session whose **tools are the
live WWV MCP surface** — the agent has exact parity with external MCP clients,
automatically including future tools.

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

## Provisioning the SpatialCore agent

The agent (persona, knowledge, and tool declarations) is provisioned
programmatically from the live MCP surface — no manual dashboard work:

```bash
# App running locally; WWV API key minted under the in-app "API Keys" button.
ELEVENLABS_API_KEY=xi-... WWV_API_KEY=wwv-... node scripts/setup-voice-agent.mjs
```

The script discovers `tools/list` from the MCP endpoint, registers every tool
as an ElevenLabs **client tool** (`expects_response: true`), writes the
SpatialCore operator system prompt + first message, and prints the agent id.
Set it and restart:

```
NEXT_PUBLIC_ELEVENLABS_AGENT_ID=<printed id>   # .env.local
```

The orb does not render until this is set — there is intentionally no
fallback agent. Re-run the script with `ELEVENLABS_AGENT_ID=<id>` to update
the same agent after the MCP tool surface changes. Voice and model can be
tweaked afterwards on the ElevenLabs dashboard (session overrides are
intentionally never sent — unauthorized overrides close the socket with
code 1000).

### Production option: server-side MCP

For a deployed instance, ElevenLabs can call the MCP server directly in
their cloud instead of through browser client tools:

```bash
ELEVENLABS_API_KEY=... WWV_API_KEY=... \
WWV_PUBLIC_MCP_URL=https://<deployed-host>/api/mcp \
node scripts/setup-voice-agent.mjs
```

This registers the URL as an ElevenLabs MCP server (`STREAMABLE_HTTP`,
authorized via the WWV API key in a request header) and attaches it through
`mcp_server_ids` — no client tools needed. Use the client-tools mode for
local dev, since ElevenLabs' cloud cannot reach localhost.

## Files

- `src/core/voice/` — `VoiceAgentHandler.ts`, `McpToolBridge.ts`, `useVoiceAgent.ts`, `types.ts`
- `src/components/voice/` — `VoiceAgentOverlay.tsx`, `VoiceButton.tsx`, `VoiceTranscript.tsx`
- `src/styles/voice-agent.css` — orb + transcript styling (global, `voice-` prefixed)
- `src/app/api/agent/mcp/route.ts` — session-authed MCP endpoint
- `src/lib/mcp/registerCapabilities.ts` — shared capability registration
