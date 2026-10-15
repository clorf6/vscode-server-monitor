import * as esbuild from 'esbuild';
import * as fs from 'fs';

const watch = process.argv.includes('--watch');
const dev = process.argv.includes('--dev');

const common = { bundle: true, minify: !dev, sourcemap: dev ? 'inline' : false, logLevel: 'info' };

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] },
  { ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2020' },
  { ...common, entryPoints: ['webview/overview.ts'], outfile: 'dist/overview.js', platform: 'browser', format: 'iife', target: 'es2020' },
  // Node-only entry points used for tests and the smoke/overhead script (never shipped).
  { ...common, minify: false, entryPoints: ['test/parsers.test.ts'], outfile: 'out/parsers.test.js', platform: 'node', format: 'cjs', target: 'node18' },
  { ...common, minify: false, entryPoints: ['test/scheduler.test.ts'], outfile: 'out/scheduler.test.js', platform: 'node', format: 'cjs', target: 'node18' },
  { ...common, minify: false, entryPoints: ['scripts/smoke.ts'], outfile: 'out/smoke.js', platform: 'node', format: 'cjs', target: 'node18' },
];

const existing = builds.filter((b) => fs.existsSync(b.entryPoints[0]));

if (watch) {
  for (const b of existing) (await esbuild.context(b)).watch();
} else {
  await Promise.all(existing.map((b) => esbuild.build(b)));
}
