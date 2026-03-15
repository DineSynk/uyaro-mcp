/**
 * Copies package.json (stripped of dev fields) and README.md into dist/
 * so `npm publish dist/` produces a clean package with index.js at the root.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

// Strip dev-only fields — not needed in the published package
delete pkg.scripts;
delete pkg.devDependencies;

writeFileSync('dist/package.json', JSON.stringify(pkg, null, 2));
copyFileSync('README.md', 'dist/README.md');

console.log('✓ dist/package.json and dist/README.md ready');
