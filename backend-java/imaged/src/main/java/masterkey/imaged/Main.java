// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.imaged;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * The imaged program: {@code POST /v1/images} with {@code X-Imaged-Secret}, on the private
 * network only. At most {@code IMAGED_PARALLEL} images at once: beyond, 503 and the API answers
 * 503 with Retry-After (the upload stays). Configuration: {@code IMAGED_SECRET} (required),
 * {@code IMAGED_PORT} (8094), {@code IMAGED_BIND} (127.0.0.1), {@code VIPS}, {@code VIPSHEADER};
 * R2 with {@code R2_ENDPOINT}, {@code R2_ACCESS_KEY_ID}, {@code R2_SECRET_ACCESS_KEY},
 * {@code R2_ORIGINALS_BUCKET}, {@code R2_PUBLIC_BUCKET}, else {@code STORAGE_DIR} (the folder the
 * API shares in development).
 */
public final class Main {

    private static final Logger log = LoggerFactory.getLogger(Main.class);
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final int MAX_REQUEST = 16 * 1024;

    private Main() {
    }

    public static void main(String[] args) throws IOException {
        Map<String, String> env = System.getenv();
        String secret = env.get("IMAGED_SECRET");
        if (secret == null || secret.length() < 16) {
            System.err.println("IMAGED_SECRET is needed (16 characters at least)");
            System.exit(78);
            return;
        }
        Path work = Files.createDirectories(Path.of(env.getOrDefault("IMAGED_WORK", System.getProperty("java.io.tmpdir"))).resolve("imaged"));
        Store store;
        String endpoint = env.get("R2_ENDPOINT");
        if (endpoint != null && !endpoint.isBlank()) {
            List<String> needed = List.of("R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ORIGINALS_BUCKET", "R2_PUBLIC_BUCKET");
            List<String> values = new ArrayList<>();
            for (String name : needed) {
                String value = env.get(name);
                if (value == null || value.isBlank()) {
                    System.err.println("R2_ENDPOINT needs " + String.join(", ", needed));
                    System.exit(78);
                    return;
                }
                values.add(value.strip());
            }
            store = new S3Store(endpoint.strip(), values.get(0), values.get(1), values.get(2), values.get(3));
        } else {
            // Development: the folder the API shares
            store = new Store.Folder(Path.of(env.getOrDefault("STORAGE_DIR", "data")));
        }
        Pipeline pipeline = new Pipeline(store, work, env.getOrDefault("VIPS", "vips"), env.getOrDefault("VIPSHEADER", "vipsheader"));
        int parallel = Integer.parseInt(env.getOrDefault("IMAGED_PARALLEL", Integer.toString(Math.max(2, Runtime.getRuntime().availableProcessors()))));
        HttpServer server = start(pipeline, secret, InetAddress.getByName(env.getOrDefault("IMAGED_BIND", "127.0.0.1")),
                Integer.parseInt(env.getOrDefault("IMAGED_PORT", "8094")), parallel);
        log.info("imaged on port {}", server.getAddress().getPort());
    }

    static HttpServer start(Pipeline pipeline, String secret, InetAddress bind, int port, int parallel) throws IOException {
        Semaphore slots = new Semaphore(parallel);
        byte[] expected = secret.getBytes(StandardCharsets.UTF_8);
        HttpServer server = HttpServer.create(new InetSocketAddress(bind, port), 128);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/v1/health", exchange -> answer(exchange, 200, Map.of("ok", true)));
        server.createContext("/v1/images", exchange -> {
            try (exchange) {
                String given = exchange.getRequestHeaders().getFirst("X-Imaged-Secret");
                if (given == null || !MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), expected)) {
                    answer(exchange, 403, error("forbidden", "wrong secret"));
                    return;
                }
                if (!"POST".equals(exchange.getRequestMethod())) {
                    answer(exchange, 405, error("bad_request", "POST only"));
                    return;
                }
                if (!slots.tryAcquire()) {
                    answer(exchange, 503, error("unavailable", "busy"));
                    return;
                }
                try {
                    handle(pipeline, exchange);
                } finally {
                    slots.release();
                }
            }
        });
        server.start();
        return server;
    }

    private static void handle(Pipeline pipeline, HttpExchange exchange) throws IOException {
        JsonNode request;
        try (InputStream in = exchange.getRequestBody()) {
            byte[] body = in.readNBytes(MAX_REQUEST + 1);
            if (body.length > MAX_REQUEST) {
                answer(exchange, 413, error("too_large", "request too large"));
                return;
            }
            request = JSON.readTree(body);
        } catch (RuntimeException error) {
            log.warn("imaged: a request that is not JSON: {}", error.getClass().getSimpleName());
            answer(exchange, 400, error("bad_request", "invalid request"));
            return;
        }
        try {
            String original = request.get("original").stringValue();
            long size = request.get("size").longValue();
            Pipeline.Kind kind = Pipeline.Kind.valueOf(request.get("kind").stringValue().toUpperCase(Locale.ROOT));
            List<String> outputs = new ArrayList<>();
            for (JsonNode key : request.get("outputs")) outputs.add(key.stringValue());
            List<Map<String, Object>> files = new ArrayList<>();
            for (Pipeline.Made made : pipeline.make(original, size, kind, outputs)) {
                Map<String, Object> file = new LinkedHashMap<>();
                file.put("key", made.key());
                file.put("width", made.width());
                file.put("height", made.height());
                files.add(file);
            }
            answer(exchange, 200, Map.of("files", files));
        } catch (Pipeline.Refused refused) {
            answer(exchange, refused.status, error(refused.status == 413 ? "too_large" : refused.status == 400 ? "bad_request" : "moderated",
                    refused.getMessage() == null ? "refused" : refused.getMessage()));
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            answer(exchange, 503, error("unavailable", "stopping"));
        } catch (NullPointerException | IllegalArgumentException | UnsupportedOperationException error) {
            answer(exchange, 400, error("bad_request", "invalid request"));
        } catch (RuntimeException | IOException error) {
            log.error("imaged: an image failed", error);
            answer(exchange, 500, error("internal", "something went wrong"));
        }
    }

    private static Map<String, Object> error(String code, String message) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", code);
        body.put("message", message);
        return body;
    }

    private static void answer(HttpExchange exchange, int status, Object body) throws IOException {
        byte[] bytes = JSON.writeValueAsBytes(body);
        exchange.getResponseHeaders().set("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
