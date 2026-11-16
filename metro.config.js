// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Allows require() of .html files as assets
config.resolver.assetExts.push('html');

// The WebView sub-projects have their own dependencies, and the map tiles
// (tile-provider/) and the avatar assets are served by `make dev`: Metro only uses
// the built assets/webview/*.html and avatar-server/shared/
config.resolver.blockList = [
  /webview\/.*\/node_modules\/.*/,
  /avatar-server\/(source|library|library-astc|map-avatars|data|node_modules)\/.*/,
  // Not app code either; on Linux every watched folder takes one of the few inotify watches
  /asset-pipeline\/(node_modules|tools)\/.*/,
  /backend\/\.venv\/.*/,
  // The tile project (tile-provider/: make tiles), with its downloads
  /tile-provider\/.*/,
];

const path = require('node:path');
const swaps = {};
// Showcase mode (show-case/tools/ready.sh): signed in as a demo person without Logto. Only
// when EXPO_PUBLIC_SHOWCASE=1 is set for the development server; never in a release.
if (process.env.EXPO_PUBLIC_SHOWCASE === '1') swaps['@logto/rn'] = { all: path.join(__dirname, 'src/showcase/logto.js') };
// The web build (the try-it demo of show-case/, made by show-case/tools/web/build.sh): the
// pages of the map and of the avatar run in an iframe instead of a WebView
swaps['react-native-webview'] = { web: path.join(__dirname, 'src/web/WebView.js') };

const resolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const swap = swaps[moduleName];
  const filePath = swap && (swap[platform] ?? swap.all);
  if (filePath) return { type: 'sourceFile', filePath };
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
