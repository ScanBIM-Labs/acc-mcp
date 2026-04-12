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
