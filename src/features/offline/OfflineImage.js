// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useState } from 'react';
import { Image } from 'expo-image';
import { useOfflineCaches } from './useOfflineCaches';

const isRemote = (url) => typeof url === 'string' && /^https?:/i.test(url);

// The address to show for the picture at `url`: its copy on the phone (downloaded the
// first time into the account's `kind` cache, lib/offline, with that priority), the
// address itself when it cannot be kept (no account, a file just picked, the download
// failed: the image loader may still have it), or null while it is being fetched.
// Pictures never change at an address (a new one gets a new address), so a copy is
// never out of date.
function useOfflineImage(url, { kind = 'people', priority } = {}) {
  const cache = useOfflineCaches()?.[kind] ?? null;
  const [found, setFound] = useState({ url: null, uri: null });
  useEffect(() => {
    if (!cache || !isRemote(url)) return undefined;
    let alive = true;
    cache.ready
      .then(() => cache.download(url, { priority }))
      .then((uri) => {
        if (alive) setFound({ url, uri: uri ?? url });
      });
    return () => {
      alive = false;
    };
  }, [cache, url, priority]);
  if (!url) return null;
  if (!cache || !isRemote(url)) return url;
  return found.url === url ? found.uri : cache.fileUri(url);
}

// expo-image's Image for a picture kept on the phone (useOfflineImage); `placeholder`
// shows while it is fetched
export function OfflineImage({ url, kind = 'people', priority, placeholder = null, onError, ...props }) {
  const uri = useOfflineImage(url, { kind, priority });
  const cache = useOfflineCaches()?.[kind] ?? null;
  // A copy the system deleted meanwhile (it may empty the caches folder when the phone
  // is nearly full): forgotten, so it is downloaded again next time, and the picture
  // comes from its address for now
  const [broken, setBroken] = useState(null);
  const local = !!uri && !isRemote(uri);
  const shown = local && broken === uri ? url : uri;
  if (!shown) return placeholder;
  return (
    <Image
      {...props}
      source={{ uri: shown }}
      // The phone's copy needs no second copy in the loader's own disk cache
      cachePolicy={isRemote(shown) ? 'memory-disk' : 'memory'}
      onError={(event) => {
        if (local && broken !== uri) {
          setBroken(uri);
          cache?.remove(url);
        }
        onError?.(event);
      }}
    />
  );
}
