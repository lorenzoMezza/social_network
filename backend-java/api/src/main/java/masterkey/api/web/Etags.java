// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

/**
 * Every {@code 200} JSON answer to a GET gets {@code ETag: W/"…"} (a hash of the body, before
 * compression) and {@code Cache-Control: private, no-cache}; a GET naming the current ETag in
 * {@code If-None-Match} answers 304 without a body (API.md, Caching; {@code main.py},
 * {@code etags}). Answers with an ETag of their own and {@code no-store} ones are left alone.
 * Spring's ShallowEtagHeaderFilter is not used: strong tags and none of the contract's headers.
 */
public final class Etags extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        // Files go straight out, never whole in memory: pictures (development), the copy of one's data
        String path = request.getRequestURI();
        if (!"GET".equals(request.getMethod()) || path.startsWith("/v1/media/") || path.startsWith("/v1/exports/")) {
            chain.doFilter(request, response);
            return;
        }
        ContentCachingResponseWrapper wrapper = new ContentCachingResponseWrapper(response);
        try {
            chain.doFilter(request, wrapper);
        } finally {
            finish(request, wrapper);
        }
    }

    private static void finish(HttpServletRequest request, ContentCachingResponseWrapper response) throws IOException {
        String type = response.getContentType();
        String control = response.getHeader("Cache-Control");
        if (response.getStatus() != 200 || type == null || !type.startsWith("application/json")
                || response.getHeader("ETag") != null || (control != null && control.contains("no-store"))) {
            response.copyBodyToResponse();
            return;
        }
        byte[] body = response.getContentAsByteArray();
        String tag = "W/\"" + sha1(body).substring(0, 24) + "\"";
        String cacheControl = control != null ? control : "private, no-cache";
        if (named(request.getHeader("If-None-Match"), tag)) {
            response.resetBuffer();
            response.setStatus(304);
            response.setHeader("ETag", tag);
            response.setHeader("Cache-Control", cacheControl);
            response.setContentLength(0);
            // Nothing of the body goes out
            response.getResponse().flushBuffer();
            return;
        }
        response.setHeader("ETag", tag);
        response.setHeader("Cache-Control", cacheControl);
        response.copyBodyToResponse();
    }

    private static boolean named(String header, String tag) {
        if (header == null) return false;
        for (String one : header.split(",", -1)) {
            String value = one.strip();
            // Jetty adds --gzip to the tag when it compresses: the same answer
            if (value.equals(tag) || value.equals(tag.substring(0, tag.length() - 1) + "--gzip\"")) return true;
        }
        return false;
    }

    private static String sha1(byte[] body) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-1").digest(body));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }
}
