import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const BASE_URL = 'https://v2.api.kioskade.com';

const CONFIG_PATH = join(homedir(), '.config', 'dinesynk', 'config.json');

export type TConfig = {
    baseUrl: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    cliVersion?: string;
};

export function readConfig(): TConfig {
    try {
        return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as TConfig;
    } catch {
        return { baseUrl: BASE_URL };
    }
}

export function writeConfig(update: Partial<TConfig>): void {
    const current = readConfig();
    const next = { ...current, ...update };
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    // The file holds login tokens: owner-only, and chmod covers files created by older versions.
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
    chmodSync(CONFIG_PATH, 0o600);
}

export function isLoggedIn(): boolean {
    const config = readConfig();
    return !!config.accessToken && !!config.expiresAt && config.expiresAt > Date.now();
}

export function getAuthHeaders(): Record<string, string> {
    const config = readConfig();
    if (!config.accessToken) return {};
    return { Authorization: `Bearer ${config.accessToken}` };
}
