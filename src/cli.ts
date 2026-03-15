import { chmodSync, existsSync } from 'fs';
import { writeFile } from 'fs/promises';
import { arch, platform } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { GITHUB_REPO, getBinaryDir, readConfig, writeConfig } from './config.js';

const BINARY_NAME = 'dinesynk-cli';

type TRelease = {
    tag_name: string;
    assets: Array<{ name: string; browser_download_url: string }>;
};

function getPlatformAsset(): string {
    const os = platform();
    const cpu = arch();

    if (os === 'darwin' && cpu === 'arm64') return 'dinesynk-cli-macos-arm64';
    if (os === 'darwin') return 'dinesynk-cli-macos-x64';
    if (os === 'linux' && cpu === 'arm64') return 'dinesynk-cli-linux-arm64';
    if (os === 'linux') return 'dinesynk-cli-linux-x64';
    if (os === 'win32') return 'dinesynk-cli-windows-x64.exe';

    throw new Error(`Unsupported platform: ${os}/${cpu}`);
}

export function getBinaryPath(): string {
    const ext = platform() === 'win32' ? '.exe' : '';
    return join(getBinaryDir(), `${BINARY_NAME}${ext}`);
}

export function isBinaryInstalled(): boolean {
    return existsSync(getBinaryPath());
}

async function fetchLatestRelease(): Promise<TRelease> {
    const res = await fetch(
        `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`,
        { headers: { 'User-Agent': '@uyaro/mcp' } },
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.statusText}`);
    return res.json() as Promise<TRelease>;
}

async function downloadBinary(release: TRelease): Promise<void> {
    const assetName = getPlatformAsset();
    const asset = release.assets.find((a) => a.name === assetName);

    if (!asset) {
        throw new Error(
            `No binary for this platform (${assetName}). ` +
                `Available: ${release.assets.map((a) => a.name).join(', ')}`,
        );
    }

    const binRes = await fetch(asset.browser_download_url);
    if (!binRes.ok) throw new Error(`Download failed: ${binRes.statusText}`);

    const binaryPath = getBinaryPath();
    await writeFile(binaryPath, Buffer.from(await binRes.arrayBuffer()));

    if (platform() !== 'win32') chmodSync(binaryPath, 0o755);

    writeConfig({ cliVersion: release.tag_name });
    process.stderr.write(`[uyaro] CLI updated to ${release.tag_name}\n`);
}

// Install from scratch (no binary yet)
export async function installBinary(): Promise<void> {
    const release = await fetchLatestRelease();
    await downloadBinary(release);
}

// Check GitHub for a newer release — download silently if found
export async function checkForUpdate(): Promise<void> {
    try {
        const config = readConfig();
        const release = await fetchLatestRelease();

        if (release.tag_name !== config.cliVersion) {
            process.stderr.write(
                `[uyaro] New CLI version ${release.tag_name} (current: ${config.cliVersion ?? 'none'}). Updating...\n`,
            );
            await downloadBinary(release);
        }
    } catch (err) {
        // Silent — update failures must not break the MCP server
        process.stderr.write(
            `[uyaro] CLI update check failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
    }
}

// Ensure binary is present (install if missing, then check for updates)
export async function ensureBinary(): Promise<string> {
    if (!isBinaryInstalled()) {
        await installBinary();
    }
    return getBinaryPath();
}

export type TCliResult = { stdout: string; stderr: string; ok: boolean };

export async function runCli(args: string[]): Promise<TCliResult> {
    const binaryPath = await ensureBinary();

    return new Promise((resolve) => {
        const proc = spawn(binaryPath, [...args, '--json'], {
            env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
        proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

        proc.on('close', (code) => {
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), ok: code === 0 });
        });
    });
}
