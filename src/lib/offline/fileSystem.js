// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Directory, File, Paths } from 'expo-file-system';

// The phone's storage for diskCache.js, in the app's caches folder: not backed up
// to the cloud (it can all be downloaded again), and the system may empty it when the
// phone is nearly full, which the caches take as misses. Paths are relative to it.

const ROOT = 'offline';
const at = (path) => new File(Paths.cache, ROOT, path);
let temporary = 0;

const ensureParent = (file) => {
  const parent = file.parentDirectory;
  if (!parent.exists) parent.create({ intermediates: true, idempotent: true });
};

export const fileSystem = {
  async readText(path) {
    const file = at(path);
    return file.exists ? file.text() : null;
  },

  // Written aside, then moved over the old copy: never half a file
  async writeText(path, text) {
    const file = at(path);
    ensureParent(file);
    const aside = at(`${path}.${Date.now().toString(36)}${(temporary++).toString(36)}.tmp`);
    await aside.write(text);
    aside.moveSync(file, { overwrite: true });
  },

  async remove(path) {
    const file = at(path);
    if (file.exists) file.delete();
  },

  async removeDir(path) {
    const directory = new Directory(Paths.cache, ROOT, path);
    if (directory.exists) directory.delete();
  },

  // The file at `url` downloaded to `path`: its size in bytes (throws when the server
  // did not answer it, status included)
  async download(url, path) {
    const file = at(path);
    ensureParent(file);
    const downloaded = await File.downloadFileAsync(url, file, { idempotent: true });
    return downloaded.size ?? file.size ?? 0;
  },

  uri: (path) => at(path).uri,
};
