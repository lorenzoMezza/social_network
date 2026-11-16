// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Downloads the Decentraland avatar assets (Apache-2.0) into source/, once:
//   npm --prefix avatar-server run fetch
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../source/', import.meta.url));
if (existsSync(target)) {
  console.log('source/ already present. Delete it to download again.');
} else {
  execFileSync('git', ['clone', '--depth', '1', 'https://github.com/decentraland/avatar-assets.git', target], { stdio: 'inherit' });
}
