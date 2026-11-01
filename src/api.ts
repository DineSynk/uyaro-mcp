/**
 * Direct HTTP executor — resolves CLI-style commands to OpenAPI operations
 * and executes them via fetch. No CLI binary needed.
 */

import { BASE_URL, getAuthHeaders } from './config.js';

// ── Types ───────────────────────────────────────────────────────────────────

type TOpenApiParam = {
    name: string;
    in: string;
    required?: boolean;
};

type TOpenApiOperation = {
    operationId?: string;
    summary?: string;
    tags?: string[];
    security?: unknown[];
    parameters?: TOpenApiParam[];
    requestBody?: unknown;
};

type TOpenApiSpec = {
    paths: Record<string, Record<string, TOpenApiOperation>>;
};

type TResolvedOperation = {
    method: string;
    path: string;
    pathParams: string[];
    operation: TOpenApiOperation;
    cmdTokenCount: number;
    impliedPositional?: string[];
};

export type ApiResult = { ok: true; data: unknown } | { ok: false; error: string };

// ── Spec cache (5 min TTL) ──────────────────────────────────────────────────

let _spec: TOpenApiSpec | null = null;
let _specFetchedAt = 0;
const SPEC_TTL = 5 * 60 * 1000;

async function loadSpec(): Promise<TOpenApiSpec | null> {
    if (_spec && Date.now() - _specFetchedAt < SPEC_TTL) return _spec;
    try {
        const res = await fetch(`${BASE_URL}/api/json`, { headers: getAuthHeaders() });
        if (!res.ok) return null;
        _spec = (await res.json()) as TOpenApiSpec;
        _specFetchedAt = Date.now();
        return _spec;
    } catch {
        return null;
    }
}

// ── Command ↔ Path mapping ──────────────────────────────────────────────────

const VERB_LIKE =
    /^(create|update|delete|list|query|get|read|search|approve|revoke|cancel|sync|export|import|login|signup|logout|refresh|change|register|reopen|extend|reset|verify|activate|deactivate|enable|disable|upload|download|bulk-delete|bulk-create|generate|send|process|complete|void|archive|add|remove|check|apply|redeem)$/i;

