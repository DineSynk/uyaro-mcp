/**
 * Post-build: ensures dist/index.js has a shebang, then copies
 * package.json (stripped of dev fields) and README.md into dist/.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'fs';

// Ensure the shebang is present — bun build --minify may strip it
const SHEBANG = '#!/usr/bin/env node\n';
const bundlePath = 'dist/index.js';
const bundle = readFileSync(bundlePath, 'utf8');
if (!bundle.startsWith('#!')) {
    writeFileSync(bundlePath, SHEBANG + bundle);
    console.log('✓ shebang added to dist/index.js');
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// Strip dev-only fields — not needed in the published package
delete pkg.scripts;
delete pkg.devDependencies;

writeFileSync('dist/package.json', JSON.stringify(pkg, null, 2));
copyFileSync('README.md', 'dist/README.md');

console.log('✓ dist/package.json and dist/README.md ready');
