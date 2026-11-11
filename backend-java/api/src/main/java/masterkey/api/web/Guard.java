// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import masterkey.auth.AppVersion;
import masterkey.core.ApiError;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Before anything else ({@code main.py}, {@code guard}): an app too old answers 426
 * {@code upgrade_required}; a JSON body sent in pieces without {@code Content-Length} 411; one
 * over 256 KB 413, before it is read (Jetty does not check the size of a JSON, §16). Files
 * never come this way: they go straight to the storage.
 */
public final class Guard extends OncePerRequestFilter {

    public static final long MAX_JSON_BODY = 256 * 1024;

    private final AppVersion minimum;

    public Guard(AppVersion minimum) {
        this.minimum = minimum;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        if (minimum.tooOld(request.getHeader("X-Client"))) {
            Errors.write(response, new ApiError(426, "upgrade_required", "this version of the app is too old"));
            return;
        }
        String method = request.getMethod();
        if (("POST".equals(method) || "PUT".equals(method) || "PATCH".equals(method)) && !request.getRequestURI().startsWith("/v1/storage/")) {
            String length = request.getHeader("Content-Length");
            if (length == null && request.getHeader("Transfer-Encoding") != null) {
                Errors.write(response, new ApiError(411, "bad_request", "a Content-Length is needed"));
                return;
            }
            if (length != null && (!length.matches("[0-9]{1,12}") || Long.parseLong(length) > MAX_JSON_BODY)) {
                Errors.write(response, ApiError.tooLarge("request too large"));
                return;
            }
        }
        chain.doFilter(request, response);
    }
}
