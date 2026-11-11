// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// expo-file-system: a File with a size, enough for the upload code
export class File {
  constructor(uri) {
    this.uri = uri;
    this.size = globalThis.__fileSizes?.[uri] ?? 1234;
  }

  delete() {
    globalThis.__deleted = [...(globalThis.__deleted ?? []), this.uri];
  }
}
export const Paths = { document: 'file:///documents', cache: 'file:///cache' };
// A folder (the offline caches': nothing is written in the tests that use this stub)
export class Directory {
  constructor(...parts) {
    this.uri = parts.join('/');
    this.exists = false;
  }

  delete() {}
}
