// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.people;

import static masterkey.store.db.Tables.BLOCKS;
import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.CHAT_MEMBERS;
import static masterkey.store.db.Tables.CONNECTIONS;
import static masterkey.store.db.Tables.DISCONNECTED_PAIRS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.EVENT_PHOTOS;
import static masterkey.store.db.Tables.MESSAGES;
import static masterkey.store.db.Tables.REPORTS;
import static masterkey.store.db.Tables.USERS;

import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import masterkey.api.Limits;
import masterkey.api.chats.Chats;
import masterkey.api.common.Outbox;
import masterkey.api.common.People;
import masterkey.api.common.Relations;
import masterkey.api.events.EventNotifier;
import masterkey.api.events.EventsController;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.core.Point;
import masterkey.core.Text;
import masterkey.presence.Presence;
import masterkey.store.Database;
import masterkey.store.db.tables.records.ChatsRecord;
import masterkey.store.db.tables.records.EventPhotosRecord;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.MessagesRecord;
import masterkey.store.db.tables.records.UsersRecord;
import org.jooq.DSLContext;
import org.jooq.JSONB;
import org.jooq.Record3;
import org.jspecify.annotations.Nullable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Connections, blocks, reports and connecting in person ({@code routes/social.py}). A block is
 * the action with the most effects (JAVA-BACKEND.md §8, Effetti a catena): all in one
 * transaction, the frames and the news to the presence after it.
 */
@RestController
@RequestMapping("/v1")
public class SocialController {

    static final int CONNECTIONS_MAX = 5000;
    static final int BLOCKS_MAX = 5000;
    static final double MAX_DISTANCE = 100;
    static final Duration LOCATION_MAX_AGE = Duration.ofMinutes(2);
    /** The most a phone's accuracy widens the distance: it comes from the phone. */
    static final double MAX_CLAIMED_ACCURACY = 100;
    static final double MEETING_DISTANCE = 150;
    static final Map<String, Set<String>> REPORT_REASONS = Map.of(
            "user", Set.of("harassment", "hate", "threat", "sexual", "impersonation", "spam", "minor", "other"),
            "event", Set.of("offensive content", "inappropriate content", "not an event"),
            "photo", Set.of("shows_me", "inappropriate", "harassment", "unrelated"),
            "message", Set.of("harassment", "hate", "threat", "sexual", "spam", "other"),
            "group", Set.of("harassment", "hate", "threat", "sexual", "spam", "other"));

    private final Database db;
    private final People people;
    private final Chats chats;
    private final EventsController events;
    private final EventNotifier notifier;
    private final Presence presence;
    private final ConnectSessions sessions;
    private final Outbox outbox;
    private final Limits limits;
    private final InstantSource clock;

    public SocialController(Database db, People people, Chats chats, EventsController events, EventNotifier notifier, Presence presence,
                            ConnectSessions sessions, Outbox outbox, Limits limits, InstantSource clock) {
        this.db = db;
        this.people = people;
        this.chats = chats;
        this.events = events;
        this.notifier = notifier;
        this.presence = presence;
        this.sessions = sessions;
        this.outbox = outbox;
        this.limits = limits;
        this.clock = clock;
    }

    // --- connections ---

