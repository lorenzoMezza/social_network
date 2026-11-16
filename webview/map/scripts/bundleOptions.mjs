// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// esbuild options shared by the release build (build.mjs) and the browser dev server
// (dev.mjs): src/main.js with three from node_modules, our copy of three-geo-play
// from ../three-geo-play/src (its tile geometry worker inlined as a string) and the
// cloud noise baked as bytes.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const root = new URL('../', import.meta.url);
const libRoot = new URL('../three-geo-play/', root);

// The target (es2021, for Closure) has no #private class members: esbuild emulates
// them with a WeakMap per field, and every object created pays a WeakMap insertion
// per field. In the tile decoder (one VectorTileFeature per feature, thousands per
// tile) that was about a third of the decoding time at startup. In three-geo-play,
// where privacy is only a convention, they become ordinary `__name` properties.
const PRIVATE_NAME = /#(?=[A-Za-z_$])/g;
const publicPrivateMembers = {
  name: 'three-geo-play-public-private-members',
  setup(b) {
    b.onLoad({ filter: /[\\/]three-geo-play[\\/]src[\\/].*\.js$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      // A '#' inside a string would be renamed too: refuse rather than corrupt it
      if (/['"`]#/.test(source)) throw new Error(`'#' in a string literal: ${args.path}`);
      return { contents: source.replace(PRIVATE_NAME, '__'), loader: 'js' };
    });
  },
};

// Cloud noise (src/scene/clouds/cloudNoiseData.js), computed here once instead of
// on the phone at every start: `import { volume, weather } from 'baked:cloud-noise'`
const bakedCloudNoise = {
  name: 'baked-cloud-noise',
  setup(b) {
    b.onResolve({ filter: /^baked:cloud-noise$/ }, (args) => ({ path: args.path, namespace: 'baked' }));
    b.onLoad({ filter: /.*/, namespace: 'baked' }, async () => {
      const generators = new URL('src/scene/clouds/cloudNoiseData.js', root);
      const { cloudVolumeData, cloudWeatherData } = await import(`${generators.href}?${Date.now()}`);
      const base64 = (bytes) => JSON.stringify(Buffer.from(bytes).toString('base64'));
      return {
        contents: `export const volume = ${base64(cloudVolumeData())};\nexport const weather = ${base64(cloudWeatherData())};`,
        loader: 'js',
        // The dev server rebuilds when the generators change
        watchFiles: [fileURLToPath(generators)],
      };
    });
  },
};

// three-geo-play from source. Its tile geometry worker is bundled on its own and
// inlined as a string (started from a Blob URL), as in the library's own build.
async function buildWorker() {
  const worker = await build({
    entryPoints: [fileURLToPath(new URL('src/map/tileGeometryWorker.js', libRoot))],
    bundle: true,
    format: 'iife',
    target: 'es2021',
    minify: true,
    legalComments: 'none',
    write: false,
    plugins: [publicPrivateMembers],
    logLevel: 'warning',
  });
  return worker.outputFiles[0].text;
}

function threeGeoPlayPlugin(workerCode) {
  return {
    name: 'three-geo-play-source',
    setup(b) {
      b.onResolve({ filter: /^lm-three-geo-play$/ }, () => ({ path: fileURLToPath(new URL('src/index.js', libRoot)) }));
      // One copy of three: always the one of this project, also for the library sources.
      b.onResolve({ filter: /^three($|\/)/ }, (args) =>
        args.pluginData === 'project-three'
          ? undefined
          : b.resolve(args.path, { kind: args.kind, resolveDir: fileURLToPath(root), pluginData: 'project-three' }),
      );
      b.onResolve({ filter: /[\\/]geometryWorker\.js$/ }, () => ({
        path: fileURLToPath(new URL('scripts/inlineGeometryWorker.js', libRoot)),
      }));
      b.onResolve({ filter: /^inline:tileGeometryWorker$/ }, (args) => ({ path: args.path, namespace: 'inline' }));
      b.onLoad({ filter: /.*/, namespace: 'inline' }, () => ({ contents: workerCode, loader: 'text' }));
    },
  };
}

export async function bundleOptions() {
  return {
    entryPoints: [fileURLToPath(new URL('src/main.js', root))],
    bundle: true,
    format: 'iife',
    target: 'es2021', // Closure does not support private fields (#x): esbuild lowers them
    platform: 'browser',
    legalComments: 'none',
    plugins: [threeGeoPlayPlugin(await buildWorker()), publicPrivateMembers, bakedCloudNoise],
    logLevel: 'warning',
  };
}
