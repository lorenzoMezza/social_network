// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api;

import jakarta.servlet.http.HttpServletRequest;
import org.jspecify.annotations.Nullable;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * Public addresses in answers ({@code views.Urls}). In production both are configured and
 * HTTPS (PUBLIC_URL, MEDIA_URL: the CDN of the files); in development, unset, they come from
 * the request, so a phone on the LAN gets the computer's address.
 */
public final class Urls {

    private final @Nullable String api;
    private final @Nullable String media;

    public Urls(@Nullable String publicUrl, @Nullable String mediaUrl) {
        this.api = trim(publicUrl);
        this.media = trim(mediaUrl);
    }

    /** The address of a stored file ({@code picture_key}, a photo's key), or null. */
    public @Nullable String media(@Nullable String key) {
        if (key == null || key.isEmpty()) return null;
        if (media != null) return media + "/" + key;
        return api() + "/v1/media/" + key;
    }

    /**
     * The API itself: PUBLIC_URL, else scheme and host of the request being answered, else
     * (outside a request: a frame of the presence) the last one seen. Development only.
     */
    public String api() {
        if (api != null) return api;
        RequestAttributes attributes = RequestContextHolder.getRequestAttributes();
        if (attributes instanceof ServletRequestAttributes servlet) {
            HttpServletRequest request = servlet.getRequest();
            String host = request.getHeader("Host");
            if (host != null && HOST.matcher(host).matches()) {
                String seen = request.getScheme() + "://" + host;
                learned = seen;
                return seen;
            }
        }
        return learned;
    }

    private static final java.util.regex.Pattern HOST = java.util.regex.Pattern.compile("[A-Za-z0-9.\\-:\\[\\]]{1,255}");
    private volatile String learned = "";

    private static @Nullable String trim(@Nullable String url) {
        if (url == null || url.isBlank()) return null;
        String value = url.strip();
        return value.endsWith("/") ? value.substring(0, value.length() - 1) : value;
    }
}
