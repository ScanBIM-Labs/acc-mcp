# ACC MCP

**Autodesk Construction Cloud integration via APS** — Manage projects, issues, RFIs, documents, and submittals.

[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://acc-mcp.itmartin24.workers.dev/)
[![MCP](https://img.shields.io/badge/protocol-MCP%202024--11--05-blue)](https://modelcontextprotocol.io)

## Tools (9)

| Tool | Description |
|------|-------------|
| `acc_list_projects` | List ACC/BIM 360 projects |
| `acc_create_issue` | Create issues via APS Issues API |
| `acc_update_issue` | Update issue status/priority/assignee |
| `acc_list_issues` | List and filter issues |
| `acc_create_rfi` | Create RFIs via APS RFIs API |
| `acc_list_rfis` | List and filter RFIs |
| `acc_search_documents` | Search drawings, specs, submittals |
| `acc_upload_file` | Upload files to project folders |
| `acc_project_summary` | Full project summary with counts |

## Quick Start

```json
{
  "mcpServers": {
    "acc": {
      "url": "https://acc-mcp.itmartin24.workers.dev/mcp"
    }
  }
}
```

## Architecture

- **Runtime**: Cloudflare Workers
- **Auth**: APS OAuth2 (client_credentials)
- **Database**: Cloudflare D1 (usage logging)
- **Cache**: Cloudflare KV (token caching)

## Part of [ScanBIM Labs AEC MCP Ecosystem](https://github.com/ScanBIM-Labs)

MIT — ScanBIM Labs LLC

## Authentication

Two accepted header formats. **Use one, do NOT mix:**

1. `x-scanbim-api-key: <your_user_key>` — value is the user_key verbatim.
2. `Authorization: Bearer sk_scanbim_<your_user_key>` — value is the entire string including the `sk_scanbim_` prefix; the D1 `user_key` column must match this full string.

Mixing formats auto-creates a fresh free-plan row for the alternate key (you'll silently get a new 50-credit account on each switch).

Get your user_key at [scanbim.app/settings/billing](https://scanbim.app/settings/billing).

### Example

```bash
curl -X POST https://mcp.scanbimlabs.io/unified/mcp \
  -H "content-type: application/json" \
  -H "x-scanbim-api-key: $SCANBIM_USER_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_models","arguments":{}}}'
```

### Response codes

- `200` — tool call proceeded; credits debited.
- `401` — missing or malformed auth header (middleware returns JSON-RPC error code `-32001`).
- `402` — insufficient credits; response body includes `checkout_urls` for all 5 credit packs and `top_up_url` for the billing page.
