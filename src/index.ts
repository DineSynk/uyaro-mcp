#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loginWithDeviceFlow } from './auth.js';
import { checkForUpdate, ensureBinary, isBinaryInstalled, runCli } from './cli.js';
import { BASE_URL, getAuthHeaders, isLoggedIn, readConfig, writeConfig } from './config.js';

// Prevent any unhandled error from killing the MCP server process
process.on('uncaughtException', (err) => {
    process.stderr.write(`[uyaro] uncaughtException: ${err.message}\n${err.stack}\n`);
});
process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[uyaro] unhandledRejection: ${reason}\n`);
});

const server = new McpServer({ name: '@uyaro/mcp', version: '0.1.6' });

// ── Tools ──────────────────────────────────────────────────────────────────────

server.registerTool(
    'login',
    {
        description:
            'Authenticate with Uyaro POS via browser. Returns a URL and short code — show them to the user ' +
            'and ask them to open the URL and enter the code. The token is saved automatically once login ' +
            'completes in the browser. Call run_command("auth whoami") after the user confirms to verify.',
    },
    async () => {
        if (isLoggedIn()) {
            const config = readConfig();
            return text(
                `Already logged in. Token expires ${new Date(config.expiresAt!).toLocaleString()}. ` +
                    `Use run_command to operate the Uyaro backend.`,
            );
        }

        const { verificationUri, userCode, verificationUriComplete } = await loginWithDeviceFlow();

        return text(
            `🔐 Login required.\n\n` +
                `1. Open this URL in a browser:\n   ${verificationUriComplete}\n\n` +
                `   Or go to: ${verificationUri}\n` +
                `   And enter code: ${userCode}\n\n` +
                `2. Complete login in the browser.\n\n` +
                `3. Then call run_command with "auth whoami" to confirm login succeeded.`,
        );
    },
);

server.registerTool(
    'run_command',
    {
        description:
            'Run any Uyaro CLI command. Pass the command exactly as you would to the CLI. ' +
            'Examples: "customers read --id=<merchantId>", "orders create --merchantId=x --storeId=y --terminalId=z". ' +
            'Call get_docs first when operating an unfamiliar domain.',
        inputSchema: {
            command: z
                .string()
                .describe('CLI command to run, e.g. "customers read --id=abc123"'),
        },
    },
    async ({ command }) => {
        if (!isLoggedIn()) {
            return text(`Not logged in. Call the 'login' tool first.`);
        }

        try {
            await ensureBinary();
        } catch (err) {
            return error(`Failed to install CLI binary: ${err instanceof Error ? err.message : String(err)}`);
        }

        const result = await runCli(parseCommand(command));

        const raw = result.ok ? result.stdout : result.stderr || result.stdout;
        try {
            return json(JSON.parse(raw) as unknown);
        } catch {
            return result.ok ? text(raw) : error(raw || 'Command failed with no output');
        }
    },
);

server.registerTool(
    'get_docs',
    {
        description:
            'Get documentation for a Uyaro domain. Always call this before operating an unfamiliar domain. ' +
            'Explains concepts, workflows, constraints, and field quirks (e.g. polymorphic IDs). ' +
            'Omit domain to list all available domains.',
        inputSchema: {
            domain: z
                .string()
                .optional()
                .describe(
                    'Domain name: customers, purchases, payments, wallet, terminals, kot, menus, ' +
                        'product-catalogue, campaigns, analytics, contracts, recipes, reports, printers, invoices, auth. ' +
                        'Omit to list all.',
                ),
        },
    },
    async ({ domain }) => {
        const url = domain
            ? `${BASE_URL}/cli/docs/${encodeURIComponent(domain)}`
            : `${BASE_URL}/cli/docs`;

        const res = await fetch(url, { headers: getAuthHeaders() });

        if (res.status === 404) {
            return error(
                `Domain '${domain}' not found. Call get_docs without a domain to see all available domains.`,
            );
        }
        if (!res.ok) return error(`Failed to fetch docs: ${res.statusText}`);

        const body = (await res.json()) as { data: unknown };
        return json(body.data);
    },
);

server.registerTool(
    'list_commands',
    {
        description:
            'List all available Uyaro CLI commands grouped by domain, generated from the live API spec. ' +
            'Use this to discover what operations are available before deciding what to run.',
    },
    async () => {
        const res = await fetch(`${BASE_URL}/api/json`, { headers: getAuthHeaders() });
        if (!res.ok) return error(`Failed to fetch API spec: ${res.statusText}`);

        type TSpec = {
            paths: Record<
                string,
                Record<string, { tags?: string[]; summary?: string; security?: unknown[] }>
            >;
        };
        const spec = (await res.json()) as TSpec;
        const grouped: Record<
            string,
            Array<{ command: string; summary: string; auth: boolean }>
        > = {};

        for (const [path, methods] of Object.entries(spec.paths ?? {})) {
            for (const [method, op] of Object.entries(methods)) {
                if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
                const cmd = pathToCommand(method, path);
                const domain = cmd.split(' ')[0] ?? 'other';
                (grouped[domain] ??= []).push({
                    command: cmd,
                    summary: op.summary ?? '',
                    auth: Array.isArray(op.security) && op.security.length > 0,
                });
            }
        }

        return json(grouped);
    },
);

// ── Helpers ────────────────────────────────────────────────────────────────────

const VERB_LIKE =
    /^(create|update|delete|list|query|get|read|search|approve|revoke|cancel|sync|export|import|login|signup|logout|refresh|change|register|reopen|extend|reset|verify|activate|deactivate|enable|disable|upload|download|bulk-delete|bulk-create|generate|send|process|complete|void|archive|add|remove|check|apply|redeem)$/;

function pathToCommand(method: string, path: string): string {
    const segments = path
        .replace(/^\//, '')
        .split('/')
        .filter(Boolean)
        .map((s) => (s.startsWith(':') ? '' : s))
        .filter(Boolean);

    const last = segments[segments.length - 1] ?? '';
    if (VERB_LIKE.test(last)) return segments.join(' ');

    const verb =
        method === 'get'
            ? 'list'
            : method === 'post'
              ? 'create'
              : method === 'put'
                ? 'update'
                : 'delete';

    return [...segments, verb].join(' ');
}

function parseCommand(command: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (const ch of command) {
        if (inQuote) {
            if (ch === quoteChar) inQuote = false;
            else current += ch;
        } else if (ch === '"' || ch === "'") {
            inQuote = true;
            quoteChar = ch;
        } else if (ch === ' ') {
            if (current) parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current) parts.push(current);
    return parts;
}

function text(t: string) {
    return { content: [{ type: 'text' as const, text: t }] };
}

function json(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function error(message: string) {
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

// ── Startup: connect first, then update in background ─────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('@uyaro/mcp ready\n');

// Background: check for CLI binary update + API spec changes (non-blocking)
void (async () => {
    // 1. Check for new CLI binary release on GitHub
    if (isBinaryInstalled()) await checkForUpdate();

    // 2. Check for API spec changes via /cli/version
    await checkSpecDiff();
})();

async function checkSpecDiff(): Promise<void> {
    try {
        const config = readConfig();
        const res = await fetch(`${BASE_URL}/cli/version`, { headers: getAuthHeaders() });
        if (!res.ok) return;

        const body = (await res.json()) as { data?: { specHash: string; version: string } };
        const newHash = body.data?.specHash;
        if (!newHash || newHash === config.specHash) return;

        // Fetch the diff so it's available for agents to query
        const diffRes = await fetch(`${BASE_URL}/cli/diff`, { headers: getAuthHeaders() });
        const diff = diffRes.ok
            ? ((await diffRes.json()) as { data?: unknown }).data
            : null;

        writeConfig({ specHash: newHash });

        process.stderr.write(
            `[uyaro] API spec updated to ${body.data?.version ?? newHash.slice(0, 8)}` +
                (diff ? ` — ${JSON.stringify(diff)}` : '') +
                '\n',
        );
    } catch {
        // Silent — spec check must not crash the server
    }
}
