// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.core.Point;
import tools.jackson.databind.JsonNode;

/**
 * The presence engine driven by hand: a clock that moves when told, a directory that
 * answers at once (or never, or with an error), and every frame kept per socket. Each frame
 * is also played on a model of the app (snapshot replaces, delta adds and removes), so a
 * test can check that what a phone shows is what the server thinks it shows.
 */
final class Harness {

    static final double ROME_LAT = 41.9028;
    static final double ROME_LON = 12.4964;
    static final byte[] KEY = "0123456789abcdef0123456789abcdef".getBytes(java.nio.charset.StandardCharsets.UTF_8);

    final ManualClock clock = new ManualClock();
    final FakeDirectory directory = new FakeDirectory();
    final Recorder delivery = new Recorder();
    final ArrayDeque<Runnable> inbox = new ArrayDeque<>();
    final Engine engine;
    private long nextSocket;

    Harness() {
        this(PresenceConfig.of(KEY, 340));
    }

    Harness(PresenceConfig config) {
        engine = new Engine(config, directory, delivery, clock, inbox::add);
    }

    /** Runs what came back from the directory. */
    void settle() {
        Runnable next;
        while ((next = inbox.poll()) != null) next.run();
    }

    UUID user() {
        UUID id = Ids.random();
        directory.summaries.put(id, "{\"id\":\"" + Ids.publicId("usr", id) + "\",\"username\":\"u" + directory.summaries.size() + "\"}");
        return id;
    }

    SocketId open(UUID user) {
        SocketId socket = new SocketId(1, ++nextSocket);
        delivery.owners.put(socket, user);
        engine.socketOpened(user, socket);
        settle();
        return socket;
    }

    void close(UUID user, SocketId socket) {
        engine.socketClosed(user, socket);
        settle();
    }

    void at(UUID user, SocketId socket, Mode mode, double lat, double lon) {
        engine.frame(user, socket, new ClientFrame.PresenceUpdate(null, mode,
                new ClientFrame.Position(lat, lon, 5.0, 90.0, 1.2, true)));
        settle();
    }

    /** {@code metres} east of Rome's centre. */
    void east(UUID user, SocketId socket, Mode mode, double metres) {
        Point point = Geo.offset(ROME_LAT, ROME_LON, metres, 0);
        at(user, socket, mode, point.latitude(), point.longitude());
    }

    void leave(UUID user, SocketId socket) {
        engine.frame(user, socket, new ClientFrame.PresenceUpdate(null, Mode.VISIBLE, null));
        settle();
    }

    void send(UUID user, SocketId socket, ClientFrame frame) {
        engine.frame(user, socket, frame);
        settle();
    }

    void tick() {
        engine.tick();
        settle();
    }

    void advance(Duration duration) {
        clock.advance(duration);
        engine.runTimers();
        settle();
    }

    /** Every socket's model matches what the engine thinks the user sees. */
    void checkModels() {
        assertThat(engine.invariants()).isEmpty();
        for (Map.Entry<SocketId, Model> entry : delivery.models.entrySet()) {
            UUID owner = delivery.owners.get(entry.getKey());
            Person person = engine.person(owner);
            if (person == null || entry.getValue().closed) continue;
            boolean started = person.sockets.stream().anyMatch(s -> s.id.equals(entry.getKey()) && s.started);
            if (!started) continue;
            Set<String> expected = new HashSet<>();
            for (int i = 0; i < person.watchingCount; i++) expected.add(person.watching[i].publicId);
            List<JsonNode> history = delivery.of(entry.getKey());
            assertThat(entry.getValue().people.keySet())
                    .as("what the phone of " + person + " on=" + person.on + " shows; last frames: "
                            + history.subList(Math.max(0, history.size() - 6), history.size()))
                    .isEqualTo(expected);
        }
    }

    // --- the pieces ---

    static final class ManualClock implements PresenceClock {
        long nanos = 1_000_000_000_000L;
        Instant instant = Instant.parse("2026-11-11T10:00:00Z");

        @Override
        public long nanos() {
            return nanos;
        }

        @Override
        public Instant instant() {
            return instant;
        }

        void advance(Duration duration) {
            nanos += duration.toNanos();
            instant = instant.plus(duration);
        }
    }