    @GetMapping("/me/connections")
    public Map<String, Object> connections(Viewer viewer) {
        return db.read(ctx -> {
            List<Record3<UUID, Instant, String>> rows = ctx.select(CONNECTIONS.OTHER_ID, CONNECTIONS.SINCE, CONNECTIONS.PLACE).from(CONNECTIONS)
                    .where(CONNECTIONS.USER_ID.eq(viewer.id())).orderBy(CONNECTIONS.SINCE.desc()).fetch();
            Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, rows.stream().map(Record3::value1).toList());
            List<Map<String, Object>> items = new ArrayList<>();
            for (Record3<UUID, Instant, String> row : rows) {
                Views.UserSummary user = summaries.get(row.value1());
                if (user != null) items.add(connection(user, row.value2(), row.value3()));
            }
            return Map.of("items", items);
        });
    }

    static Map<String, Object> connection(Views.UserSummary user, Instant since, @Nullable String place) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("user", user);
        view.put("since", since);
        view.put("place", place);
        return view;
    }

    /** Disconnect: no messages until they connect again in person; they are not told in words. */
    @DeleteMapping("/me/connections/{userId}")
    public ResponseEntity<Void> disconnect(Viewer viewer, @PathVariable String userId) {
        UUID other = People.id(userId);
        db.txRun(ctx -> {
            Database.lockPeople(ctx, viewer.id(), other);
            if (!Relations.connected(ctx, viewer.id(), other)) throw ApiError.notFound("not connected");
            unconnect(ctx, viewer.id(), other);
            chats.leaveOwnGroups(ctx, viewer.id(), other);
            told(ctx, viewer.id(), other);
        });
        return ResponseEntity.noContent().build();
    }

    private static void unconnect(DSLContext ctx, UUID a, UUID b) {
        ctx.deleteFrom(CONNECTIONS).where(CONNECTIONS.USER_ID.eq(a).and(CONNECTIONS.OTHER_ID.eq(b))
                .or(CONNECTIONS.USER_ID.eq(b).and(CONNECTIONS.OTHER_ID.eq(a)))).execute();
        Relations.markDisconnected(ctx, a, b);
    }

    /** Both phones at once: no more connection, and their direct chat can no longer be written in. */
    private void told(DSLContext ctx, UUID a, UUID b) {
        outbox.send(a, Map.of("type", "connection.removed", "userId", Ids.publicId("usr", b)));
        outbox.send(b, Map.of("type", "connection.removed", "userId", Ids.publicId("usr", a)));
        ChatsRecord direct = Chats.direct(ctx, a, b);
        if (direct != null) chats.push(ctx, direct.getId(), List.of(a, b));
        outbox.afterCommit(() -> presence.relationChanged(a, b));
    }

    // --- blocks ---

    @GetMapping("/me/blocks")
    public Map<String, Object> blocks(Viewer viewer) {
        return db.read(ctx -> {
            var rows = ctx.select(BLOCKS.BLOCKED, BLOCKS.SINCE).from(BLOCKS).where(BLOCKS.BLOCKER.eq(viewer.id())).orderBy(BLOCKS.SINCE.desc()).fetch();
            Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, rows.stream().map(row -> row.value1()).toList());
            List<Map<String, Object>> items = new ArrayList<>();
            for (var row : rows) {
                Views.UserSummary user = summaries.get(row.value1());
                if (user == null) continue;
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("user", user);
                item.put("since", row.value2());
                items.add(item);
            }
            return Map.of("items", items);
        });
    }

    @PutMapping("/me/blocks/{userId}")
    public ResponseEntity<Void> block(Viewer viewer, @PathVariable String userId) {
        UUID other = People.id(userId);
        if (other.equals(viewer.id())) throw ApiError.notFound("user not found");
        Instant now = clock.instant();
        db.txRun(ctx -> {
            People.requireExists(ctx, other);
            limits.check(viewer.id(), Limits.Action.BLOCK);
            Database.lockPeople(ctx, viewer.id(), other);
            if (!Relations.blocks(ctx, viewer.id(), other) && ctx.fetchCount(BLOCKS, BLOCKS.BLOCKER.eq(viewer.id())) >= BLOCKS_MAX) {
                throw ApiError.conflict("too_many_blocks", "you have blocked as many people as one can");
            }
            ctx.insertInto(BLOCKS).set(BLOCKS.BLOCKER, viewer.id()).set(BLOCKS.BLOCKED, other).set(BLOCKS.SINCE, now).onConflictDoNothing().execute();
            if (Relations.connected(ctx, viewer.id(), other)) {
                outbox.send(other, Map.of("type", "connection.removed", "userId", viewer.publicId()));
            }
            unconnect(ctx, viewer.id(), other);
            // Both ways: whoever blocks the owner of a group leaves it, or they would go on
            // writing to the others unseen by who runs it
            chats.leaveOwnGroups(ctx, viewer.id(), other);
            chats.leaveOwnGroups(ctx, other, viewer.id());
            ChatsRecord direct = Chats.direct(ctx, viewer.id(), other);
            if (direct != null) {
                chats.removed(viewer.id(), direct);
                chats.removed(other, direct);
            }
            // Neither is at the other's events any more, and those leave their lists and maps
            endSharedEvents(ctx, viewer.id(), other, now);
            notifier.stale(Set.of(viewer.id(), other));
            outbox.afterCommit(() -> presence.relationChanged(viewer.id(), other));
        });
        return ResponseEntity.noContent().build();
    }

    /** Two people blocked each other: neither stays at the other's events that are not over. */
    private void endSharedEvents(DSLContext ctx, UUID a, UUID b, Instant now) {
        for (UUID[] pair : new UUID[][] {{a, b}, {b, a}}) {
            for (EventsRecord event : ctx.selectFrom(EVENTS).where(EVENTS.CREATOR_ID.eq(pair[0])).and(EVENTS.CANCELLED_AT.isNull())
                    .and(EVENTS.ENDS_AT.gt(now)).and(EVENTS.ID.in(ctx.select(EVENT_ATTENDEES.EVENT_ID).from(EVENT_ATTENDEES)
                            .where(EVENT_ATTENDEES.USER_ID.eq(pair[1])))).fetch()) {
                events.leave(ctx, event, pair[1], null, now);
            }
        }
    }

    @DeleteMapping("/me/blocks/{userId}")
    public ResponseEntity<Void> unblock(Viewer viewer, @PathVariable String userId) {
        UUID other = People.id(userId);
        limits.check(viewer.id(), Limits.Action.BLOCK);
        db.txRun(ctx -> {
            ctx.deleteFrom(BLOCKS).where(BLOCKS.BLOCKER.eq(viewer.id())).and(BLOCKS.BLOCKED.eq(other)).execute();
            // Unblocking does not reconnect: that is done in person again
            if (People.exists(ctx, other)) Relations.markDisconnected(ctx, viewer.id(), other);
            notifier.stale(Set.of(viewer.id(), other));
            outbox.afterCommit(() -> presence.relationChanged(viewer.id(), other));
        });
        return ResponseEntity.noContent().build();
    }

    // --- reports ---

    @PostMapping("/reports")
    public ResponseEntity<Map<String, Object>> report(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        String kind = body.string("kind");
        String target = body.string("targetId");
        if (kind == null || !REPORT_REASONS.containsKey(kind) || target == null || target.isEmpty() || target.length() > 200) {
            throw ApiError.badRequest("kind and targetId are needed");
        }
        Set<String> allowed = REPORT_REASONS.get(kind);
        List<String> reasons;
        try {
            reasons = body.strings("reasons", 10);
        } catch (ApiError error) {
            reasons = null;
        }
        if (allowed == null || reasons == null || reasons.isEmpty() || !allowed.containsAll(reasons)) {
            throw ApiError.badRequest("unknown reasons", List.copyOf(new TreeSet<>(allowed == null ? Set.of() : allowed)));
        }
        String details = body.string("details");
        if (details != null && Text.length(details) > 500) throw ApiError.badRequest("details: at most 500 characters");
        String eventText = body.string("eventId");
        List<String> chosen = reasons;
        UUID id = Ids.next();
        Instant now = clock.instant();
        db.txRun(ctx -> {
            ObjectNode snapshot = snapshot(ctx, kind, target, eventText, viewer.id());
            limits.check(viewer.id(), Limits.Action.REPORT);
            UUID event = eventText == null ? null : Ids.parse("ev", eventText).orElse(null);
            ctx.insertInto(REPORTS).set(REPORTS.ID, id).set(REPORTS.BY_USER, viewer.id()).set(REPORTS.SNAPSHOT, JSONB.valueOf(Json.text(snapshot)))
                    .set(REPORTS.KIND, kind).set(REPORTS.TARGET_ID, target).set(REPORTS.EVENT_ID, event)
                    .set(REPORTS.REASONS, chosen.toArray(String[]::new)).set(REPORTS.DETAILS, details == null ? null : Text.plain(details))
                    .set(REPORTS.AT, now).execute();
        });
        return ResponseEntity.status(HttpStatus.CREATED).body(Map.of("id", Ids.publicId("rep", id)));
    }

    /**
     * What is reported as it is now, kept with the report: it may be changed or gone by the time
     * someone reads it. 404 for what does not exist, or the user could not have seen.
     */
    private ObjectNode snapshot(DSLContext ctx, String kind, String target, @Nullable String eventText, UUID viewer) {
        ObjectNode snapshot = Json.object();
        switch (kind) {
            case "user" -> {
                UsersRecord user = Ids.parse("usr", target).map(id -> ctx.selectFrom(USERS).where(USERS.ID.eq(id)).fetchOne()).orElse(null);
                if (user == null) break;
                snapshot.put("name", user.getName());
                snapshot.put("username", user.getUsername());
                snapshot.put("bio", user.getBio());
                snapshot.put("picture", user.getPictureKey());
                return snapshot;
            }
            case "event" -> {
                EventsRecord event = Ids.parse("ev", target).map(id -> ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).fetchOne()).orElse(null);
                if (event == null) break;
                snapshot.put("title", event.getTitle());
                snapshot.put("description", event.getDescription());
                snapshot.put("creator", event.getCreatorId().toString());
                var images = snapshot.putArray("images");
                for (String key : event.getImageKeys()) images.add(key);
                return snapshot;
            }
            case "photo" -> {
                Optional<UUID> event = eventText == null ? Optional.empty() : Ids.parse("ev", eventText);
                Optional<UUID> photo = Ids.parse("ph", target);
                if (event.isEmpty() || photo.isEmpty()) break;
                EventPhotosRecord found = ctx.selectFrom(EVENT_PHOTOS).where(EVENT_PHOTOS.ID.eq(photo.get())).and(EVENT_PHOTOS.EVENT_ID.eq(event.get())).fetchOne();
                if (found == null) break;
                snapshot.put("key", found.getKey());
                snapshot.put("author", found.getAuthorId().toString());
                return snapshot;
            }
            case "message" -> {
                Optional<UUID> message = Ids.parse("msg", target);
                if (message.isEmpty()) break;
                // Only in the chats of who reports: the key of the partitions, never a scan of all
                MessagesRecord found = ctx.selectFrom(MESSAGES).where(MESSAGES.ID.eq(message.get()))
                        .and(MESSAGES.CHAT_ID.in(ctx.select(CHAT_MEMBERS.CHAT_ID).from(CHAT_MEMBERS).where(CHAT_MEMBERS.USER_ID.eq(viewer)))).fetchOne();
                if (found == null || (found.getSender() != null && Relations.blockedEither(ctx, viewer, found.getSender()))) break;
                ChatsRecord chat = ctx.selectFrom(CHATS).where(CHATS.ID.eq(found.getChatId())).fetchOne();
                if (chat == null || chats.summary(ctx, chat, viewer) == null) break;
                snapshot.put("chatId", Chats.publicId(chat));
                snapshot.put("text", found.getText());
                snapshot.put("author", found.getSender() == null ? null : found.getSender().toString());
                snapshot.put("at", Json.time(found.getAt()));
                return snapshot;
            }
            case "group" -> {
                Optional<UUID> group = Ids.parse("chat", target);
                if (group.isEmpty()) break;
                ChatsRecord chat = ctx.selectFrom(CHATS).where(CHATS.ID.eq(group.get())).and(CHATS.KIND.eq("group")).fetchOne();
                if (chat == null || Chats.member(ctx, chat.getId(), viewer) == null) break;
                snapshot.put("title", chat.getTitle());
                snapshot.put("picture", chat.getPictureKey());
                snapshot.put("owner", chat.getOwnerId() == null ? null : chat.getOwnerId().toString());
                return snapshot;
            }
            default -> {
            }
        }
        throw ApiError.notFound("nothing to report");
    }

    // --- connecting in person ---

    @PostMapping("/connections/sessions")
    public Map<String, Object> startSession(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        limits.check(viewer.id(), Limits.Action.CONNECT_SESSION);
        String id = sessions.open(viewer.id());
        ConnectSessions.Issued issued = sessions.issue(id, body.raw("location"));
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("sessionId", id);
        answer.put("token", issued.token());
        answer.put("expiresAt", issued.expires());
        return answer;
    }

    @PostMapping("/connections/sessions/{sessionId}/token")
    public Map<String, Object> rotate(Viewer viewer, @PathVariable String sessionId, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        ConnectSessions.Session session = sessions.own(sessionId, viewer.id());
        if (session == null) throw ApiError.notFound("session not found");
        if (!"waiting".equals(session.status)) throw ApiError.gone("expired", "the session is over");
        limits.check(viewer.id(), Limits.Action.CONNECT_TOKEN);
        ConnectSessions.Issued issued = sessions.issue(sessionId, body.raw("location"));
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("token", issued.token());
        answer.put("expiresAt", issued.expires());
        return answer;
    }

    @GetMapping("/connections/sessions/{sessionId}")
    public Map<String, Object> session(Viewer viewer, @PathVariable String sessionId) {
        ConnectSessions.Session session = sessions.own(sessionId, viewer.id());
        if (session == null) throw ApiError.notFound("session not found");
        UUID guest = session.guest;
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("status", session.status);
        answer.put("user", guest == null ? null : db.read(ctx -> people.summary(ctx, guest)));
        return answer;
    }

    @DeleteMapping("/connections/sessions/{sessionId}")
    public ResponseEntity<Void> closeSession(Viewer viewer, @PathVariable String sessionId) {
        if (sessions.own(sessionId, viewer.id()) == null) throw ApiError.notFound("session not found");
        sessions.close(sessionId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/connections/claims")
    public Map<String, Object> claim(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        limits.check(viewer.id(), Limits.Action.CONNECT_CLAIM);
        String token = body.string("token");
        if (token == null) throw ApiError.badRequest("a token is needed");
        ConnectSessions.Token entry = sessions.take(token);
        if (entry == null || entry.expires().isBefore(clock.instant())) throw ApiError.gone("expired", "the code expired");
        ConnectSessions.Session session = sessions.session(entry.session());
        if (session == null || !"waiting".equals(session.status)) throw ApiError.gone("expired", "the code expired");
        UUID host = session.host;
        if (host.equals(viewer.id())) throw ApiError.forbidden("self", "this is your own code");
        JsonNode guestLocation = body.raw("location");
        // The network first: where the presence last saw each of them, and whether the places are possible
        boolean far = tooFar(host, viewer.id(), session.location, guestLocation);
        Point hostAt = where(host, session.location), guestAt = where(viewer.id(), guestLocation);
        Instant now = clock.instant();
        Map<String, Object> answer = db.tx(ctx -> {
            // The account was deleted a moment ago: its codes died with it
            if (!People.exists(ctx, host)) throw ApiError.gone("expired", "the code expired");
            Database.lockPeople(ctx, host, viewer.id());
            if (Relations.blockedEither(ctx, host, viewer.id())) throw ApiError.forbidden("blocked", "you cannot connect");
            if (Relations.connected(ctx, host, viewer.id())) throw ApiError.conflict("already", "already connected");
            if (far) throw ApiError.forbidden("too_far", "you need to be together");
            int most = Math.max(ctx.fetchCount(CONNECTIONS, CONNECTIONS.USER_ID.eq(host)), ctx.fetchCount(CONNECTIONS, CONNECTIONS.USER_ID.eq(viewer.id())));
            if (most >= CONNECTIONS_MAX) throw ApiError.conflict("too_many_connections", "one of you has as many connections as one can");
            String place = meetingPlace(ctx, now, hostAt, guestAt);
            for (UUID[] pair : new UUID[][] {{host, viewer.id()}, {viewer.id(), host}}) {
                ctx.insertInto(CONNECTIONS).set(CONNECTIONS.USER_ID, pair[0]).set(CONNECTIONS.OTHER_ID, pair[1]).set(CONNECTIONS.SINCE, now)
                        .set(CONNECTIONS.PLACE, place).execute();
            }
            ctx.deleteFrom(DISCONNECTED_PAIRS).where(DISCONNECTED_PAIRS.A.eq(Ids.low(host, viewer.id())))
                    .and(DISCONNECTED_PAIRS.B.eq(Ids.high(host, viewer.id()))).execute();
            Map<UUID, Views.UserSummary> both = people.summaries(ctx, List.of(host, viewer.id()));
            Views.UserSummary hostSummary = both.get(host), guestSummary = both.get(viewer.id());
            if (hostSummary == null || guestSummary == null) throw ApiError.gone("expired", "the code expired");
            outbox.send(host, Map.of("type", "connection.created", "connection", connection(guestSummary, now, place)));
            outbox.send(viewer.id(), Map.of("type", "connection.created", "connection", connection(hostSummary, now, place)));
            // A direct chat with them may now be written
            ChatsRecord direct = Chats.direct(ctx, host, viewer.id());
            if (direct != null) chats.push(ctx, direct.getId(), List.of(host, viewer.id()));
            outbox.afterCommit(() -> presence.relationChanged(host, viewer.id()));
            Map<String, Object> made = new LinkedHashMap<>();
            made.put("status", "connected");
            made.put("user", hostSummary);
            return made;
        });
        sessions.connected(entry.session(), viewer.id());
        return answer;
    }

    /**
     * Connecting is in person (social._too_far): refused on a fake position or one the user cannot
     * be at, and when both are known and more than 100 m apart beyond their accuracy. A phone with
     * no position at all is not stopped: nobody gets an extra step for it.
     */
    private boolean tooFar(UUID host, UUID guest, @Nullable JsonNode hostLocation, @Nullable JsonNode guestLocation) {
        for (Object[] side : new Object[][] {{hostLocation, host}, {guestLocation, guest}}) {
            JsonNode location = (JsonNode) side[0];
            UUID user = (UUID) side[1];
            if (location != null && location.isObject() && location.has("mocked") && location.get("mocked").isBoolean()
                    && location.get("mocked").booleanValue()) return true;
            Point point = point(location);
            if (point != null && Boolean.FALSE.equals(ask(() -> presence.plausible(user, point).get(200, TimeUnit.MILLISECONDS)))) return true;
        }
        // The position sent if it is recent, else where the map last saw the user, else nothing
        Point sentA = recent(hostLocation), sentB = recent(guestLocation);
        Point a = sentA != null ? sentA : seen(host), b = sentB != null ? sentB : seen(guest);
        if (a == null || b == null) return false;
        double metres = Geo.distance(a.latitude(), a.longitude(), b.latitude(), b.longitude());
        return metres - accuracy(hostLocation, sentA != null) - accuracy(guestLocation, sentB != null) > MAX_DISTANCE;
    }

    private @Nullable Point recent(@Nullable JsonNode location) {
        Point sent = point(location);
        if (sent == null || location == null) return null;
        JsonNode at = location.get("timestamp");
        return at != null && at.isNumber() && clock.instant().toEpochMilli() - at.longValue() <= LOCATION_MAX_AGE.toMillis() ? sent : null;
    }

    private @Nullable Point seen(UUID user) {
        Optional<Point> seen = ask(() -> presence.position(user).get(200, TimeUnit.MILLISECONDS));
        return seen == null ? null : seen.orElse(null);
    }

    /** A location sent with the request, else where the map last saw the user (the meeting place). */
    private @Nullable Point where(UUID user, @Nullable JsonNode location) {
        Point sent = point(location);
        if (sent != null) return sent;
        Optional<Point> seen = ask(() -> presence.position(user).get(200, TimeUnit.MILLISECONDS));
        return seen == null ? null : seen.orElse(null);
    }

    private static double accuracy(@Nullable JsonNode location, boolean fromPhone) {
        if (!fromPhone || location == null) return 0;
        JsonNode accuracy = location.get("accuracy");
        return accuracy != null && accuracy.isNumber() && accuracy.doubleValue() > 0 ? Math.min(accuracy.doubleValue(), MAX_CLAIMED_ACCURACY) : 0;
    }

    static @Nullable Point point(@Nullable JsonNode location) {
        if (location == null || !location.isObject()) return null;
        JsonNode lat = location.get("latitude"), lon = location.get("longitude");
        if (lat == null || lon == null || !lat.isNumber() || !lon.isNumber()) return null;
        double a = lat.doubleValue(), b = lon.doubleValue();
        return a >= -90 && a <= 90 && b >= -180 && b <= 180 ? new Point(a, b) : null;
    }

    /** Where two people met: the event happening right where they are, if any (150 m). */
    static @Nullable String meetingPlace(DSLContext ctx, Instant now, @Nullable Point... points) {
        String best = null;
        double nearest = MEETING_DISTANCE;
        for (Point point : points) {
            if (point == null) continue;
            var row = ctx.fetchOne("SELECT title, ST_Distance(location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography) AS d FROM events"
                            + " WHERE cancelled_at IS NULL AND starts_at <= CAST(? AS timestamptz) AND ends_at > CAST(? AS timestamptz)"
                            + " AND ST_DWithin(location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?) ORDER BY d LIMIT 1",
                    point.longitude(), point.latitude(), java.time.OffsetDateTime.ofInstant(now, java.time.ZoneOffset.UTC),
                    java.time.OffsetDateTime.ofInstant(now, java.time.ZoneOffset.UTC), point.longitude(), point.latitude(), MEETING_DISTANCE);
            if (row != null && row.get(1, Double.class) <= nearest) {
                nearest = row.get(1, Double.class);
                best = row.get(0, String.class);
            }
        }
        return best;
    }

    private interface Question<T> {
        T get() throws Exception;
    }

    private static <T> @Nullable T ask(Question<T> question) {
        try {
            return question.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception error) {
            return null;
        }
    }
}
