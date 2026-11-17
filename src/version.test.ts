import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const readJson = (path: string) => JSON.parse(read(path));

/** The release tag is checked against package.json; everything else has to agree with it. */
describe('version', () => {
    const version: string = readJson('package.json').version;

    test('the server reports the package.json version', () => {
        expect(read('src/index.ts')).toContain(`version: '${version}'`);
    });

    test('the plugin manifest has the same version and pins the same npm release', () => {
        const plugin = readJson('.claude-plugin/plugin.json');
        expect(plugin.version).toBe(version);
        expect(plugin.mcpServers.uyaro.args).toContain(`@uyaro/mcp@${version}`);
    });

    test('the marketplace entry has the same version', () => {
        expect(readJson('.claude-plugin/marketplace.json').plugins[0].version).toBe(version);
    });

    test('the lockfile has the same version', () => {
        const lock = readJson('package-lock.json');
        expect(lock.version).toBe(version);
        expect(lock.packages[''].version).toBe(version);
    });
});
