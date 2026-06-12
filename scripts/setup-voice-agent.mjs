/**
 * @file setup-voice-agent.mjs
 * @description Creates or updates the SpatialCore ElevenLabs agent from the
 * live WWV MCP tool surface, so the voice agent's brain matches this project.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=xi-...  WWV_API_KEY=wwv-...  node scripts/setup-voice-agent.mjs
 *
 * Env:
 *   ELEVENLABS_API_KEY   required — ElevenLabs API key (xi-api-key)
 *   WWV_API_KEY          required — WWV API key (mint under the in-app "API Keys")
 *   WWV_MCP_URL          MCP endpoint for tool discovery (default http://localhost:5318/api/mcp)
 *   ELEVENLABS_AGENT_ID  update this agent instead of creating a new one
 *   WWV_PUBLIC_MCP_URL   optional https URL of the DEPLOYED /api/mcp. When set,
 *                        the script registers it as a server-side MCP server on
 *                        ElevenLabs (tools run in their cloud against prod)
 *                        INSTEAD of client tools. Leave unset for local dev:
 *                        client tools run in the signed-in browser tab.
 *
 * Afterwards: set NEXT_PUBLIC_ELEVENLABS_AGENT_ID=<printed id> in .env.local.
 */

import process from "process";

const ELEVEN_API = "https://api.elevenlabs.io";
const elevenKey = process.env.ELEVENLABS_API_KEY;
const wwvKey = process.env.WWV_API_KEY;
const mcpUrl = process.env.WWV_MCP_URL || "http://localhost:5318/api/mcp";
const existingAgentId = process.env.ELEVENLABS_AGENT_ID || "";
const publicMcpUrl = process.env.WWV_PUBLIC_MCP_URL || "";

if (!elevenKey || !wwvKey) {
  console.error("Usage: ELEVENLABS_API_KEY=... WWV_API_KEY=... node scripts/setup-voice-agent.mjs");
  process.exit(1);
}

// --- MCP discovery (JSON-RPC over Streamable HTTP, Bearer auth) ------------

async function mcpPost(body) {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${wwvKey}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP ${body.method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("text/event-stream")) {
    const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
    return dataLine ? JSON.parse(dataLine.slice(5)) : null;
  }
  return JSON.parse(text);
}

async function discoverTools() {
  await mcpPost({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "setup-voice-agent", version: "1.0.0" } },
  });
  const list = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const tools = list?.result?.tools ?? [];
  if (tools.length === 0) throw new Error("MCP tools/list returned no tools — is the app running and the API key valid?");
  return tools;
}

// --- Agent definition --------------------------------------------------------

const SYSTEM_PROMPT = `You are SpatialCore, the voice operator of a real-time geospatial intelligence platform. You are speaking with an analyst who is looking at an interactive 3D globe in their browser. Your tools are the platform's live MCP capabilities: everything you say about data must come from tool results, and the camera/layers you control change what the analyst sees in real time.

THE PLATFORM
SpatialCore streams live global data onto the globe as toggleable layers. Live engine-backed layers include: aviation (OpenSky), military aviation (adsb.lol), FR24 flights, maritime vessels (AIS), earthquakes (USGS), wildfires (NASA FIRMS VIIRS), GPS jamming, satellites and surveillance satellites, cyber threats (AlienVault OTX), civil unrest (GDELT), conflict events, international sanctions, Iran War Live OSINT, rocket launches, and a market tracker. Static reference layers include: undersea cables, nuclear facilities, military bases, embassies, volcanoes, seaports, lighthouses, spaceports, airports, mineral mines, conflict zones, air defense zones, borders and labels, and day/night.

TOOL PLAYBOOK
- "What am I looking at?" → get_globe_context.
- "What data is live right now?" → list_available_plugins.
- Turning layers on/off → toggle_layer with the plugin id (e.g. earthquakes, aviation, maritime, civil-unrest, conflict-events, wildfire, undersea-cables).
- Going somewhere → geocode_location to resolve the place, then fly_to with its coordinates or bounding box. Tell the analyst where you are taking them.
- Questions about entities → search_entities (by name), get_entities_in_region (bounding box), get_entity_details (one entity), get_plugin_data (full layer snapshot). For a regional overview use investigate_area.
- Filtering a layer → get_plugin_filters first to learn the fields, then set_filter; clear_filter to reset.
- Bookmarks → save_favorite, list_favorites, remove_favorite.

STYLE
You are a calm, sharp operations specialist. Keep spoken answers short — lead with the answer, then one or two notable details. Use real numbers from tool results; never invent data. When a request is ambiguous, pick the most useful interpretation and say what you did. Chain tools without asking permission (e.g. geocode then fly). After moving the camera or toggling layers, briefly confirm what changed on the globe. Offer a relevant next step when it is genuinely useful, not as filler.`;

