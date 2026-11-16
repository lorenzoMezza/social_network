// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.avatars;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import masterkey.core.Json;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * Map avatars (API.md, Avatars): the same avatar made once by the baker into one mesh, one
 * skeleton and one atlas, named by a hash of the look. The key of a look is kept; a look not
 * baked yet is asked for once at a time, in the background: a read never waits (§8, avatar.bake),
 * saving waits at most a few seconds.
 */
public final class MapAvatars implements AutoCloseable {

    static final Pattern KEY = Pattern.compile("[0-9a-f]{32}");

    private final @Nullable URI baker;
    private final @Nullable String secret;
    private final Duration timeout;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private final Cache<String, String> keys = Caffeine.newBuilder().maximumSize(20_000).build();
    private final Map<String, CompletableFuture<@Nullable String>> baking = new ConcurrentHashMap<>();
    private final ExecutorService threads = Executors.newVirtualThreadPerTaskExecutor();

    public MapAvatars(@Nullable String baker, @Nullable String secret, Duration timeout) {
        this.baker = baker == null || baker.isBlank() ? null : URI.create(baker.endsWith("/") ? baker.substring(0, baker.length() - 1) : baker);
        this.secret = secret;
        this.timeout = timeout;
    }

    /** What makes a look: its canonical JSON, keys sorted. */
    static String look(JsonNode avatar) {
        Map<String, Object> look = new TreeMap<>();
        for (String key : new String[] {"format", "version", "bodyShape", "colors", "wearables"}) look.put(key, avatar.get(key));
        return Json.text(look);
    }

    /** The key now if known; otherwise asked for in the background, and null (the app shows the stand-in). */
    public @Nullable String now(@Nullable JsonNode avatar) {
        if (avatar == null || baker == null) return null;
        String look = look(avatar);
        String known = keys.getIfPresent(look);
        if (known != null) return known;
        // In the background: the next read finds it
        CompletableFuture<?> _ = bake(look);
        return null;
    }

    /** The key, waiting at most {@code wait} for the baker (saving an avatar). */
    public @Nullable String waitFor(@Nullable JsonNode avatar, Duration wait) {
        if (avatar == null || baker == null) return null;
        String look = look(avatar);
        String known = keys.getIfPresent(look);
        if (known != null) return known;
        try {
            return bake(look).get(wait.toMillis(), TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception error) {
            return null;
        }
    }

    private CompletableFuture<@Nullable String> bake(String look) {
        return baking.computeIfAbsent(look, key -> CompletableFuture.supplyAsync(() -> ask(look), threads)
                .whenComplete((made, error) -> baking.remove(look)));
    }

    private @Nullable String ask(String look) {
        URI base = baker;
        if (base == null) return null;
        try {
            HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(base + "/v1/map-avatars")).timeout(timeout)
                    .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(look));
            if (secret != null) request.header("X-Bake-Secret", secret);
            HttpResponse<String> answer = http.send(request.build(), HttpResponse.BodyHandlers.ofString());
            if (answer.statusCode() != 200) return null;
            JsonNode key = Json.parse(answer.body()).get("key");
            if (key == null || !key.isString() || !KEY.matcher(key.stringValue()).matches()) return null;
            keys.put(look, key.stringValue());
            return key.stringValue();
        } catch (IOException | RuntimeException error) {
            return null;
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    @Override
    public void close() {
        threads.close();
    }
}
