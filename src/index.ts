#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { isLoginInProgress, loginWithDeviceFlow, refreshSessionIfNeeded } from './auth.js';
import { executeCommand, listAllCommands } from './api.js';
import { BASE_URL, getAuthHeaders, isLoggedIn, readConfig } from './config.js';

process.on('uncaughtException', (err) => {
    process.stderr.write(`[uyaro] uncaughtException: ${err.message}\n`);
});
process.on('unhandledRejection', (reason) => {
    process.stderr.write(`[uyaro] unhandledRejection: ${reason}\n`);
});

const server = new McpServer({ name: '@uyaro/mcp', version: '0.2.0' });

// ── Helpers ────────────────────────────────────────────────────────────────────

function text(t: string) {
    return { content: [{ type: 'text' as const, text: t }] };
}

function json(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function error(message: string) {
    return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true };
}

/** Wait up to `ms` for isLoggedIn() to become true (polls every 1s) */
async function waitForLogin(ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (isLoggedIn()) return true;
        await new Promise((r) => setTimeout(r, 1000));
    }
    return isLoggedIn();
}

// ── Tools ──────────────────────────────────────────────────────────────────────

server.registerTool(
    'login',
    {
        description:
            'Authenticate with Uyaro POS via browser. Returns a URL and short code — show them to the user ' +
            'and ask them to open the URL and enter the code. The token is saved automatically once login ' +
            'completes in the browser. After the user confirms, call run_command("stores list") to verify the session.',
    },
    async () => {
        if (await refreshSessionIfNeeded()) {
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
                `3. Then call run_command with "stores list" to confirm login succeeded.`,
        );
    },
);

server.registerTool(
    'run_command',
    {
        description:
            'Run any Uyaro command (see list_commands; generated from the live API spec, so it is always current). ' +
            'Path params go positionally or as --name=value; other --name=value flags become the query (GET) or JSON body. ' +
            'Values are parsed as JSON when possible, so --amount=100, --active=true and --items=\'[...]\' keep their types. ' +
            'Examples: "customers read --id=<merchantId>", "stores list --merchantId=<id>", ' +
            '"purchases create --merchantId=x --storeId=y --terminalId=z". ' +
            'Call get_docs first when operating an unfamiliar domain.',
        inputSchema: {
            command: z
                .string()
                .describe('CLI command to run, e.g. "customers read --id=abc123"'),
        },
    },
    async ({ command }) => {
        // If login is in progress, wait up to 30s for the token
        if (!isLoggedIn() && isLoginInProgress()) {
            const loggedIn = await waitForLogin(30_000);
            if (!loggedIn) {
                return text(`Login is still in progress. Please complete login in your browser first.`);
            }
        }

        if (!(await refreshSessionIfNeeded())) {
            return text(`Not logged in. Call the 'login' tool first.`);
        }

        const result = await executeCommand(command);
        return result.ok ? json(result.data) : error(result.error);
    },
);

server.registerTool(
    'get_docs',
    {
        description:
            'Get documentation for a Uyaro domain. Always call this before operating an unfamiliar domain. ' +
            'Explains concepts, workflows, constraints, and field quirks. ' +
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

        // /cli/docs returns the doc itself, not the usual { status, data } envelope.
        const body = (await res.json()) as { data?: unknown };
        return json(body.data ?? body);
    },
);

server.registerTool(
    'list_commands',
    {
        description:
            'List all available Uyaro CLI commands grouped by domain, generated from the live API spec. ' +
            'Use this to discover what operations are available.',
    },
    async () => {
        const result = await listAllCommands();
        if (result.ok) return json(result.data);
        return error(result.error);
    },
);

// ── Startup ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('@uyaro/mcp ready\n');
