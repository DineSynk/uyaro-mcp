import { BASE_URL, writeConfig } from './config.js';

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
    error: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | string;
};

export async function startDeviceFlow(): Promise<TDeviceCodeResponse> {
    const res = await fetch(`${BASE_URL}/auth/oauth/device/code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: 'uyaro-mcp', scope: 'cli:write' }),
    });

    if (!res.ok) {
        throw new Error(`Failed to start device flow: ${res.statusText}`);
    }

    const body = (await res.json()) as { data: TDeviceCodeResponse };
    return body.data;
}

export async function pollForToken(
    deviceCode: string,
    interval: number,
    expiresIn: number,
): Promise<TTokenResponse | null> {
    const deadline = Date.now() + expiresIn * 1000;
    let pollInterval = interval * 1000;

    while (Date.now() < deadline) {
        await sleep(pollInterval);

        const res = await fetch(`${BASE_URL}/auth/oauth/device/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: 'uyaro-mcp',
                device_code: deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
        });

        if (res.status === 428) {
            // authorization_pending — keep polling
            continue;
        }

        if (!res.ok) {
            const err = (await res.json()) as TTokenError;
            if (err.error === 'slow_down') {
                pollInterval += 5000;
                continue;
            }
            if (err.error === 'access_denied') return null;
            if (err.error === 'expired_token') return null;
            throw new Error(`Token error: ${err.error}`);
        }

        const body = (await res.json()) as { data: TTokenResponse };
        return body.data;
    }

    return null; // timed out
}

export async function loginWithDeviceFlow(): Promise<{
    verificationUri: string;
    userCode: string;
    verificationUriComplete: string;
}> {
    const device = await startDeviceFlow();

    // Start background polling — save token when ready
    pollForToken(device.device_code, device.interval, device.expires_in)
        .then((token) => {
            if (token) {
                writeConfig({
                    accessToken: token.access_token,
                    refreshToken: token.refresh_token,
                    expiresAt: Date.now() + token.expires_in * 1000,
                });
            }
        })
        .catch((err) => {
            process.stderr.write(`[uyaro] login polling error: ${err instanceof Error ? err.message : String(err)}\n`);
        });

    return {
        verificationUri: device.verification_uri,
        userCode: device.user_code,
        verificationUriComplete: device.verification_uri_complete,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
