// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// react-native-webview for the web build (metro.config.js swaps it in on web only): the page
// goes into a same-origin iframe, written from its HTML (srcdoc) so a small script runs
// before the page's own, exactly as on a phone:
//   - window.ReactNativeWebView.postMessage(text) reaches onMessage({ nativeEvent: { data } });
//   - injectedJavaScriptBeforeContentLoaded runs first, injectedJavaScript after the load;
//   - ref.injectJavaScript(code) runs code inside the page, ref.reload() writes it again.
// The pages read their settings from the query (?tiles=…), which a srcdoc page has not:
// the query is handed over as window.WEBVIEW_QUERY, and ?tiles as window.TILE_URL, the
// fallback the map page reads.
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

const pages = new Map();
const pageText = (url) => {
  if (!pages.has(url)) {
    pages.set(url, fetch(url).then((response) => {
      if (!response.ok) throw new Error(`WebView page ${response.status}`);
      return response.text();
    }).catch((error) => {
      pages.delete(url);
      throw error;
    }));
  }
  return pages.get(url);
};

const script = (code) => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`;

function prepare(html, uri, before) {
  const [page, query = ''] = (uri ?? '').split('?');
  const params = Object.fromEntries(new URLSearchParams(query));
  const bridge = [
    'window.ReactNativeWebView = { postMessage: function (data) {',
    '  var frame = window.frameElement; if (frame && frame.__onMessage) frame.__onMessage(String(data)); } };',
    // The page's requests go out through the app's own fetch: whatever the app's page
    // reaches (a service worker included), the iframe reaches too
    'try { if (window.parent !== window && window.parent.fetch) window.fetch = function () { return window.parent.fetch.apply(window.parent, arguments); }; } catch (e) {}',
    `window.WEBVIEW_QUERY = ${JSON.stringify(params)};`,
    params.tiles ? `window.TILE_URL = ${JSON.stringify(params.tiles)};` : '',
  ].join('\n');
  const head = `${page ? `<base href="${new URL(page, location.href).href}">` : ''}${script(bridge)}${before ? script(before) : ''}`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (tag) => `${tag}${head}`) : `${head}${html}`;
}

export const WebView = forwardRef(function WebView(props, ref) {
  const { source, style, containerStyle, injectedJavaScriptBeforeContentLoaded, injectedJavaScript } = props;
  const frame = useRef(null);
  const latest = useRef(props);
  latest.current = props;
  const [doc, setDoc] = useState(null);
  const [generation, setGeneration] = useState(0);

  useImperativeHandle(ref, () => ({
    injectJavaScript(code) {
      try {
        frame.current?.contentWindow?.eval(code);
      } catch (error) {
        console.error('WebView script:', error);
      }
    },
    reload() {
      setGeneration((value) => value + 1);
    },
    postMessage(data) {
      frame.current?.contentWindow?.postMessage(data, '*');
    },
    stopLoading() {},
    goBack() {},
    goForward() {},
  }), []);

  const uri = source?.uri;
  const html = source?.html;
  useEffect(() => {
    let alive = true;
    latest.current.onLoadStart?.({ nativeEvent: { url: uri ?? 'about:blank', loading: true } });
    (html != null ? Promise.resolve(html) : pageText(uri.split('?')[0]))
      .then((text) => {
        if (alive) setDoc({ text: prepare(text, uri, injectedJavaScriptBeforeContentLoaded), generation });
      })
      .catch((error) => {
        if (alive) latest.current.onError?.({ nativeEvent: { url: uri, code: -1, description: String(error?.message ?? error) } });
      });
    return () => {
      alive = false;
    };
    // injectedJavaScriptBeforeContentLoaded is read when the page is written, as on a phone
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri, html, generation]);

  // The messages of the page, to whoever renders this WebView now; set as the iframe is
  // attached, before its scripts can run
  const attach = (element) => {
    frame.current = element;
    if (element) element.__onMessage = (data) => latest.current.onMessage?.({ nativeEvent: { data, url: latest.current.source?.uri } });
  };

  const onLoad = () => {
    const nativeEvent = { url: uri ?? 'about:blank', loading: false, title: '' };
    if (injectedJavaScript) {
      try {
        frame.current?.contentWindow?.eval(injectedJavaScript);
      } catch (error) {
        console.error('WebView script:', error);
      }
    }
    latest.current.onLoad?.({ nativeEvent });
    latest.current.onLoadEnd?.({ nativeEvent });
  };

  return (
    <View style={[styles.container, containerStyle, style]}>
      {doc ? (
        <iframe
          key={doc.generation}
          ref={attach}
          title="page"
          srcDoc={doc.text}
          onLoad={onLoad}
          allow="autoplay; fullscreen"
          style={{ border: 0, width: '100%', height: '100%', display: 'block', background: 'transparent' }}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
});

export default WebView;
