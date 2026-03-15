# Uyaro — Claude Code Plugin

Operate the [Uyaro](https://uyaro.com) restaurant POS platform from Claude. Create customers, manage orders, check analytics, handle payments, and more — all via natural language.

## Install

### Claude Code (recommended)

```bash
/plugin marketplace add DineSynk/uyaro-mcp
/plugin install uyaro@uyaro
```

Or via CLI:

```bash
claude plugin marketplace add DineSynk/uyaro-mcp
claude plugin install uyaro@uyaro
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
    "mcpServers": {
        "uyaro": {
            "command": "npx",
            "args": ["-y", "@uyaro/mcp"]
        }
    }
}
```

## First use

After installing, open Claude Code and type `/uyaro`. Claude walks you through:

1. **Login** — calls the `login` MCP tool, shows a URL + code, waits for you to authenticate in the browser
2. **Explore** — use `get_docs` to understand any domain before operating it
3. **Run** — use `run_command` with CLI-style syntax

## What you can do

```
"Add 5 new customers to merchant abc123"
"List all orders for store xyz today"
"Credit 500 loyalty points to customer wallet wlt_abc"
"Show me all terminals for merchant abc and their status"
"Generate the end-of-day report for store xyz"
"What products are in category 'Beverages'?"
```

## MCP tools

| Tool | Description |
|---|---|
| `login` | Browser-based OAuth login. Shows URL + code. Token saved automatically. |
| `run_command` | Run any CLI command: `"customers read --id=abc"`, `"orders create ..."` |
| `get_docs` | Domain documentation — concepts, workflows, constraints. Call before operating a new domain. |
| `list_commands` | All available commands grouped by domain, generated live from the API spec. |

## How it works

The plugin bundles:
- A `/uyaro` **skill** (`.claude-plugin` system) that guides Claude through the login → explore → operate flow
- An **MCP server** (`@uyaro/mcp` on npm) that exposes the four tools above
- The MCP server calls the Uyaro production API at `https://v2.api.kioskade.com`

Tokens are stored at `~/.config/dinesynk/config.json`. Login once, use everywhere.

## Submit to official marketplace

This plugin can be submitted to the official Anthropic marketplace via [claude.ai/settings/plugins/submit](https://claude.ai/settings/plugins/submit).

## Requirements

- Claude Code 1.0.33+
- Node.js 20+ (for the MCP server via npx)
