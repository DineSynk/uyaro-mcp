import { describe, expect, it } from 'bun:test';
import { pollForToken } from './auth.js';

// No-op sleep so tests run instantly
const noSleep = () => Promise.resolve();

function makeResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
}

describe('pollForToken', () => {
    it('returns token on first 202 success', async () => {
        const token = { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 };
        const mockFetch = async () => makeResponse(202, { data: token });

        const result = await pollForToken('dc_123', 1, 60, { fetch: mockFetch, sleep: noSleep });
        expect(result).toEqual(token);
    });

    it('continues polling on authorization_pending (errorMessage format)', async () => {
        let calls = 0;
        const token = { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 };

        const mockFetch = async () => {
            calls++;
            if (calls < 3) {
                return makeResponse(406, {
                    status: 'ERROR',
                    errorCodes: ['AUTHORIZATION_PENDING'],
                    errorMessage: 'authorization_pending',
                });
            }
            return makeResponse(202, { data: token });
        };

        const result = await pollForToken('dc_123', 0, 60, { fetch: mockFetch, sleep: noSleep });
        expect(result).toEqual(token);
        expect(calls).toBe(3);
    });

    it('continues polling on authorization_pending (error field format)', async () => {
        let calls = 0;
        const token = { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 };

        const mockFetch = async () => {
            calls++;
            if (calls < 2) return makeResponse(400, { error: 'authorization_pending' });
            return makeResponse(202, { data: token });
        };

        const result = await pollForToken('dc_123', 0, 60, { fetch: mockFetch, sleep: noSleep });
        expect(result).toEqual(token);
        expect(calls).toBe(2);
    });

    it('returns null on access_denied', async () => {
        const mockFetch = async () =>
            makeResponse(406, { status: 'ERROR', errorMessage: 'access_denied' });

        const result = await pollForToken('dc_123', 0, 60, { fetch: mockFetch, sleep: noSleep });
        expect(result).toBeNull();
    });

    it('returns null on expired_token', async () => {
        const mockFetch = async () =>
            makeResponse(406, { status: 'ERROR', errorMessage: 'expired_token' });

        const result = await pollForToken('dc_123', 0, 60, { fetch: mockFetch, sleep: noSleep });
        expect(result).toBeNull();
    });

    it('increases poll interval on slow_down', async () => {
        let calls = 0;
        const sleepDurations: number[] = [];
        const token = { access_token: 'acc', refresh_token: 'ref', expires_in: 3600 };

        const mockFetch = async () => {
            calls++;
            if (calls === 1) return makeResponse(406, { error: 'slow_down' });
            return makeResponse(202, { data: token });
        };
        const mockSleep = async (ms: number) => { sleepDurations.push(ms); };

        await pollForToken('dc_123', 1, 60, { fetch: mockFetch, sleep: mockSleep });
        // Second sleep should be interval(1s) + 5000ms extra
        expect(sleepDurations[1]).toBe(6000);
    });

    it('returns null when deadline exceeded', async () => {
        const mockFetch = async () =>
            makeResponse(406, { error: 'authorization_pending' });

        // expiresIn=0 means deadline is already passed
        const result = await pollForToken('dc_123', 0, 0, { fetch: mockFetch, sleep: noSleep });
        expect(result).toBeNull();
    });

    it('throws on unexpected error code', async () => {
        const mockFetch = async () =>
            makeResponse(400, { error: 'server_error' });

        await expect(
            pollForToken('dc_123', 0, 60, { fetch: mockFetch, sleep: noSleep }),
        ).rejects.toThrow('Token error: server_error');
    });

    it('returns null when deadline exceeded after pending polls', async () => {
        let calls = 0;
        // Always pending, deadline is 1 poll worth
        const mockFetch = async () => {
            calls++;
            return makeResponse(406, { errorMessage: 'authorization_pending' });
        };
        // expiresIn=0 — loop won't even run
        const result = await pollForToken('dc_123', 0, 0, { fetch: mockFetch, sleep: noSleep });
        expect(result).toBeNull();
        expect(calls).toBe(0);
    });
});
