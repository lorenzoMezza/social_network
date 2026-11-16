// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import masterkey.core.Json;

/**
 * Purge by URL on Cloudflare's CDN (§19): a file deleted from the storage must stop being served
 * from the cache. A token with the "Cache Purge" permission of the zone of MEDIA_URL. Errors
 * throw, so the job that deletes the files tries again.
 */
public final class CdnPurge {

    /** URLs per call: within Cloudflare's limit for every plan. */
    static final int BATCH = 30;
    static final Duration TIMEOUT = Duration.ofSeconds(10);

    private final URI endpoint;
    private final String token;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(TIMEOUT).followRedirects(HttpClient.Redirect.NEVER).build();

    public CdnPurge(String zoneId, String token) {
        this(URI.create("https://api.cloudflare.com/client/v4/zones/" + zoneId + "/purge_cache"), token);
    }

    CdnPurge(URI endpoint, String token) {
        if (!endpoint.toString().matches("https?://[^\\s]+/zones/[A-Za-z0-9]{1,64}/purge_cache")) throw new IllegalArgumentException("CDN_PURGE_ZONE");
        this.endpoint = endpoint;
        this.token = token;
    }

    public void purge(List<String> urls) {
        for (int from = 0; from < urls.size(); from += BATCH) {
            List<String> part = urls.subList(from, Math.min(urls.size(), from + BATCH));
            try {
                HttpResponse<String> answer = http.send(HttpRequest.newBuilder(endpoint).timeout(TIMEOUT)
                        .header("Authorization", "Bearer " + token).header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(Json.text(Map.of("files", part)))).build(), HttpResponse.BodyHandlers.ofString());
                if (answer.statusCode() != 200) throw new IllegalStateException("CDN purge refused: " + answer.statusCode());
            } catch (IOException error) {
                throw new UncheckedIOException(error);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException("stopping", interrupted);
            }
        }
    }

    @Override
    public String toString() {
        return "CdnPurge[" + endpoint + "]";
    }
}
