// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// app.json, plus what a build for trying the app on your own phones needs: the
// development servers on this computer, reached over HTTP on the local network.
// Remote endpoints must use HTTPS; only local HTTP endpoints enable cleartext traffic.
module.exports = ({ config }) => {
  // The web build of the try-it demo (show-case/tools/web/build.mjs) lives in a folder of
  // the showcase site, not at the root of its domain
  if (process.env.EXPO_WEB_BASE_URL) {
    config = { ...config, experiments: { ...config.experiments, baseUrl: process.env.EXPO_WEB_BASE_URL } };
  }
  const isLocalHost = (hostname) => {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const localIpv6 = host === '::1' || /^fe[89ab][0-9a-f]:/.test(host) || /^(fc|fd)/.test(host);
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (host.includes(':') && localIpv6)) return true;
    const octets = host.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
    const [first, second] = octets;
    return first === 10
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168);
  };
  const endpoints = [
    process.env.EXPO_PUBLIC_API_URL,
    process.env.EXPO_PUBLIC_AVATAR_URL,
    process.env.EXPO_PUBLIC_TILE_URL,
  ].filter(Boolean).map((value) => new URL(value));
  const credentialed = endpoints.find((url) => url.username || url.password);
  if (credentialed) throw new Error(`Endpoint URLs must not contain credentials: ${credentialed.origin}`);
  const unsupported = endpoints.find((url) => url.protocol !== 'http:' && url.protocol !== 'https:');
  if (unsupported) throw new Error(`Unsupported endpoint protocol: ${unsupported.protocol}`);
  const insecureRemote = endpoints.find((url) => url.protocol === 'http:' && !isLocalHost(url.hostname));
  if (insecureRemote) {
    throw new Error(`Use HTTPS for non-local endpoint ${insecureRemote.origin}`);
  }

  // Local development servers use HTTP on the same Wi-Fi. Keep ATS scoped to local
  // networking, and only enable Android cleartext for development or local endpoints.
  const localHttp = process.env.NODE_ENV === 'development'
    || endpoints.some((url) => url.protocol === 'http:' && isLocalHost(url.hostname));
  if (!localHttp) return config;
  const plugins = config.plugins.map((plugin) => (Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
    ? ['expo-build-properties', { ...plugin[1], android: { ...plugin[1].android, usesCleartextTraffic: true } }]
    : plugin));
  return {
    ...config,
    plugins,
    ios: {
      ...config.ios,
      infoPlist: {
        ...config.ios?.infoPlist,
        NSAppTransportSecurity: {
          ...config.ios?.infoPlist?.NSAppTransportSecurity,
          NSAllowsLocalNetworking: true,
        },
      },
    },
  };
};
