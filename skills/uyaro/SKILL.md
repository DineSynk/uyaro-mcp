---
description: Operate the Uyaro POS backend — create customers, manage orders, check analytics, process payments, and more
---

You are now operating the Uyaro POS backend via the Uyaro MCP server.

## Setup (first time only)

If the `uyaro` MCP tools are not available, the server needs to be installed. Tell the user:

> **To install the Uyaro MCP server**, add this to your Claude Code MCP config:
>
> ```bash
> claude mcp add uyaro -- npx -y @uyaro/mcp
> ```
>
> Or manually add to `.mcp.json` in your project root:
> ```json
> {
>   "mcpServers": {
>     "uyaro": {
>       "command": "npx",
>       "args": ["-y", "@uyaro/mcp"]
>     }
>   }
> }
> ```
>
> Then restart Claude Code. The MCP server installs automatically on first use — no separate install step needed.

Once the MCP server is running, continue below.

---

## Step 1 — Authenticate

Call the `login` tool:

```
login()
```

- If already logged in → it confirms and you can skip to Step 3
- If not → it returns a URL and a short code. Show both to the user:

> Open this URL in your browser and enter the code shown:
> `<verification_uri_complete>`
>
> Or go to: `<verification_uri>` and enter code: `<user_code>`

Wait for the user to say they've completed it, then verify:
```
run_command("auth whoami")
```

If whoami succeeds, authentication is complete.

---

## Step 2 — Orient (skip if user's request is clear)

If the user hasn't specified a domain, call:
```
get_docs()
```
This lists all available domains. Use the output to understand scope before proceeding.

For a specific domain, always call docs before first use:
```
get_docs({ domain: "customers" })
get_docs({ domain: "purchases" })
get_docs({ domain: "wallet" })
```

Read the **constraints** section carefully — it lists immutable fields, polymorphic IDs, and irreversible operations.

---

## Step 3 — Discover commands

If unsure what CLI command to use:
```
list_commands()
```
Returns all operations grouped by domain, generated live from the API spec.

---

## Step 4 — Execute

Use `run_command` with CLI-style syntax. Examples:

```
run_command("auth whoami")
run_command("stores list --merchantId=<id>")
run_command("customers create --merchantId=x --storeId=y --name='Jane Doe' --phone=9876543210")
run_command("customers read --id=<merchantId>")
run_command("purchases create --merchantId=x --storeId=y --terminalId=z")
run_command("wallet transaction create --walletId=x --amount=500 --type=CREDIT --note='Reward'")
run_command("payments list --merchantId=x --storeId=y")
run_command("terminals list --merchantId=x")
run_command("reports list --merchantId=x --storeId=y")
```

---

## Critical constraints

| Domain | Rule |
|---|---|
| **Money** | **Always in cents.** ₹5.00 = `500`. Never use decimals |
| customers | `--id` is polymorphic — pass merchantId, storeId, or customerId; server auto-detects |
| wallet | Balance = sum of transactions. Use `wallet transaction create` — never edit directly |
| purchases | One-directional: created → completed or cancelled. Cannot revert |
| terminals | Two-step: generate registration code → register device with that code |
| reports | Z-report locks the business day permanently — cannot undo |

---

## Error handling

If `run_command` returns an error:
1. Read the error message carefully
2. Call `get_docs({ domain: "<domain>" })` to check field names and constraints
3. Diagnose the root cause before retrying — never retry the same failing command blindly
4. For auth errors: call `login()` to refresh the token
