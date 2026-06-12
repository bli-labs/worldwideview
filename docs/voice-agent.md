# Voice Agent ("Ask SpatialCore")

The in-app voice agent lets a signed-in user control and interrogate the globe
by voice. It is a **Gemini Live API** session whose function declarations are
the live WWV MCP surface — the agent has exact parity with external MCP
clients, automatically including future tools. The persona, voice, and tool
wiring all live in this codebase; there is no third-party dashboard to
configure.

## Configuration

One server-side variable:

```
GEMINI_API_KEY=...   # .env.local — never reaches the browser
```

That's it. When the key is present (and the edition isn't demo), the orb
renders for signed-in users.

## Architecture

```
VoiceButton (mercury orb, bottom-center)
   └─ useVoiceAgent (src/core/voice/useVoiceAgent.ts)
        ├─ McpToolBridge ──► /api/agent/mcp        session-authed MCP twin
        │                       └─ registerCapabilities()  ◄── shared with /api/mcp
        ├─ POST /api/agent/voice-token             mints a single-use ephemeral
        │                                          Gemini token (30 min cap)
        └─ VoiceAgentHandler ──► Gemini Live (wss) audio in/out + tool calls
              ├─ persona.ts        system prompt, voice (Charon), model
              └─ liveAudio.ts      16 kHz mic worklet / 24 kHz playback queue
```

- On orb click the bridge calls `tools/list`, the handler mints an ephemeral
  token and opens the Live session with every MCP tool declared as a function.
  Tool calls round-trip through MCP; camera commands (`fly_to`, `pan_globe`)
  ride the globe command queue this same browser tab polls — the globe reacts
  live.
- `GET /api/agent/voice-token` reports `{ configured }`; the overlay renders
  the orb only when the backend is ready.
- Transcripts: Gemini's input/output transcription streams feed the
  transcript panel (user + agent turns, plus tool activity).
- Audio input pauses while a tool call is in flight (the Live API rejects
  realtime input during tool processing); transient 1008/1011 socket closes
  auto-reconnect up to 3 times.
- Demo edition: the overlay never renders and all /api/agent/* routes are
  blocked.

## Changing the persona or voice

Edit `src/core/voice/persona.ts` — `SPATIALCORE_SYSTEM_PROMPT` (operator
persona + tool playbook), `SPATIALCORE_VOICE` (Gemini prebuilt voices:
Charon, Fenrir, Aoede, …), and `SPATIALCORE_LIVE_MODEL`.

## Files

- `src/core/voice/` — `VoiceAgentHandler.ts` (Live session + tools),
  `liveAudio.ts` (mic capture / playback), `McpToolBridge.ts`,
  `useVoiceAgent.ts`, `persona.ts`, `types.ts`
- `src/components/voice/` — `VoiceAgentOverlay.tsx`, `VoiceButton.tsx`,
  `VoiceTranscript.tsx`
- `src/styles/voice-agent.css` — orb + transcript styling
- `src/app/api/agent/voice-token/route.ts` — ephemeral token minting
- `src/app/api/agent/mcp/route.ts` — session-authed MCP endpoint
- `src/lib/mcp/registerCapabilities.ts` — shared capability registration
