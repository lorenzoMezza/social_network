// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.web;

import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import masterkey.core.ApiError;
import masterkey.core.Json;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

/**
 * Every error as {@code {code, message, details?}} with the status API.md gives it (§16,
 * Errori di Spring): Spring's own (404, 405, 415, a body that is not JSON) included. What went
 * wrong on the server is logged here and never sent: 500 {@code internal}, nothing more.
 */
@RestControllerAdvice
public class Errors extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(Errors.class);

    @ExceptionHandler(ApiError.class)
    public ResponseEntity<Object> api(ApiError error) {
        HttpHeaders headers = new HttpHeaders();
        error.headers().forEach(headers::add);
        return ResponseEntity.status(error.status()).headers(headers).contentType(MediaType.APPLICATION_JSON).body(body(error));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Object> unexpected(Exception error) {
        log.error("api: a request failed", error);
        return api(ApiError.internal());
    }

    @Override
    protected ResponseEntity<Object> handleExceptionInternal(Exception error, @Nullable Object body, HttpHeaders headers,
                                                             HttpStatusCode status, WebRequest request) {
        int code = status.value();
        ApiError answer = switch (code) {
            case 400 -> ApiError.badRequest(error instanceof org.springframework.http.converter.HttpMessageNotReadableException
                    ? "the body is not valid JSON" : "invalid request");
            case 404 -> ApiError.notFound("not found");
            case 405 -> new ApiError(405, "bad_request", "method not allowed");
            case 406 -> new ApiError(406, "bad_request", "not acceptable");
            case 413 -> ApiError.tooLarge("request too large");
            case 415 -> new ApiError(415, "bad_request", "a JSON body is needed");
            case 503 -> ApiError.unavailable("try again later", 5);
            default -> code >= 500 ? ApiError.internal() : new ApiError(code, "bad_request", "invalid request");
        };
        if (code >= 500) log.error("api: a request failed", error);
        HttpHeaders out = new HttpHeaders();
        headers.forEach((name, values) -> {
            if (name.equalsIgnoreCase("Allow")) out.put(name, values);
        });
        answer.headers().forEach(out::add);
        return ResponseEntity.status(answer.status()).headers(out).contentType(MediaType.APPLICATION_JSON).body(body(answer));
    }

    static Map<String, Object> body(ApiError error) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", error.code());
        String message = error.getMessage();
        body.put("message", message == null ? error.code() : message);
        List<String> details = error.details();
        if (!details.isEmpty()) body.put("details", details);
        return body;
    }

    /** For filters, which run outside Spring's handlers: the same answer, written by hand. */
    public static void write(HttpServletResponse response, ApiError error) throws IOException {
        response.resetBuffer();
        response.setStatus(error.status());
        response.setContentType("application/json");
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        error.headers().forEach(response::setHeader);
        response.getOutputStream().write(Json.bytes(body(error)));
    }
}
