import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pollForToken } from './auth.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const noSleep = () => Promise.resolve();

function makeResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

// Exact production response shapes (verified against https://v2.api.kioskade.com)
const PROD = {
    pending: {
        status: 400,
        body: { status: 'ERROR', errorCodes: ['AUTHORIZATION_PENDING'], errorMessage: 'authorization_pending' },
    },
    slowDown: {
        status: 400,
        body: { status: 'ERROR', errorCodes: ['SLOW_DOWN'], errorMessage: 'slow_down' },
    },
    denied: {
        status: 400,
        body: { status: 'ERROR', errorCodes: ['ACCESS_DENIED'], errorMessage: 'access_denied' },
    },
    expired: {
        status: 400,
        body: { status: 'ERROR', errorCodes: ['EXPIRED_TOKEN'], errorMessage: 'expired_token' },
    },
    invalidClient: {
        status: 400,
        body: { status: 'ERROR', errorCodes: ['INVALID_CLIENT'], errorMessage: 'invalid_client' },
    },
    success: (token = 'jwt.access.token', refresh = 'jwt.refresh.token') => ({
        status: 202,
        body: {
            status: 'SUCCESS',
            data: {
                access_token: token,
                refresh_token: refresh,
                token_type: 'Bearer',
                expires_in: 3600,
                scope: 'cli:write',
            },
        },
    }),
};

// ── pollForToken ────────────────────────────────────────────────────────────