const FIRST_MESSAGE = "SpatialCore online. Where do you want to look?";

function toClientTools(mcpTools) {
  return mcpTools.map((tool) => ({
    type: "client",
    name: tool.name,
    description: (tool.description || "").slice(0, 1000),
    parameters: tool.inputSchema && Object.keys(tool.inputSchema).length > 0
      ? tool.inputSchema
      : { type: "object", properties: {} },
    expects_response: true,
  }));
}

// --- ElevenLabs API ----------------------------------------------------------

async function elevenFetch(path, method, body) {
  const res = await fetch(`${ELEVEN_API}${path}`, {
    method,
    headers: { "xi-api-key": elevenKey, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

async function registerMcpServer() {
  const created = await elevenFetch("/v1/convai/mcp-servers", "POST", {
    config: {
      url: publicMcpUrl,
      name: "WorldWideView MCP",
      description: "SpatialCore/WWV geospatial intelligence MCP — globe camera, layers, live data queries.",
      transport: "STREAMABLE_HTTP",
      request_headers: { Authorization: `Bearer ${wwvKey}` },
      approval_policy: "auto_approve_all",
    },
  });
  console.log(`Registered MCP server: ${created.id} → ${publicMcpUrl}`);
  return created.id;
}

async function main() {
  let prompt = {
    prompt: SYSTEM_PROMPT,
    llm: "gemini-2.5-flash",
    temperature: 0.3,
  };

  if (publicMcpUrl) {
    const mcpServerId = await registerMcpServer();
    prompt.mcp_server_ids = [mcpServerId];
    console.log("Mode: server-side MCP (tools run in ElevenLabs cloud against the deployed app).");
  } else {
    const tools = await discoverTools();
    prompt.tools = toClientTools(tools);
    console.log(`Mode: client tools — ${tools.length} MCP tools registered:`);
    console.log(`  ${tools.map((t) => t.name).join(", ")}`);
  }

  const agentPayload = {
    name: "SpatialCore",
    conversation_config: {
      agent: {
        prompt,
        first_message: FIRST_MESSAGE,
        language: "en",
      },
    },
  };

  let agentId = existingAgentId;
  if (agentId) {
    await elevenFetch(`/v1/convai/agents/${agentId}`, "PATCH", agentPayload);
    console.log(`Updated agent ${agentId}`);
  } else {
    const created = await elevenFetch("/v1/convai/agents/create", "POST", agentPayload);
    agentId = created.agent_id;
    console.log(`Created agent ${agentId}`);
  }

  console.log("\nNext steps:");
  console.log(`  1. Add to .env.local:  NEXT_PUBLIC_ELEVENLABS_AGENT_ID=${agentId}`);
  console.log("  2. Restart the dev server, click the orb, allow the microphone.");
  console.log("  3. Voice/model tweaks: https://elevenlabs.io/app/agents");
}

main().catch((err) => {
  console.error(`\nSetup failed: ${err.message}`);
  process.exit(1);
});
