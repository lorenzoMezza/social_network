// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Bundles src/ (with three from node_modules and our copy of three-geo-play from
// ../three-geo-play/src) into a single HTML file, assets/webview/map.html of the
// Expo app: the WebView loads it from file://, where separate module files are not
// reliable, and Expo ships it as one asset.
//
//   1. esbuild          bundle + tree shaking (the tile geometry worker is inlined)
//   2. Closure Compiler optimization (SIMPLE: inlining, constants, dead code)
//   3. esbuild          minification
//   4. CSS + JS inlined in the template
import { build, transform } from 'esbuild';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { bundleOptions, root } from './bundleOptions.mjs';

const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`;

// 1. Bundle
const bundle = await build({
  ...(await bundleOptions()),
  treeShaking: true,
  drop: ['debugger'],
  pure: ['console.log', 'console.info', 'console.debug'], // removed from the final code
  define: { 'process.env.NODE_ENV': '"production"' },
  write: false,
});

// 2. Optimization. ADVANCED renames properties and breaks lm-three-geo-play.
const dir = await mkdtemp(path.join(tmpdir(), 'map-webview-'));
const input = path.join(dir, 'bundle.js');
const output = path.join(dir, 'optimized.js');
await writeFile(input, bundle.outputFiles[0].text);
await promisify(execFile)(fileURLToPath(new URL('node_modules/.bin/google-closure-compiler', root)), [
  `--js=${input}`,
  `--js_output_file=${output}`,
  '--compilation_level=SIMPLE',
  '--language_in=ECMASCRIPT_NEXT',
  '--language_out=ECMASCRIPT_2021',
  '--warning_level=QUIET',
], { maxBuffer: 1 << 28 });
const optimized = await readFile(output, 'utf8');
await rm(dir, { recursive: true, force: true });

// 3. Minification
const minified = (await transform(optimized, { minify: true, target: 'es2021', legalComments: 'none' })).code;

// "</script" inside the bundle would close the inline <script> tag.
const script = minified.replace(/<\/script/gi, '<\\/script');

// Minified CSS
const css = await readFile(new URL('src/style.css', root), 'utf8');
const style = (await transform(css, { loader: 'css', minify: true })).code.trim();

// 4. HTML: template without whitespace between tags, with CSS and JS inlined
const template = await readFile(new URL('src/index.html', root), 'utf8');
const html = template
  .replace(/>\s+</g, '><')
  .replace('/* STYLE */', () => style)
  .replace('/* SCRIPT */', () => script);

const out = new URL('../../assets/webview/map.html', root);
await writeFile(out, html);
console.log(`built assets/webview/map.html (${kb(html)})`);