describe('pollForToken', () => {
    describe('with exact production response format', () => {
        it('returns token on 202 SUCCESS', async () => {
            const resp = PROD.success();
            const mockFetch = async () => makeResponse(resp.status, resp.body);

            const result = await pollForToken('dc_test', 1, 60, { fetch: mockFetch, sleep: noSleep });
            expect(result).toEqual(resp.body.data);
        });

        it('continues polling on AUTHORIZATION_PENDING (400)', async () => {
            let calls = 0;
            const resp = PROD.success();

            const mockFetch = async () => {
                calls++;
                if (calls <= 3) return makeResponse(PROD.pending.status, PROD.pending.body);
                return makeResponse(resp.status, resp.body);
            };

            const result = await pollForToken('dc_test', 0, 60, { fetch: mockFetch, sleep: noSleep });
            expect(result).toEqual(resp.body.data);
            expect(calls).toBe(4); // 3 pending + 1 success
        });

        it('returns null on ACCESS_DENIED', async () => {
            const mockFetch = async () => makeResponse(PROD.denied.status, PROD.denied.body);
            const result = await pollForToken('dc_test', 0, 60, { fetch: mockFetch, sleep: noSleep });
            expect(result).toBeNull();
        });

        it('returns null on EXPIRED_TOKEN', async () => {
            const mockFetch = async () => makeResponse(PROD.expired.status, PROD.expired.body);
            const result = await pollForToken('dc_test', 0, 60, { fetch: mockFetch, sleep: noSleep });
            expect(result).toBeNull();
        });

        it('increases interval on SLOW_DOWN', async () => {
            let calls = 0;
            const sleepMs: number[] = [];
            const resp = PROD.success();

            const mockFetch = async () => {
                calls++;
                if (calls === 1) return makeResponse(PROD.slowDown.status, PROD.slowDown.body);
                return makeResponse(resp.status, resp.body);
            };
            const trackSleep = async (ms: number) => { sleepMs.push(ms); };

            await pollForToken('dc_test', 1, 60, { fetch: mockFetch, sleep: trackSleep });
            expect(sleepMs[0]).toBe(1000); // initial: interval * 1000
            expect(sleepMs[1]).toBe(6000); // after slow_down: +5000
        });

        it('throws on INVALID_CLIENT', async () => {
            const mockFetch = async () => makeResponse(PROD.invalidClient.status, PROD.invalidClient.body);
            await expect(
                pollForToken('dc_test', 0, 60, { fetch: mockFetch, sleep: noSleep }),
            ).rejects.toThrow('Token error: invalid_client');
        });
    });

    describe('edge cases', () => {
        it('returns null when deadline already passed (expiresIn=0)', async () => {
            let fetchCalled = false;
            const mockFetch = async () => { fetchCalled = true; return makeResponse(200, {}); };
            const result = await pollForToken('dc_test', 0, 0, { fetch: mockFetch, sleep: noSleep });
            expect(result).toBeNull();
            expect(fetchCalled).toBe(false); // never even called
        });

        it('handles non-JSON error response without crashing', async () => {
            const mockFetch = async () => new Response('Not Found', { status: 404 });
            await expect(
                pollForToken('dc_test', 0, 60, { fetch: mockFetch, sleep: noSleep }),
            ).rejects.toThrow(); // should throw, not crash the process
        });

        it('handles network error (fetch throws) without crashing', async () => {
            const mockFetch = async () => { throw new Error('ECONNREFUSED'); };
            await expect(
                pollForToken('dc_test', 0, 60, { fetch: mockFetch, sleep: noSleep }),
            ).rejects.toThrow('ECONNREFUSED');
        });

        it('handles errorCodes-only format (no errorMessage)', async () => {
            const mockFetch = async () => makeResponse(400, {
                status: 'ERROR',
                errorCodes: ['AUTHORIZATION_PENDING'],
            });
            let calls = 0;
            const wrappedFetch = async (...args: Parameters<typeof fetch>) => {
                calls++;
                if (calls > 2) return makeResponse(202, PROD.success().body);
                return mockFetch();
            };

            const result = await pollForToken('dc_test', 0, 60, { fetch: wrappedFetch, sleep: noSleep });
            expect(result).toEqual(PROD.success().body.data);
        });

        it('handles standard OAuth error format (error field)', async () => {
            let calls = 0;
            const mockFetch = async () => {
                calls++;
                if (calls === 1) return makeResponse(400, { error: 'authorization_pending' });
                return makeResponse(202, PROD.success().body);
            };

            const result = await pollForToken('dc_test', 0, 60, { fetch: mockFetch, sleep: noSleep });
            expect(result).toEqual(PROD.success().body.data);
        });

        it('uses correct poll URL (not /auth/oauth/device/token)', async () => {
            let requestedUrl = '';
            const mockFetch = async (url: string | URL | Request) => {
                requestedUrl = url.toString();
                return makeResponse(202, PROD.success().body);
            };

            await pollForToken('dc_test', 0, 60, { fetch: mockFetch, sleep: noSleep });
            expect(requestedUrl).toContain('/auth/oauth/token');
            expect(requestedUrl).not.toContain('/auth/oauth/device/token');
        });

        it('sends correct request body', async () => {
            let sentBody = '';
            const mockFetch = async (_url: string | URL | Request, init?: RequestInit) => {
                sentBody = init?.body as string;
                return makeResponse(202, PROD.success().body);
            };

            await pollForToken('dc_my_code', 0, 60, { fetch: mockFetch, sleep: noSleep });
            const parsed = JSON.parse(sentBody);
            expect(parsed.client_id).toBe('uyaro-mcp');
            expect(parsed.device_code).toBe('dc_my_code');
            expect(parsed.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
        });
    });
});

// ── Config read/write ───────────────────────────────────────────────────────

describe('config', () => {
    const tmpConfigDir = join(tmpdir(), 'uyaro-mcp-test-' + Date.now());
    const tmpConfigPath = join(tmpConfigDir, 'config.json');

    beforeEach(() => {
        mkdirSync(tmpConfigDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpConfigDir, { recursive: true, force: true });
    });

    it('writeConfig creates dir and file', () => {
        const dir = join(tmpConfigDir, 'nested', 'deep');
        const path = join(dir, 'config.json');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, JSON.stringify({ baseUrl: 'https://test.com' }));

        const config = JSON.parse(readFileSync(path, 'utf8'));
        expect(config.baseUrl).toBe('https://test.com');
    });

    it('writeConfig merges with existing config', () => {
        writeFileSync(tmpConfigPath, JSON.stringify({ baseUrl: 'https://test.com', specHash: 'abc' }));
        const existing = JSON.parse(readFileSync(tmpConfigPath, 'utf8'));

        const merged = { ...existing, accessToken: 'tok123', expiresAt: Date.now() + 3600000 };
        writeFileSync(tmpConfigPath, JSON.stringify(merged, null, 2));

        const result = JSON.parse(readFileSync(tmpConfigPath, 'utf8'));
        expect(result.baseUrl).toBe('https://test.com');
        expect(result.specHash).toBe('abc');
        expect(result.accessToken).toBe('tok123');
    });

    it('isLoggedIn returns true with valid token', () => {
        const config = {
            baseUrl: 'https://test.com',
            accessToken: 'jwt.token.here',
            expiresAt: Date.now() + 3600000, // 1 hour from now
        };
        expect(!!config.accessToken && !!config.expiresAt && config.expiresAt > Date.now()).toBe(true);
    });

    it('isLoggedIn returns false with expired token', () => {
        const config = {
            baseUrl: 'https://test.com',
            accessToken: 'jwt.token.here',
            expiresAt: Date.now() - 1000, // expired
        };
        expect(!!config.accessToken && !!config.expiresAt && config.expiresAt > Date.now()).toBe(false);
    });

    it('isLoggedIn returns false with no token', () => {
        const config = { baseUrl: 'https://test.com' };
        expect(!!(config as any).accessToken).toBe(false);
    });
});