    static final class FakeDirectory implements Directory {
        final Map<UUID, Set<UUID>> connections = new HashMap<>();
        final Map<UUID, Set<UUID>> blocked = new HashMap<>();
        final Map<UUID, String> summaries = new HashMap<>();
        final Map<UUID, Integer> avatars = new HashMap<>();
        final List<UUID[]> invited = new ArrayList<>();
        /** Relations held back: answered only when the test says so. */
        final Map<UUID, CompletableFuture<Relations>> held = new HashMap<>();
        boolean hold;
        int failNext;

        @Override
        public CompletableFuture<Relations> relations(UUID user) {
            if (failNext > 0) {
                failNext--;
                return CompletableFuture.failedFuture(new IllegalStateException("database down"));
            }
            if (hold) {
                CompletableFuture<Relations> later = new CompletableFuture<>();
                held.put(user, later);
                return later;
            }
            return CompletableFuture.completedFuture(relationsOf(user));
        }

        Relations relationsOf(UUID user) {
            return new Relations(connections.getOrDefault(user, Set.of()), blocked.getOrDefault(user, Set.of()));
        }

        @Override
        public CompletableFuture<Summary> summary(UUID user) {
            return CompletableFuture.completedFuture(new Summary(summaries.getOrDefault(user, "{}"), avatars.getOrDefault(user, 1)));
        }

        @Override
        public void connectInvited(UUID target, UUID actor) {
            invited.add(new UUID[] {target, actor});
        }

        void connect(UUID a, UUID b) {
            connections.computeIfAbsent(a, k -> new HashSet<>()).add(b);
            connections.computeIfAbsent(b, k -> new HashSet<>()).add(a);
        }

        void block(UUID a, UUID b) {
            blocked.computeIfAbsent(a, k -> new HashSet<>()).add(b);
            blocked.computeIfAbsent(b, k -> new HashSet<>()).add(a);
        }
    }

    /** What a phone would show from the frames it got. */
    static final class Model {
        final Map<String, JsonNode> people = new LinkedHashMap<>();
        final Set<String> knownUsers = new HashSet<>();
        Integer audience;
        boolean closed;
        int closeCode;
    }

    static final class Recorder implements Delivery {
        final Map<SocketId, List<JsonNode>> frames = new HashMap<>();
        final Map<SocketId, Model> models = new HashMap<>();
        final Map<SocketId, UUID> owners = new HashMap<>();
        /** Called with every frame as it leaves, while the engine is in the state that made it. */
        java.util.function.BiConsumer<SocketId, JsonNode> check = (socket, frame) -> { };

        @Override
        public void send(SocketId socket, String text) {
            JsonNode frame = Json.parse(text);
            check.accept(socket, frame);
            frames.computeIfAbsent(socket, k -> new ArrayList<>()).add(frame);
            Model model = models.computeIfAbsent(socket, k -> new Model());
            String type = frame.get("type").stringValue();
            if (type.equals("presence.snapshot")) {
                model.people.clear();
                for (JsonNode person : frame.get("people")) play(model, person);
            } else if (type.equals("presence.delta")) {
                for (JsonNode person : frame.get("people")) play(model, person);
                for (JsonNode gone : frame.get("removed")) {
                    assertThat(model.people).as("removed someone not shown").containsKey(gone.stringValue());
                    model.people.remove(gone.stringValue());
                }
                if (frame.has("audience")) model.audience = frame.get("audience").intValue();
            }
        }

        private static void play(Model model, JsonNode person) {
            String id = person.get("userId").stringValue();
            if (person.has("user")) model.knownUsers.add(id);
            assertThat(model.knownUsers).as("a person arrives with their user the first time").contains(id);
            model.people.put(id, person);
        }

        @Override
        public void close(SocketId socket, int code, String reason) {
            Model model = models.computeIfAbsent(socket, k -> new Model());
            model.closed = true;
            model.closeCode = code;
        }

        List<JsonNode> of(SocketId socket) {
            return frames.getOrDefault(socket, List.of());
        }

        List<JsonNode> of(SocketId socket, String type) {
            return of(socket).stream().filter(f -> f.get("type").stringValue().equals(type)).toList();
        }

        JsonNode last(SocketId socket, String type) {
            List<JsonNode> found = of(socket, type);
            assertThat(found).as("a " + type + " frame").isNotEmpty();
            return found.getLast();
        }

        Model model(SocketId socket) {
            return models.computeIfAbsent(socket, k -> new Model());
        }

        void clear() {
            frames.clear();
        }
    }
}
