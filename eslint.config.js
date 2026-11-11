// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "build/**", "webview/**", "avatar-server/source/**", "avatar-server/library/**", "avatar-server/data/**", "tile-provider/**"],
  }
]);
