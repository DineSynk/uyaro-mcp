import { BASE_URL, readConfig, writeConfig } from './config.js';

type TDeviceCodeResponse = {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
};

type TTokenResponse = {
    access_token: string;
    refresh_token: string;
    expires_in: number;
};

type TTokenError = {
    error?: string;
    errorMessage?: string;
    errorCodes?: string[];
};

export async function startDeviceFlow(): Promise<TDeviceCodeResponse> {
    const res = await fetch(`${BASE_URL}/auth/oauth/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'uyaro-mcp', scope: 'cli:write' }),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Failed to start device flow: ${res.status} ${body}`);
    }

    const body = (await res.json()) as { data: TDeviceCodeResponse };
    return body.data;
}

export async function pollForToken(
    deviceCode: string,
    interval: number,
    expiresIn: number,
    deps: { fetch: typeof globalThis.fetch; sleep: (ms: number) => Promise<void> } = {
        fetch: globalThis.fetch,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
): Promise<TTokenResponse | null> {
    const deadline = Date.now() + expiresIn * 1000;
    let pollInterval = interval * 1000;

    while (Date.now() < deadline) {
        await deps.sleep(pollInterval);

        const res = await deps.fetch(`${BASE_URL}/auth/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: 'uyaro-mcp',
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
        });

        if (!res.ok) {
            const err = (await res.json()) as TTokenError;
            const code = (err.error ?? err.errorMessage ?? err.errorCodes?.[0] ?? 'unknown').toLowerCase();
            if (code === 'slow_down') { pollInterval += 5000; continue; }
            if (code === 'authorization_pending') continue;
            if (code === 'access_denied') return null;
            if (code === 'expired_token') return null;
            throw new Error(`Token error: ${code}`);
        }

        const body = (await res.json()) as { data: TTokenResponse };
        return body.data;
    }

    return null;
}

/**
 * Access tokens last an hour. Swap the saved refresh token for a new one so people aren't sent back through
 * the browser login every hour. Returns false when the session can't be renewed (they must log in again).
 */
export async function refreshSessionIfNeeded(
    deps: { fetch: typeof globalThis.fetch } = { fetch: globalThis.fetch },
): Promise<boolean> {
    const config = readConfig();
    if (config.accessToken && config.expiresAt && config.expiresAt - Date.now() > 60_000) return true;
    if (!config.refreshToken) return false;

    try {
        const res = await deps.fetch(`${BASE_URL}/auth/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: 'uyaro-mcp', grant_type: 'refresh_token', refresh_token: config.refreshToken }),
        });
        if (!res.ok) return false;
        const { data } = (await res.json()) as { data: TTokenResponse };
        writeConfig({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiresAt: Date.now() + data.expires_in * 1000,
        });
        return true;
    } catch {
        return false;
    }
}

// Track whether a login is currently in progress
let _loginInProgress = false;
export function isLoginInProgress(): boolean { return _loginInProgress; }

/**
 * Start device flow, return URL immediately, poll in background.
 * Token is saved to config automatically when approved.
 */
export async function loginWithDeviceFlow(): Promise<{
    verificationUri: string;
    userCode: string;
    verificationUriComplete: string;
}> {
    const device = await startDeviceFlow();

    _loginInProgress = true;

    // Background polling — saves token when approved
    pollForToken(device.device_code, device.interval, device.expires_in)
        .then((token) => {
            if (token) {
                writeConfig({
                    accessToken: token.access_token,
                    refreshToken: token.refresh_token,
                    expiresAt: Date.now() + token.expires_in * 1000,
                });
                process.stderr.write(`[uyaro] login successful, token saved\n`);
            } else {
                process.stderr.write(`[uyaro] login denied or timed out\n`);
            }
        })
        .catch((err) => {
            process.stderr.write(`[uyaro] login error: ${err instanceof Error ? err.message : String(err)}\n`);
        })
        .finally(() => {
            _loginInProgress = false;
        });

    return {
        verificationUri: device.verification_uri,
        userCode: device.user_code,
        verificationUriComplete: device.verification_uri_complete,
    };
}
