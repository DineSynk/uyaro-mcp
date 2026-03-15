---
description: Operate the Uyaro POS backend — create customers, manage orders, check analytics, and more via the MCP tools
---

You are now operating the Uyaro POS backend. Follow this protocol.

## Step 1 — Check auth

Call the `login` MCP tool. If already logged in it will say so. If not, it will give you a URL and code:
- Show the URL and code to the user
- Ask them to complete login in the browser
- Wait for confirmation, then verify with `run_command("auth whoami")`

## Step 2 — Understand the domain before acting

Before running any write command, call `get_docs` with the relevant domain:
- `get_docs({ domain: "customers" })` — before creating or reading customers
- `get_docs({ domain: "purchases" })` — before creating orders
- `get_docs({ domain: "wallet" })` — before crediting/debiting wallet
- `get_docs` without args — to see all domains and their descriptions

Read the **constraints** section. It tells you about immutable fields, polymorphic IDs, and irreversible operations.

## Step 3 — Discover commands

If unsure what command to use, call `list_commands` to see all available operations grouped by domain.

## Step 4 — Run commands

Use `run_command` with CLI-style syntax:

```
customers read --id=<merchantId>
customers create --merchantId=x --storeId=y --name="Jane Doe" --phone=9876543210
orders create --merchantId=x --storeId=y --terminalId=z
wallet transaction create --walletId=x --amount=500 --type=CREDIT --note="Purchase reward"
stores list --merchantId=x
auth whoami
```

## Key constraints

| Domain | Critical constraint |
|---|---|
| customers | `--id` is polymorphic — pass merchantId, storeId, or customerId; server auto-detects |
| wallet | Balance = sum of transactions. Never edit directly. Use `wallet transaction create` |
| orders | One-directional: created → completed or cancelled. Cannot revert |
| terminals | Two-step registration: generate code → register device with code |
| reports | Z-day locks the business day permanently — cannot reset |
| money | **Always in cents.** ₹5.00 = `500`. Never use decimals |

## Error handling

If `run_command` fails:
1. Read the error carefully
2. Call `get_docs` for that domain to check constraints and field names
3. Diagnose before retrying — never retry the same command blindly
