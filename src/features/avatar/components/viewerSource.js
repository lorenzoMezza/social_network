// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Asset } from 'expo-asset';

// The viewer page (webview/avatar, built into assets/webview/avatar.html), copied to the
// device once for the whole app. AvatarProvider starts it right after sign-in, so the
// first AvatarView does not wait for it.
let viewerSource = null;

export function loadViewer() {
  viewerSource ??= Asset.fromModule(require('../../../../assets/webview/avatar.html'))
    .downloadAsync()
    .then((asset) => ({ uri: asset.localUri }))
    .catch((error) => {
      viewerSource = null;
      throw error;
    });
  return viewerSource;
}
