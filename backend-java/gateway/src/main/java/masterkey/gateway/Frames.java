// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.gateway;

import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import masterkey.core.ApiError;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.presence.ClientFrame;
import masterkey.presence.Mode;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * Reads what a phone sends after {@code auth} into the closed set of frames, with the checks
 * of {@code realtime._handle}. Numbers a phone may not say about how it moves count as not
 * said: they would reach other people's phones.
 */
final class Frames {

    static final Set<String> GESTURES = Set.of("wave", "handsair", "fistpump", "dab");
    /** A ref is echoed as it came; a huge one is not echoed at all. */
    static final int MAX_REF = 256;

    private Frames() {
    }

    /** What came in: a frame for the presence, a ping, or a frame this server does not know. */
    sealed interface Read {
    }

    record ForPresence(ClientFrame frame) implements Read {
    }

    record Ping(@Nullable String ref) implements Read {
    }

    /** The auth frame of the first message; nothing else may come first. */
    record Auth(String token) implements Read {
        @Override
        public String toString() {
            return "Auth[…]";
        }
    }

    /** A frame that could not be read: answered with an error, carrying its ref when it had one. */
    static final class Invalid extends RuntimeException {
        private static final long serialVersionUID = 1L;
        final transient @Nullable String ref;
        final transient ApiError error;

        Invalid(@Nullable String ref, ApiError error) {
            super(error.code(), null, false, false);
            this.ref = ref;
            this.error = error;
        }
    }

    static @Nullable Auth auth(String text) {
        JsonNode node;
        try {
            node = Json.parse(text);
        } catch (ApiError error) {
            return null;
        }
        if (!node.isObject() || !"auth".equals(string(node.get("type")))) return null;
        String token = string(node.get("token"));
        return token == null || token.isEmpty() || token.length() > 16_384 ? null : new Auth(token);
    }

    static Read read(String text) {
        JsonNode node;
        try {
            node = Json.parse(text);
        } catch (ApiError error) {
            throw new Invalid(null, ApiError.badRequest("invalid frame"));
        }
        if (!node.isObject()) throw new Invalid(null, ApiError.badRequest("invalid frame"));
        String ref = ref(node.get("ref"));
        try {
            return switch (String.valueOf(string(node.get("type")))) {
                case "ping" -> new Ping(ref);
                case "presence" -> new ForPresence(presence(ref, node));
                case "gesture" -> new ForPresence(gesture(ref, node));
                case "broadcast" -> {
                    String words = string(node.get("text"));
                    yield new ForPresence(new ClientFrame.Broadcast(ref, words == null ? "" : words));
                }
                case "connect.invite" -> new ForPresence(new ClientFrame.ConnectInvite(ref, person(node.get("to"))));
                case "connect.answer" -> {
                    String invite = string(node.get("invite"));
                    JsonNode accept = node.get("accept");
                    yield new ForPresence(new ClientFrame.ConnectAnswer(ref, invite == null ? "" : invite,
                            accept != null && accept.isBoolean() && accept.booleanValue()));
                }
                default -> throw ApiError.badRequest("unknown frame");
            };
        } catch (ApiError error) {
            throw new Invalid(ref, error);
        }
    }

    private static ClientFrame.PresenceUpdate presence(@Nullable String ref, JsonNode node) {
        Mode mode = Mode.of(string(node.get("mode")));
        if (mode == null) throw ApiError.badRequest("unknown mode");
        JsonNode raw = node.get("position");
        ClientFrame.Position position = null;
        if (raw != null && raw.isObject()) {
            Double latitude = number(raw.get("latitude"), -Double.MAX_VALUE, Double.MAX_VALUE);
            Double longitude = number(raw.get("longitude"), -Double.MAX_VALUE, Double.MAX_VALUE);
            if (latitude != null && longitude != null) {
                if (!Geo.validLatitude(latitude) || !Geo.validLongitude(longitude)) throw ApiError.badRequest("position out of range");
                JsonNode moving = raw.get("moving");
                position = new ClientFrame.Position(latitude, longitude,
                        number(raw.get("accuracy"), 0, 1_000_000),
                        number(raw.get("heading"), 0, 360),
                        number(raw.get("speed"), 0, 150),
                        (moving != null && moving.isBoolean()) ? Boolean.valueOf(moving.booleanValue()) : null);
            }
        }
        return new ClientFrame.PresenceUpdate(ref, mode, position);
    }

    private static ClientFrame.Gesture gesture(@Nullable String ref, JsonNode node) {
        String gesture = string(node.get("gesture"));
        if (gesture == null || !GESTURES.contains(gesture)) throw ApiError.badRequest("unknown gesture");
        return new ClientFrame.Gesture(ref, person(node.get("to")), gesture);
    }

    private static UUID person(@Nullable JsonNode node) {
        String id = string(node);
        Optional<UUID> user = id == null ? Optional.empty() : Ids.parse("usr", id);
        return user.orElseThrow(() -> ApiError.notFound("unknown person"));
    }

    /** A finite number within the range, else null: never a boolean, never a string. */
    static @Nullable Double number(@Nullable JsonNode node, double min, double max) {
        if (node == null || !node.isNumber()) return null;
        double value = node.doubleValue();
        return Double.isFinite(value) && value >= min && value <= max ? value : null;
    }

    private static @Nullable String string(@Nullable JsonNode node) {
        return node != null && node.isString() ? node.stringValue() : null;
    }

    private static @Nullable String ref(@Nullable JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) return null;
        String text = Json.text(node);
        return text.length() > MAX_REF ? null : text;
    }
}