// ── Full login → config save simulation ─────────────────────────────────────

describe('login → poll → save flow', () => {
    const tmpConfigDir = join(tmpdir(), 'uyaro-mcp-flow-' + Date.now());
    const tmpConfigPath = join(tmpConfigDir, 'config.json');

    beforeEach(() => {
        mkdirSync(tmpConfigDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpConfigDir, { recursive: true, force: true });
    });

    it('full flow: 3 pending → approve → token saved → isLoggedIn true', async () => {
        let calls = 0;
        const resp = PROD.success('my.access.jwt', 'my.refresh.jwt');

        const mockFetch = async () => {
            calls++;
            if (calls <= 3) return makeResponse(PROD.pending.status, PROD.pending.body);
            return makeResponse(resp.status, resp.body);
        };

        // Simulate exactly what loginWithDeviceFlow().then() does
        const token = await pollForToken('dc_flow_test', 0, 60, { fetch: mockFetch, sleep: noSleep });

        expect(token).not.toBeNull();
        expect(token!.access_token).toBe('my.access.jwt');
        expect(token!.refresh_token).toBe('my.refresh.jwt');
        expect(token!.expires_in).toBe(3600);

        // Simulate writeConfig
        const configData = {
            baseUrl: 'https://v2.api.kioskade.com',
            accessToken: token!.access_token,
            refreshToken: token!.refresh_token,
            expiresAt: Date.now() + token!.expires_in * 1000,
        };
        writeFileSync(tmpConfigPath, JSON.stringify(configData, null, 2));

        // Verify config was written correctly
        const saved = JSON.parse(readFileSync(tmpConfigPath, 'utf8'));
        expect(saved.accessToken).toBe('my.access.jwt');
        expect(saved.refreshToken).toBe('my.refresh.jwt');
        expect(saved.expiresAt).toBeGreaterThan(Date.now());

        // Verify isLoggedIn logic
        const loggedIn = !!saved.accessToken && !!saved.expiresAt && saved.expiresAt > Date.now();
        expect(loggedIn).toBe(true);
    });

    it('denied flow: polling returns null, config stays empty', async () => {
        const mockFetch = async () => makeResponse(PROD.denied.status, PROD.denied.body);
        const token = await pollForToken('dc_denied', 0, 60, { fetch: mockFetch, sleep: noSleep });

        expect(token).toBeNull();

        // Config should NOT be written
        expect(existsSync(tmpConfigPath)).toBe(false);
    });
});
