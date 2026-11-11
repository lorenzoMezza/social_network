// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import org.eclipse.jetty.http.HttpHeader;
import org.eclipse.jetty.server.Request;
import org.eclipse.jetty.server.Response;
import org.eclipse.jetty.server.handler.ErrorHandler;
import org.eclipse.jetty.util.Callback;
import org.jspecify.annotations.Nullable;

/**
 * Jetty's own errors as {@code {code, message}} (§16, Errori di Jetty): {@code %2F}, {@code %00},
 * {@code ..}, a huge header, broken HTTP answer before Spring is reached, and would otherwise
 * be an HTML page. The message is always ours: never what the request carried.
 */
final class JsonErrorHandler extends ErrorHandler {

    @Override
    protected void generateResponse(Request request, Response response, int code, @Nullable String message,
                                    @Nullable Throwable cause, Callback callback) {
        String kind = switch (code) {
            case 400 -> "bad_request";
            case 401 -> "unauthorized";
            case 403 -> "forbidden";
            case 404 -> "not_found";
            case 413, 431 -> "too_large";
            case 503 -> "unavailable";
            default -> code >= 500 ? "internal" : "bad_request";
        };
        String text = switch (kind) {
            case "not_found" -> "not found";
            case "too_large" -> "request too large";
            case "unavailable" -> "try again later";
            case "internal" -> "something went wrong";
            default -> "invalid request";
        };
        byte[] body = ("{\"code\":\"" + kind + "\",\"message\":\"" + text + "\"}").getBytes(StandardCharsets.UTF_8);
        response.getHeaders().put(HttpHeader.CONTENT_TYPE, "application/json");
        response.getHeaders().put(HttpHeader.CACHE_CONTROL, "no-store");
        response.write(true, ByteBuffer.wrap(body), callback);
    }
}
