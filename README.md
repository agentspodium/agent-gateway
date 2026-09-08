# agent-gateway

Lets other AI agents drive AgentsPodium hosting (create/monitor/manage
instances) through two machine protocols — MCP (Streamable HTTP) and A2A
(Agent2Agent JSON-RPC) — both backed by the existing account API at
`https://agentspodium.com/api`.

The gateway holds **no state and no secrets of its own**. Every call carries
the caller's own AgentsPodium API key (`Authorization: Bearer ak_live_...`, or
a session token), which is forwarded verbatim to the account API. Missing
that header always answers `401` with a JSON body pointing at
https://agentspodium.com/account ("API keys for agents") and
https://hosting.defispace.com/docs/auth.

One process serves both hostnames, selected by the `Host` header wherever a
path is shared between the two (only `GET /`); everything else defaults to
MCP behaviour, and `mcp.agentspodium.com` / `a2a.agentspodium.com` route to
the same Deployment.

## Run locally

```bash
npm install
npm run build
ACCOUNT_API=https://agentspodium.com/api PORT=3200 npm start
# or, for iteration:
npm run dev
```

Env vars:

- `ACCOUNT_API` — base URL of the account API (default `https://agentspodium.com/api`).
- `PORT` — HTTP port (default `3200`).
- `A2A_HOST` — hostname that selects A2A behaviour for `GET /` (default `a2a.agentspodium.com`).

## Calling it

### MCP — `mcp.agentspodium.com/mcp`

Streamable HTTP, stateless (no session id). Requires
`Accept: application/json, text/event-stream`.

```bash
# initialize
curl -s -X POST https://mcp.agentspodium.com/mcp \
  -H "Authorization: Bearer ak_live_..." \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
      "protocolVersion": "2025-06-18",
      "capabilities": {},
      "clientInfo": { "name": "example-client", "version": "0.1.0" }
    }
  }'

# call a tool
curl -s -X POST https://mcp.agentspodium.com/mcp \
  -H "Authorization: Bearer ak_live_..." \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "tools/call",
    "params": { "name": "list_platforms", "arguments": {} }
  }'
```

Tools: `list_platforms`, `list_instances`, `create_instance`,
`instance_health`, `instance_term`, `set_llm_key`, `pause_instance`,
`resume_instance`, `rebuild_instance`, `delete_instance`, `payment_options`,
`set_peers`. Plus one resource, `agentspodium://docs` (the hosting docs).

### A2A — `a2a.agentspodium.com/`

```bash
curl -s https://a2a.agentspodium.com/.well-known/agent-card.json

# structured (data part)
curl -s -X POST https://a2a.agentspodium.com/ \
  -H "Authorization: Bearer ak_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "message/send",
    "params": {
      "message": {
        "parts": [{ "kind": "data", "data": { "skill": "create-instance", "params": { "engine": "hermes", "tier": "small", "name": "My Agent" } } }]
      }
    }
  }'

# plain text (small command grammar)
curl -s -X POST https://a2a.agentspodium.com/ \
  -H "Authorization: Bearer ak_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0", "id": 2, "method": "message/send",
    "params": { "message": { "parts": [{ "kind": "text", "text": "platforms" }] } }
  }'
```

Text grammar: `create <engine> <tier> [name ...]`, `health <id>`,
`term <id>`, `platforms`, `payment <id>`. Anything else answers with the
skill list and the exact JSON shape.

Public, no auth: `GET /catalog.json` (proxy of the account API's
`/a2a-catalog`).

## Deploy

```bash
docker build -t agentpodium-agent-gateway apps/agent-gateway
# push, then apply:
kubectl apply -f apps/agent-gateway/deploy/gateway.yaml
```

`deploy/gateway.yaml` creates namespace `ap-agentgw`, a Deployment/Service on
port 3200, and two `HTTPRoute`s (`mcp.agentspodium.com`,
`a2a.agentspodium.com`) against the shared `akash-gateway` Gateway. Swap
`__IMAGE_TAG__` for the built image tag before applying.
