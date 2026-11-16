// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The web build's stand-in for fileSystem.js (the try-it demo of show-case/): the caches
// live in this tab's memory, downloaded files as blob URLs. Nothing outlasts the tab, which
// for a demo is the point: the caches only make a phone work offline.
const texts = new Map();
const files = new Map();

const forget = (path) => {
  const url = files.get(path);
  if (url) URL.revokeObjectURL(url);
  files.delete(path);
  texts.delete(path);
};

export const fileSystem = {
  async readText(path) {
    return texts.get(path) ?? null;
  },

  async writeText(path, text) {
    texts.set(path, text);
  },

  async remove(path) {
    forget(path);
  },

  async removeDir(path) {
    const prefix = `${path.replace(/\/$/, '')}/`;
    for (const key of [...texts.keys(), ...files.keys()]) if (key.startsWith(prefix)) forget(key);
  },

  async download(url, path) {
    const response = await fetch(url);
    if (!response.ok) throw Object.assign(new Error(`Download failed: ${response.status}`), { status: response.status });
    const blob = await response.blob();
    forget(path);
    files.set(path, URL.createObjectURL(blob));
    return blob.size;
  },

  uri: (path) => files.get(path) ?? null,
};
