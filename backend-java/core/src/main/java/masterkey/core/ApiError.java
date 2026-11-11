// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.core;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * What a request answers when it cannot do what was asked: the HTTP status and
 * {@code { code, message, details? }} (API.md, Conventions). The app shows its own text for
 * each code and also reads the bare status, so a status must mean what the contract says.
 * {@code message} is for developers and never carries what the user sent.
 */
public final class ApiError extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final int status;
    private final String code;
    private final List<String> details;
    private final Map<String, String> headers;

    public ApiError(int status, String code, @Nullable String message) {
        this(status, code, message, List.of(), Map.of());
    }

    public ApiError(int status, String code, @Nullable String message, List<String> details, Map<String, String> headers) {
        super(message == null || message.isEmpty() ? code.replace('_', ' ') : message, null, false, false);
        this.status = status;
        this.code = code;
        this.details = List.copyOf(details);
        this.headers = Map.copyOf(headers);
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    public List<String> details() {
        return details;
    }

    public Map<String, String> headers() {
        return headers;
    }

    public ApiError withDetails(List<String> more) {
        return new ApiError(status, code, getMessage(), more, headers);
    }

    public static ApiError badRequest(String message) {
        return new ApiError(400, "bad_request", message);
    }

    public static ApiError badRequest(String message, List<String> details) {
        return new ApiError(400, "bad_request", message, details, Map.of());
    }

    public static ApiError unauthorized(String message) {
        return new ApiError(401, "unauthorized", message);
    }

    public static ApiError forbidden(String message) {
        return new ApiError(403, "forbidden", message);
    }

    public static ApiError forbidden(String code, String message) {
        return new ApiError(403, code, message);
    }

    public static ApiError notFound(String message) {
        return new ApiError(404, "not_found", message);
    }

    public static ApiError conflict(String code, String message) {
        return new ApiError(409, code, message);
    }

    public static ApiError gone(String code, String message) {
        return new ApiError(410, code, message);
    }

    public static ApiError tooLarge(String message) {
        return new ApiError(413, "too_large", message);
    }

    public static ApiError moderated(String message) {
        return new ApiError(422, "moderated", message);
    }

    public static ApiError rateLimited(long retryAfterSeconds) {
        return new ApiError(429, "rate_limited", "too many requests", List.of(),
                Map.of("Retry-After", Long.toString(Math.max(1, retryAfterSeconds))));
    }

    public static ApiError unavailable(String message, long retryAfterSeconds) {
        return new ApiError(503, "unavailable", message, List.of(),
                Map.of("Retry-After", Long.toString(Math.max(1, retryAfterSeconds))));
    }

    /** What went wrong on the server: nothing about it reaches the answer. */
    public static ApiError internal() {
        return new ApiError(500, "internal", "something went wrong");
    }
}