export function pathToCommand(method: string, path: string): string {
    const parts = path.replace(/^\//, '').split('/');
    const staticParts = parts.filter((p) => !p.startsWith('{'));
    const last = staticParts[staticParts.length - 1];

    if (VERB_LIKE.test(last ?? '')) {
        staticParts.pop();
        return `${staticParts.join(' ')} ${last}`.trim();
    }

    const hasPathParam = parts.some((p) => p.startsWith('{'));
    const action =
        method === 'GET' && !hasPathParam
            ? 'list'
            : method === 'GET'
              ? 'get'
              : method === 'POST'
                ? 'create'
                : method === 'PUT' || method === 'PATCH'
                  ? 'update'
                  : method === 'DELETE'
                    ? 'delete'
                    : method.toLowerCase();

    const domain = staticParts.join(' ') || path;
    return `${domain} ${action}`.trim();
}

/** Flag values are strings on the command line; keep numbers, booleans, null, arrays and objects typed. */
export function coerceValue(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

// A few paths map to the same command (e.g. `terminals read` with 1 or 3 path params,
// GET vs POST `auth oauth device approve`); pick the one the given params actually satisfy.
function satisfiedParams(op: TResolvedOperation, positional: number, named: Set<string>): number {
    return op.pathParams.every((p, i) => i < positional || named.has(p)) ? op.pathParams.length : -1;
}

export function resolveCommand(
    spec: TOpenApiSpec,
    cmdParts: string[],
    positionalCount = 0,
    namedKeys: Set<string> = new Set(),
): TResolvedOperation | null {
    const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];
    let best: TResolvedOperation | null = null;

    for (const [path, pathItem] of Object.entries(spec.paths)) {
        for (const rawMethod of httpMethods) {
            const operation = pathItem[rawMethod];
            if (!operation) continue;

            const command = pathToCommand(rawMethod.toUpperCase(), path);
            const commandParts = command.split(' ');

            if (
                cmdParts.length >= commandParts.length &&
                commandParts.every((part, i) => part.toLowerCase() === cmdParts[i]?.toLowerCase())
            ) {
                const candidate: TResolvedOperation = {
                    method: rawMethod.toUpperCase(),
                    path,
                    pathParams: (path.match(/\{(\w+)\}/g) ?? []).map((p) => p.slice(1, -1)),
                    operation,
                    cmdTokenCount: commandParts.length,
                };
                const extraPositional = Math.max(0, positionalCount - commandParts.length);
                if (
                    !best ||
                    candidate.cmdTokenCount > best.cmdTokenCount ||
                    (candidate.cmdTokenCount === best.cmdTokenCount &&
                        satisfiedParams(candidate, extraPositional, namedKeys) >
                            satisfiedParams(best, extraPositional, namedKeys))
                ) {
                    best = candidate;
                }
            }
        }
    }

    return best;
}

/**
 * Agents naturally type `analytics order-stats` for what the spec names `analytics order-stats create`.
 * Accept the short form only when it matches exactly one action, so we never guess between read and write.
 */
export function resolveWithImpliedAction(
    spec: TOpenApiSpec,
    cmdParts: string[],
    namedKeys: Set<string> = new Set(),
): TResolvedOperation | null {
    const exact = resolveCommand(spec, cmdParts, cmdParts.length, namedKeys);
    if (exact) return exact;

    const flagless = cmdParts.filter((part) => !part.startsWith('--'));
    const matches: TResolvedOperation[] = [];
    for (const action of ['list', 'get', 'create', 'update', 'delete']) {
        for (let split = flagless.length; split > 0; split--) {
            const attempt = [...flagless.slice(0, split), action];
            const found = resolveCommand(spec, attempt, attempt.length + flagless.length - split, namedKeys);
            if (found && found.cmdTokenCount === attempt.length) {
                matches.push({ ...found, impliedPositional: flagless.slice(split) });
                break;
            }
        }
    }
    return matches.length === 1 ? matches[0]! : null;
}

// ── Command parser ──────────────────────────────────────────────────────────

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

/** The API rejects bad input with no detail, so tell the agent what the spec requires and it can correct itself. */
export function validationHint(errorCodes: string[] | undefined, operation: TOpenApiOperation): string {
    if (!errorCodes?.includes('VALIDATION_ERROR')) return '';
    const content = (operation.requestBody as { content?: Record<string, { schema?: { required?: string[] } }> } | undefined)?.content;
    const required = Object.values(content ?? {})[0]?.schema?.required ?? [];
    return required.length ? `. Required fields: ${required.join(', ')}` : '';
}

// ── Execute ─────────────────────────────────────────────────────────────────

export async function executeCommand(command: string): Promise<ApiResult> {
    const tokens = parseCommand(command);
    const cmdParts = tokens.filter((t) => !t.startsWith('--'));
    const argList = tokens.filter((t) => t.startsWith('--'));

    const spec = await loadSpec();
    if (!spec) {
        return { ok: false, error: 'Cannot reach the Uyaro API. Check your connection.' };
    }

    const namedKeys = new Set(argList.map((a) => a.match(/^--(\w[\w-]*)=/)?.[1]).filter((k): k is string => !!k));
    const resolved = resolveWithImpliedAction(spec, cmdParts, namedKeys);
    if (!resolved) {
        // Suggest similar commands
        const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];
        const allCommands: string[] = [];
        for (const [path, pathItem] of Object.entries(spec.paths)) {
            for (const m of httpMethods) {
                if (pathItem[m]) allCommands.push(pathToCommand(m.toUpperCase(), path));
            }
        }
        const target = cmdParts.join(' ').toLowerCase();
        const similar = allCommands
            .filter((c) => c.startsWith(cmdParts[0] ?? '') || c.includes(target))
            .slice(0, 5);

        const hint = similar.length
            ? `\nDid you mean:\n${similar.map((c) => `  ${c}`).join('\n')}`
            : '';
        return { ok: false, error: `Unknown command: ${cmdParts.join(' ')}${hint}` };
    }

    const { method, path, pathParams, operation, cmdTokenCount } = resolved;

    // Collect params
    const positional = resolved.impliedPositional ?? cmdParts.slice(cmdTokenCount);
    const named: Record<string, string> = {};
    for (const arg of argList) {
        const match = arg.match(/^--(\w[\w-]*)=(.+)$/);
        if (match) named[match[1]] = match[2];
    }

    // Fill path params
    let resolvedPath = path;
    for (let i = 0; i < pathParams.length; i++) {
        const value = positional[i] ?? named[pathParams[i]];
        if (!value) {
            return { ok: false, error: `Missing required param: ${pathParams[i]}` };
        }
        resolvedPath = resolvedPath.replace(`{${pathParams[i]}}`, encodeURIComponent(value));
    }

    // Split named params into query vs body
    const queryParams = new URLSearchParams();
    const body: Record<string, unknown> = {};
    const queryParamNames = new Set(
        (operation.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name),
    );

    for (const [key, value] of Object.entries(named)) {
        if (pathParams.includes(key)) continue;
        if (queryParamNames.has(key) || method === 'GET') {
            queryParams.set(key, value);
        } else {
            body[key] = coerceValue(value);
        }
    }

    // Execute HTTP request
    const qs = queryParams.toString();
    const url = `${BASE_URL}${resolvedPath}${qs ? '?' + qs : ''}`;
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
    };

    const hasBody = method !== 'GET' && method !== 'DELETE' && Object.keys(body).length > 0;

    let response: Response;
    try {
        response = await fetch(url, {
            method,
            headers,
            body: hasBody ? JSON.stringify(body) : undefined,
        });
    } catch (err) {
        return { ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` };
    }

    const text = await response.text();
    let data: unknown;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }

    if (!response.ok && response.status >= 500) {
        return { ok: false, error: `Server error ${response.status}` };
    }

    // Standard envelope: { status: 'SUCCESS' | 'ERROR', data, errorMessage }
    if (data && typeof data === 'object' && 'status' in (data as object)) {
        const env = data as { status: string; data?: unknown; errorCodes?: string[]; errorMessage?: string; message?: string };
        if (env.status === 'ERROR') {
            const message = env.errorMessage ?? env.message ?? 'Request failed';
            return { ok: false, error: `${message}${validationHint(env.errorCodes, operation)}` };
        }
        return { ok: true, data: env.data ?? env };
    }

    return { ok: true, data };
}

// ── List all commands (for list_commands tool) ──────────────────────────────

export async function listAllCommands(): Promise<ApiResult> {
    const spec = await loadSpec();
    if (!spec) return { ok: false, error: 'Failed to fetch API spec' };

    const grouped: Record<string, Array<{ command: string; summary: string; auth: boolean }>> = {};

    for (const [path, methods] of Object.entries(spec.paths)) {
        for (const [method, op] of Object.entries(methods)) {
            if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;
            const cmd = pathToCommand(method.toUpperCase(), path);
            const domain = cmd.split(' ')[0] ?? 'other';
            (grouped[domain] ??= []).push({
                command: cmd,
                summary: (op as TOpenApiOperation).summary ?? '',
                auth: Array.isArray((op as TOpenApiOperation).security) && (op as TOpenApiOperation).security!.length > 0,
            });
        }
    }

    return { ok: true, data: grouped };
}
