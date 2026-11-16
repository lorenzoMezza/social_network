// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import masterkey.core.ApiError;
import masterkey.core.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

/**
 * {@code imaged} over the private network (§5, §19): a separate program that runs
 * {@code vips thumbnail} for each image, so C code on a hostile image never runs inside this
 * JVM. At most so many at once ({@code Semaphore}); full or silent, the upload stays as it was
 * and the answer is 503. The secret travels in a header and is compared with
 * {@code MessageDigest.isEqual} on the other side.
 */
public final class ImagedClient implements Imaging {

    private static final Logger log = LoggerFactory.getLogger(ImagedClient.class);
    /** Less than the 15 s the app waits. */
    static final Duration TIMEOUT = Duration.ofSeconds(14);

    private final URI base;
    private final String secret;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private final Semaphore slots;

    public ImagedClient(URI base, String secret) {
        this(base, secret, 16);
    }

    public ImagedClient(URI base, String secret, int parallel) {
        this.base = base;
        this.secret = secret;
        this.slots = new Semaphore(parallel);
    }

    @Override
    public Result make(String original, long declaredSize, Kind kind, List<String> outputs) {
        try {
            if (!slots.tryAcquire(1, TimeUnit.SECONDS)) return new Busy();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return new Busy();
        }
        try {
            Map<String, Object> request = new LinkedHashMap<>();
            request.put("original", original);
            request.put("size", declaredSize);
            request.put("kind", kind.name().toLowerCase(java.util.Locale.ROOT));
            request.put("outputs", outputs);
            HttpResponse<String> answer = http.send(HttpRequest.newBuilder(base.resolve("/v1/images"))
                    .timeout(TIMEOUT).header("Content-Type", "application/json").header("X-Imaged-Secret", secret)
                    .POST(HttpRequest.BodyPublishers.ofByteArray(Json.bytes(request))).build(), HttpResponse.BodyHandlers.ofString());
            JsonNode body = answer.body().isEmpty() ? Json.object() : Json.parse(answer.body());
            if (answer.statusCode() == 200) {
                List<Made> made = new ArrayList<>();
                for (JsonNode file : body.get("files")) {
                    made.add(new Made(file.get("key").stringValue(), file.get("width").intValue(), file.get("height").intValue()));
                }
                return new Done(made);
            }
            if (answer.statusCode() == 422 || answer.statusCode() == 413 || answer.statusCode() == 400) {
                JsonNode message = body.get("message");
                String text = message == null || !message.isString() ? "not an image this server can read" : message.stringValue();
                return new Refused(answer.statusCode() == 413 ? ApiError.tooLarge(text)
                        : answer.statusCode() == 400 ? ApiError.badRequest(text) : ApiError.moderated(text));
            }
            log.warn("imaged answered {}", answer.statusCode());
            return new Busy();
        } catch (IOException | ApiError | NullPointerException error) {
            log.warn("imaged did not answer: {}", error.getClass().getSimpleName());
            return new Busy();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return new Busy();
        } finally {
            slots.release();
        }
    }
}
