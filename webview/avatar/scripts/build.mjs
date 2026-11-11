// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Bundles src/ (with three) into one HTML file, assets/webview/avatar.html of the
// Expo app, loaded from file:// by AvatarView like the map:  npm run build
// `--dev` writes .dev/avatar.html (unminified) for testing in a browser.
import { build, transform } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const dev = process.argv.includes('--dev');

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('src/main.js', root))],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: !dev,
  legalComments: 'none',
  write: false,
  define: { 'process.env.NODE_ENV': dev ? '"development"' : '"production"' },
  logLevel: 'warning',
});
const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = (await transform(await readFile(new URL('src/style.css', root), 'utf8'), { loader: 'css', minify: true })).code.trim();
const html = (await readFile(new URL('src/index.html', root), 'utf8'))
  .replace(/>\s+</g, '><')
  .replace('/* STYLE */', () => css)
  .replace('/* SCRIPT */', () => script);

const out = dev ? new URL('.dev/avatar.html', root) : new URL('../../assets/webview/avatar.html', root);
await mkdir(new URL('./', out), { recursive: true });
await writeFile(out, html);
console.log(`built ${out.pathname.split('/').slice(-3).join('/')} (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
