import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export const BASE_URL = 'https://v2.api.kioskade.com';
export const GITHUB_REPO = 'DineSynk/uyaro-mcp';

// Shared config — same file the CLI uses + MCP-specific fields
const CONFIG_PATH = join(homedir(), '.config', 'dinesynk', 'config.json');

export type TConfig = {
    baseUrl: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    specHash?: string;
    cliVersion?: string; // installed CLI binary tag, e.g. "v0.2.0"
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
    writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
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

export function getBinaryDir(): string {
    const dir = join(homedir(), '.local', 'share', 'uyaro');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}
