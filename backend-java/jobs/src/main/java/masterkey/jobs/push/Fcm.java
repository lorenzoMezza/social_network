// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.jobs.push;

import com.google.auth.oauth2.GoogleCredentials;
import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;
import masterkey.core.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

/**
 * Firebase Cloud Messaging, HTTP v1, directly (§14, D5): a service account of the Firebase
 * project, its OAuth token kept by Google's own library, one request per device token.
 */
public final class Fcm implements PushSender {

    private static final Logger log = LoggerFactory.getLogger(Fcm.class);
    static final String SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
    static final Duration TIMEOUT = Duration.ofSeconds(10);

    private final URI endpoint;
    private final Supplier<String> accessToken;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(TIMEOUT).followRedirects(HttpClient.Redirect.NEVER).build();

    Fcm(URI endpoint, Supplier<String> accessToken) {
        this.endpoint = endpoint;
        this.accessToken = accessToken;
    }

    /** From the service account's JSON key: its project, its credentials. */
    public static Fcm of(Path serviceAccount) {
        try {
            JsonNode account = Json.parse(Files.readAllBytes(serviceAccount));
            String project = account.path("project_id").stringValue(null);
            if (project == null || !project.matches("[a-z0-9-]{1,64}")) throw new IllegalArgumentException("FCM_SERVICE_ACCOUNT_FILE has no project_id");
            GoogleCredentials credentials;
            try (InputStream in = Files.newInputStream(serviceAccount)) {
                credentials = GoogleCredentials.fromStream(in).createScoped(List.of(SCOPE));
            }
            return new Fcm(URI.create("https://fcm.googleapis.com/v1/projects/" + project + "/messages:send"), () -> {
                try {
                    credentials.refreshIfExpired();
                    var token = credentials.getAccessToken();
                    if (token == null) throw new IllegalStateException("FCM: no access token");
                    return token.getTokenValue();
                } catch (IOException error) {
                    throw new UncheckedIOException(error);
                }
            });
        } catch (IOException error) {
            throw new UncheckedIOException("FCM_SERVICE_ACCOUNT_FILE cannot be read", error);
        }
    }

    static String body(String token, Message message) {
        Map<String, Object> notification = new LinkedHashMap<>();
        notification.put("title", message.title());
        notification.put("body", message.body());
        Map<String, Object> android = new LinkedHashMap<>();
        android.put("priority", "high");
        android.put("ttl", "86400s");
        android.put("collapse_key", message.collapse());
        android.put("notification", Map.of("tag", message.collapse()));
        Map<String, Object> inner = new LinkedHashMap<>();
        inner.put("token", token);
        inner.put("notification", notification);
        inner.put("data", message.data());
        inner.put("android", android);
        return Json.text(Map.of("message", inner));
    }

    @Override
    public Result send(String token, Message message) throws InterruptedException {
        if (token.isEmpty() || token.length() > 4096) return Result.GONE;
        String bearer;
        try {
            bearer = accessToken.get();
        } catch (RuntimeException error) {
            return Result.RETRY;
        }
        HttpResponse<String> answer;
        try {
            answer = http.send(HttpRequest.newBuilder(endpoint).timeout(TIMEOUT).header("Authorization", "Bearer " + bearer)
                    .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body(token, message))).build(),
                    HttpResponse.BodyHandlers.ofString());
        } catch (IOException error) {
            return Result.RETRY;
        }
        int status = answer.statusCode();
        if (status == 200) return Result.SENT;
        String code = code(answer.body());
        // UNREGISTERED: the app was removed or the token replaced
        if (status == 404 || "UNREGISTERED".equals(code)) return Result.GONE;
        if (status == 401 || status == 403 || status == 429 || status >= 500) return Result.RETRY;
        log.warn("fcm: a push refused, {} {}", status, code);
        return Result.FAILED;
    }

    private static String code(String body) {
        try {
            JsonNode details = Json.parse(body).path("error").path("details");
            for (JsonNode detail : details) {
                String code = detail.path("errorCode").stringValue(null);
                if (code != null) return code;
            }
            return Json.parse(body).path("error").path("status").stringValue("");
        } catch (RuntimeException error) {
            return "";
        }
    }

    @Override
    public String toString() {
        return "Fcm[" + endpoint + "]";
    }
}
