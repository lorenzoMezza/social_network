// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.events;

import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.CHAT_MEMBERS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.EVENT_BANS;
import static masterkey.store.db.Tables.EVENT_RATINGS;
import static masterkey.store.db.Tables.EVENT_SAVED;
import static masterkey.store.db.Tables.IDEMPOTENCY_KEYS;
import static masterkey.store.db.Tables.SAVED_HIDDEN;
import static masterkey.store.db.Tables.USERS;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import masterkey.api.Limits;
import masterkey.api.common.ChatPush;
import masterkey.api.common.Outbox;
import masterkey.api.common.Relations;
import masterkey.api.notifications.Notifications;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Point;
import masterkey.core.Text;
import masterkey.core.Times;
import masterkey.presence.Presence;
import masterkey.store.Database;
import masterkey.store.db.tables.records.EventRatingsRecord;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.api.money.Promotions;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;
import org.jspecify.annotations.Nullable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/** Events (API.md, Events; {@code routes/events.py}). Albums and pictures are in {@code AlbumsController}. */
@RestController
@RequestMapping("/v1")
public class EventsController {

    public static final Set<String> CATEGORIES = Set.of(
            "sales", "social", "free entry", "food", "drinks", "relaxing", "sports", "exposition", "games", "music",
            "shopping", "clothes", "technology", "festival", "festivities", "party", "competitive", "convention");
    /** Only HTTPS, as the app opens only those. */
    static final Pattern LINK = Pattern.compile("https://[^\\s/$.?#][^\\s]*\\.[^\\s]+", Pattern.CASE_INSENSITIVE);
    static final Pattern NUMBER = Pattern.compile("[-+]?[0-9]{1,3}(\\.[0-9]{1,15})?");
    static final Pattern INTEGER = Pattern.compile("[0-9]{1,6}");
    static final long MINUTE = 60_000L;
    static final long DAY = 24 * 60 * MINUTE;
    static final int MAX_RANGE = 10_000;
    /** Room between events: two are never drawn on top of each other. */
    static final double MIN_SPACING = 15;
    static final double FLASH_MAX_DISTANCE = 500;
    static final int MAX_ACTIVE = 5;
    static final int MAX_DAYS_AHEAD = 31;
    static final int MAX_DAYS_LONG = 31;
    static final int OWN_LIST_MAX = 500;
    static final int JOINED_MAX = 200;
    static final int SAVED_MAX = 1000;
    static final int LIST_MAX = 200;

    private final Database db;
    private final EventViews views;
    private final EventNotifier notifier;
    private final Notifications notifications;
    private final Presence presence;
    private final ChatPush chats;
    private final Outbox outbox;
    private final Limits limits;
    private final InstantSource clock;
    private final masterkey.api.common.People people;
    private final Images images;
    private final masterkey.api.media.Uploads uploads;
    /** The public part of a search, by point, range and categories: ids nearest first, for 15 s (§4.8). */
    private final Cache<String, List<UUID>> searches = Caffeine.newBuilder().maximumSize(50_000).expireAfterWrite(Duration.ofSeconds(15)).build();

    public EventsController(Database db, EventViews views, EventNotifier notifier, Notifications notifications, Presence presence,
                            ChatPush chats, Outbox outbox, Limits limits, InstantSource clock, masterkey.api.common.People people,
                            Images images, masterkey.api.media.Uploads uploads) {
        this.uploads = uploads;
        this.people = people;
        this.images = images;
        this.db = db;
        this.views = views;
        this.notifier = notifier;
        this.notifications = notifications;
        this.presence = presence;
        this.chats = chats;
        this.outbox = outbox;
        this.limits = limits;
        this.clock = clock;
    }

    // --- reading ---

    @GetMapping("/events")
    public Map<String, Object> nearby(Viewer viewer, @RequestParam(required = false) @Nullable String latitude,
                                      @RequestParam(required = false) @Nullable String longitude,
                                      @RequestParam(required = false) @Nullable String range,
                                      @RequestParam(required = false) @Nullable List<String> categories) {
        double lat = coordinate(latitude, "latitude"), lon = coordinate(longitude, "longitude");
        if (!(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) throw ApiError.badRequest("position out of range");
        int asked = range == null ? 2000 : integer(range, "range");
        int radius = Math.max(100, Math.min(asked, MAX_RANGE));
        TreeSet<String> wanted = new TreeSet<>(categories == null ? List.of() : categories);
        TreeSet<String> unknown = new TreeSet<>(wanted);
        unknown.removeAll(CATEGORIES);
        if (!unknown.isEmpty()) throw ApiError.badRequest("unknown categories", List.copyOf(unknown));
        // An event is seen within its reach: asking from anywhere would make reach mean nothing
        Point point = new Point(lat, lon);
        Boolean plausible = ask(() -> presence.searchedEvents(viewer.id(), point, radius).get(200, TimeUnit.MILLISECONDS));
        if (Boolean.FALSE.equals(plausible)) throw ApiError.conflict("position_rejected", "this position is not possible");
        Instant now = clock.instant();
        String key = lat + "|" + lon + "|" + radius + "|" + String.join(",", wanted);
        List<UUID> ids = searches.get(key, k -> db.read(ctx -> search(ctx, lat, lon, radius, wanted, now)));
        return db.read(ctx -> {
            Set<UUID> blocked = Relations.blockedWith(ctx, viewer.id());
            Map<UUID, EventsRecord> rows = new HashMap<>();
            for (EventsRecord event : ctx.selectFrom(EVENTS).where(EVENTS.ID.in(ids)).fetch()) rows.put(event.getId(), event);
            List<EventsRecord> shown = new ArrayList<>();
            for (UUID id : ids) {
                EventsRecord event = rows.get(id);
                if (event != null && !blocked.contains(event.getCreatorId())) shown.add(event);
            }
            return Map.of("items", views.summaries(ctx, viewer.id(), shown, now));
        });
    }

    /**
     * Events within their reach and within the range asked, nearest first, at most 200: the
     * normal ones (reach ≤ 800 m) and the promoted ones (their own table and index), merged.
     */
    static List<UUID> search(DSLContext ctx, double lat, double lon, int radius, Set<String> categories, Instant now) {
        String[] wanted = categories.toArray(String[]::new);
        // Typed binds: in plain SQL an Instant would go as text
        var ended = java.time.OffsetDateTime.ofInstant(now.minus(Duration.ofDays(1)), java.time.ZoneOffset.UTC);
        var at = java.time.OffsetDateTime.ofInstant(now, java.time.ZoneOffset.UTC);
        String point = "ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography";
        var normal = ctx.fetch("SELECT id, ST_Distance(location, " + point + ") AS d FROM events"
                        + " WHERE cancelled_at IS NULL AND ends_at > CAST(? AS timestamptz) AND ST_DWithin(location, " + point + ", LEAST(?, 800))"
                        + " AND ST_Distance(location, " + point + ") <= LEAST(?, CASE WHEN flash THEN 800 ELSE reach END)"
                        + " AND (cardinality(?::text[]) = 0 OR categories && ?::text[])",
                lon, lat, ended, lon, lat, radius, lon, lat, radius, wanted, wanted);
        var promoted = ctx.fetch("SELECT e.id, ST_Distance(p.location, " + point + ") AS d FROM promotions p JOIN events e ON e.id = p.event_id"
                        + " WHERE p.status IN ('live', 'stopped') AND p.paid_until > CAST(? AS timestamptz) AND e.cancelled_at IS NULL"
                        + " AND e.ends_at > CAST(? AS timestamptz) AND NOT e.flash"
                        + " AND ST_DWithin(p.location, " + point + ", LEAST(?, 10000)) AND ST_Distance(p.location, " + point + ") <= LEAST(p.radius, ?)"
                        + " AND (cardinality(?::text[]) = 0 OR e.categories && ?::text[])",
                lon, lat, at, at, lon, lat, radius, lon, lat, radius, wanted, wanted);
        Map<UUID, Double> distance = new HashMap<>();
        for (var row : normal) distance.merge(row.get(0, UUID.class), row.get(1, Double.class), Math::min);
        for (var row : promoted) distance.merge(row.get(0, UUID.class), row.get(1, Double.class), Math::min);
        List<Map.Entry<UUID, Double>> sorted = new ArrayList<>(distance.entrySet());
        sorted.sort(Map.Entry.comparingByValue());
        List<UUID> ids = new ArrayList<>();
        for (int i = 0; i < Math.min(LIST_MAX, sorted.size()); i++) ids.add(sorted.get(i).getKey());
        return ids;
    }

    @GetMapping("/me/events")
    public Map<String, Object> mine(Viewer viewer) {
        Instant now = clock.instant();
        return db.read(ctx -> {
            Set<UUID> blocked = Relations.blockedWith(ctx, viewer.id());
            var hidden = ctx.select(SAVED_HIDDEN.EVENT_ID).from(SAVED_HIDDEN).where(SAVED_HIDDEN.USER_ID.eq(viewer.id()));
            List<EventsRecord> followed = ctx.selectFrom(EVENTS)
                    .where(EVENTS.CREATOR_ID.ne(viewer.id()))
                    .and(EVENTS.ID.in(ctx.select(EVENT_SAVED.EVENT_ID).from(EVENT_SAVED).where(EVENT_SAVED.USER_ID.eq(viewer.id())))
                            .or(EVENTS.ID.in(ctx.select(EVENT_ATTENDEES.EVENT_ID).from(EVENT_ATTENDEES).where(EVENT_ATTENDEES.USER_ID.eq(viewer.id())))))
                    .and(EVENTS.ID.notIn(hidden))
                    .orderBy(EVENTS.STARTS_AT.desc()).limit(OWN_LIST_MAX).fetch();
            followed.removeIf(event -> blocked.contains(event.getCreatorId()));
            List<EventsRecord> created = ctx.selectFrom(EVENTS).where(EVENTS.CREATOR_ID.eq(viewer.id())).and(EVENTS.ID.notIn(hidden))
                    .orderBy(EVENTS.STARTS_AT.desc()).limit(OWN_LIST_MAX).fetch();
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("followed", views.summaries(ctx, viewer.id(), reversed(followed), now));
            answer.put("created", views.summaries(ctx, viewer.id(), reversed(created), now));
            return answer;
        });
    }

    @GetMapping("/events/{eventId}")
    public Map<String, Object> detail(Viewer viewer, @PathVariable String eventId) {
        UUID id = id(eventId);
        return db.read(ctx -> views.detail(ctx, viewer.id(), visible(ctx, id, viewer.id(), false), clock.instant()));
    }

    // --- making and changing ---

    @PostMapping("/events")
    public ResponseEntity<Map<String, Object>> create(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw,
                                                      @RequestHeader(value = "Idempotency-Key", required = false) @Nullable String key) {
        if (key != null && (key.isEmpty() || key.length() > 64)) throw ApiError.badRequest("Idempotency-Key: at most 64 characters");
        Body body = Body.of(raw);
        Instant now = clock.instant();
        // Sent again after a lost answer: the event made the first time, as it is now
        if (key != null) {
            Map<String, Object> made = db.read(ctx -> again(ctx, viewer.id(), key, now));
            if (made != null) return ResponseEntity.status(HttpStatus.CREATED).body(made);
        }
        limits.check(viewer.id(), Limits.Action.EVENT);
        Draft draft = Draft.fresh(viewer.id(), now);
        draft.apply(body, true, now);
        // The network first: where the organizer is, for a flash event
        if (draft.flash) flashNear(viewer.id(), draft, body);
        UUID event = Ids.next();
        Map<String, Object> answer = db.tx(ctx -> {
            Database.lockPerson(ctx, viewer.id());
            if (key != null) {
                Map<String, Object> made = again(ctx, viewer.id(), key, now);
                if (made != null) return made;
            }
            checkActive(ctx, viewer.id(), null, draft, now);
            checkRoom(ctx, null, draft, now);
            EventsRecord row = ctx.newRecord(EVENTS);
            row.setId(event);
            row.setCreatorId(viewer.id());
            row.setCreatedAt(now);
            draft.into(row);
            row.insert();
            // Read again: the defaults of the schema (counters, empty arrays) are not on the record
            row = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(event)).fetchOne();
            if (row == null) throw ApiError.internal();
            // Its chat is the organizer's from now on
            UUID chat = Ids.next();
            ctx.insertInto(CHATS).set(CHATS.ID, chat).set(CHATS.KIND, "event").set(CHATS.EVENT_ID, event).set(CHATS.OWNER_ID, viewer.id())
                    .set(CHATS.MEMBER_COUNT, 1).set(CHATS.CREATED_AT, now).execute();
            ctx.insertInto(CHAT_MEMBERS).set(CHAT_MEMBERS.CHAT_ID, chat).set(CHAT_MEMBERS.USER_ID, viewer.id()).set(CHAT_MEMBERS.ROLE, "owner")
                    .set(CHAT_MEMBERS.JOINED_AT, now).execute();
            if (key != null) {
                ctx.insertInto(IDEMPOTENCY_KEYS).set(IDEMPOTENCY_KEYS.USER_ID, viewer.id()).set(IDEMPOTENCY_KEYS.SCOPE, "event")
                        .set(IDEMPOTENCY_KEYS.KEY, key).set(IDEMPOTENCY_KEYS.MADE_ID, event).set(IDEMPOTENCY_KEYS.AT, now).execute();
            }
            chats.push(ctx, chat, List.of(viewer.id()));
            notifier.changed(event, 0);
            return views.detail(ctx, viewer.id(), row, now);
        });
        return ResponseEntity.status(HttpStatus.CREATED).body(answer);
    }

    private @Nullable Map<String, Object> again(DSLContext ctx, UUID user, String key, Instant now) {
        UUID made = ctx.select(IDEMPOTENCY_KEYS.MADE_ID).from(IDEMPOTENCY_KEYS).where(IDEMPOTENCY_KEYS.USER_ID.eq(user))
                .and(IDEMPOTENCY_KEYS.SCOPE.eq("event")).and(IDEMPOTENCY_KEYS.KEY.eq(key)).fetchOne(IDEMPOTENCY_KEYS.MADE_ID);
        if (made == null) return null;
        EventsRecord event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(made)).fetchOne();
        return event == null ? null : views.detail(ctx, user, event, now);
    }

    @PatchMapping("/events/{eventId}")
    public Map<String, Object> modify(Viewer viewer, @PathVariable String eventId, @RequestBody(required = false) @Nullable JsonNode raw) {
        UUID id = id(eventId);
        Body body = Body.of(raw);
        Instant now = clock.instant();
        EventsRecord current = db.read(ctx -> own(ctx, id, viewer.id()));
        if (current.getCancelledAt() != null) throw ApiError.gone("gone", "the event was cancelled");
        // What took place stays as it took place
        if ("concluded".equals(EventViews.status(current, now))) throw ApiError.gone("gone", "the event is over");
        limits.check(viewer.id(), Limits.Action.EVENT_EDIT);
        Draft draft = Draft.of(current);
        draft.apply(body, false, now);
        boolean moved = draft.latitude != current.getLatitude() || draft.longitude != current.getLongitude();
        boolean timed = !draft.start.equals(current.getStartsAt()) || !draft.end.equals(current.getEndsAt());
        if (moved && draft.flash) flashNear(viewer.id(), draft, body);
        Images.Plan pictures = body.has("images") ? images.plan(body, current, viewer.id()) : null;
        try {
            return db.tx(ctx -> {
                Database.lockPerson(ctx, viewer.id());
                EventsRecord event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).forUpdate().fetchOne();
                if (event == null || event.getCancelledAt() != null) throw ApiError.gone("gone", "the event was cancelled");
                int reachBefore = Promotions.reachNow(event, Promotions.locked(ctx, id), now);
                if (moved || timed) checkRoom(ctx, id, draft, now);
                List<String> changes = new ArrayList<>();
                if (timed) changes.add("time");
                if (moved || !java.util.Objects.equals(draft.address, event.getAddress())) changes.add("place");
                // Starting at another time: "starts soon" is said again for the new one
                if (!draft.start.equals(event.getStartsAt())) event.setStartingNotifiedFor(null);
                List<String> before = List.of(event.getImageKeys());
                draft.into(event);
                if (pictures != null) {
                    event.setImageKeys(pictures.keys().toArray(String[]::new));
                    for (var claimed : pictures.made()) masterkey.api.media.Uploads.finish(ctx, claimed.upload());
                    List<String> gone = new ArrayList<>(before);
                    gone.removeAll(pictures.keys());
                    uploads.discardAll(gone);
                }
                event.setModifiedAt(now);
                event.update();
                Promotions.changed(ctx, event, now);
                notifier.changed(id, reachBefore);
                if (!changes.isEmpty()) {
                    notifications.notifyGoing(ctx, event, "event.changed", viewer.id(), Map.of("changes", changes), List.of(), List.of());
                }
                return views.detail(ctx, viewer.id(), event, now);
            });
        } catch (RuntimeException error) {
            // A refused change changes nothing: the pictures just made go, their uploads can be named again
            if (pictures != null) for (var claimed : pictures.made()) uploads.abandon(claimed, false);
            throw error;
        }
    }

    @DeleteMapping("/events/{eventId}")
    public Map<String, Object> cancel(Viewer viewer, @PathVariable String eventId) {
        UUID id = id(eventId);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            own(ctx, id, viewer.id());
            EventsRecord event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).forUpdate().fetchOne();
            if (event == null) throw ApiError.notFound("event not found");
            if (event.getCancelledAt() == null) {
                if ("concluded".equals(EventViews.status(event, now))) throw ApiError.conflict("past_event", "this event is over");
                event.setCancelledAt(now);
                event.update();
                // The time paid can no longer be given: what was not used goes back to the wallet
                Promotions.cancelled(ctx, event, now);
                notifications.notifyGoing(ctx, event, "event.cancelled", viewer.id(), null, List.of(), List.of());
                notifier.changed(id, Promotions.MAX_RADIUS);
                Set<UUID> members = new LinkedHashSet<>();
                members.add(event.getCreatorId());
                members.addAll(attendees(ctx, id));
                outbox.send(members, Map.of("type", "chat.removed", "chatId", "event:" + EventViews.publicId(id)));
            }
            return views.detail(ctx, viewer.id(), event, now);
        });
    }

    // --- going, saved ---

    @PutMapping("/events/{eventId}/followers/me")
    public Map<String, Object> follow(Viewer viewer, @PathVariable String eventId) {
        UUID id = id(eventId);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            Database.lockPerson(ctx, viewer.id());
            EventsRecord event = visible(ctx, id, viewer.id(), true);
            if (event.getCancelledAt() != null) throw ApiError.gone("gone", "the event was cancelled");
            if (ctx.fetchExists(EVENT_BANS, EVENT_BANS.EVENT_ID.eq(id).and(EVENT_BANS.USER_ID.eq(viewer.id())))) {
                throw ApiError.forbidden("you were removed from this event");
            }
            boolean already = ctx.fetchExists(EVENT_ATTENDEES, EVENT_ATTENDEES.EVENT_ID.eq(id).and(EVENT_ATTENDEES.USER_ID.eq(viewer.id())));
            if (!already) {
                // Nobody joins what is over: it would say they went (and let them rate it)
                if ("concluded".equals(EventViews.status(event, now))) throw ApiError.gone("gone", "the event is over");
                boolean guest = !event.getCreatorId().equals(viewer.id());
                if (guest) {
                    // A flash event asks for so many people: then it has them (§7.3, one UPDATE)
                    int room = ctx.update(EVENTS).set(EVENTS.GUEST_COUNT, EVENTS.GUEST_COUNT.plus(1)).where(EVENTS.ID.eq(id))
                            .and(EVENTS.FLASH.isFalse().or(EVENTS.SPOTS_NEEDED.eq(0)).or(EVENTS.GUEST_COUNT.lt(EVENTS.SPOTS_NEEDED))).execute();
                    if (room == 0) throw ApiError.conflict("full", "everyone it was looking for has joined");
                }
                limits.check(viewer.id(), Limits.Action.JOIN);
                int joined = ctx.fetchCount(ctx.select(EVENT_ATTENDEES.EVENT_ID).from(EVENT_ATTENDEES).join(EVENTS).on(EVENTS.ID.eq(EVENT_ATTENDEES.EVENT_ID))
                        .where(EVENT_ATTENDEES.USER_ID.eq(viewer.id())).and(EVENTS.ENDS_AT.gt(now)).and(EVENTS.CANCELLED_AT.isNull()));
                if (joined >= JOINED_MAX) throw ApiError.conflict("too_many_joined", "at most " + JOINED_MAX + " events at a time");
                String audience = ctx.select(USERS.STORY_AUDIENCE).from(USERS).where(USERS.ID.eq(viewer.id())).fetchOne(USERS.STORY_AUDIENCE);
                ctx.insertInto(EVENT_ATTENDEES).set(EVENT_ATTENDEES.EVENT_ID, id).set(EVENT_ATTENDEES.USER_ID, viewer.id())
                        .set(EVENT_ATTENDEES.JOINED_AT, now).set(EVENT_ATTENDEES.PUBLIC, "everyone".equals(audience)).execute();
                ctx.update(EVENTS).set(EVENTS.FOLLOWER_COUNT, EVENTS.FOLLOWER_COUNT.plus(1)).where(EVENTS.ID.eq(id)).execute();
                UUID chat = eventChat(ctx, id);
                if (chat != null && guest) {
                    // What was said so far is there to read, not counted as new
                    Long counter = ctx.select(CHATS.COUNTER).from(CHATS).where(CHATS.ID.eq(chat)).fetchOne(CHATS.COUNTER);
                    ctx.insertInto(CHAT_MEMBERS).set(CHAT_MEMBERS.CHAT_ID, chat).set(CHAT_MEMBERS.USER_ID, viewer.id())
                            .set(CHAT_MEMBERS.READ_COUNTER, counter == null ? 0L : counter).set(CHAT_MEMBERS.JOINED_AT, now)
                            .onConflictDoNothing().execute();
                    ctx.update(CHATS).set(CHATS.MEMBER_COUNT, CHATS.MEMBER_COUNT.plus(1)).where(CHATS.ID.eq(chat)).execute();
                    chats.push(ctx, chat, List.of(viewer.id()));
                }
                event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).fetchOne();
                if (event == null) throw ApiError.notFound("event not found");
                notifications.notify(ctx, event.getCreatorId(), "event.joined", viewer.id(), event, null);
                spots(event);
            }
            // Back in the Saved list, if it was taken out of it
            ctx.deleteFrom(SAVED_HIDDEN).where(SAVED_HIDDEN.USER_ID.eq(viewer.id())).and(SAVED_HIDDEN.EVENT_ID.eq(id)).execute();
            Integer count = ctx.select(EVENTS.FOLLOWER_COUNT).from(EVENTS).where(EVENTS.ID.eq(id)).fetchOne(EVENTS.FOLLOWER_COUNT);
            return Map.<String, Object>of("following", true, "followerCount", count == null ? 0 : count);
        });
    }

    @DeleteMapping("/events/{eventId}/followers/me")
    public Map<String, Object> unfollow(Viewer viewer, @PathVariable String eventId) {
        UUID id = id(eventId);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            EventsRecord event = visible(ctx, id, viewer.id(), true);
            boolean going = ctx.fetchExists(EVENT_ATTENDEES, EVENT_ATTENDEES.EVENT_ID.eq(id).and(EVENT_ATTENDEES.USER_ID.eq(viewer.id())));
            if (going) {
                if (EventViews.tookPlace(event, now)) throw ApiError.conflict("past_event", "this event is over");
                limits.check(viewer.id(), Limits.Action.JOIN);
                leave(ctx, event, viewer.id(), null, now);
            }
            Integer count = ctx.select(EVENTS.FOLLOWER_COUNT).from(EVENTS).where(EVENTS.ID.eq(id)).fetchOne(EVENTS.FOLLOWER_COUNT);
            return Map.<String, Object>of("following", false, "followerCount", count == null ? 0 : count);
        });
    }

    /**
     * Out of an event ({@code domain.leave_chat} for an event): out of its people and its chat.
     * {@code removedBy}: an organizer or an admin took them out, for good. No message in the
     * chat with the name: it would tell everyone who was going.
     */
    public void leave(DSLContext ctx, EventsRecord event, UUID user, @Nullable UUID removedBy, Instant now) {
        UUID id = event.getId();
        int gone = ctx.deleteFrom(EVENT_ATTENDEES).where(EVENT_ATTENDEES.EVENT_ID.eq(id)).and(EVENT_ATTENDEES.USER_ID.eq(user)).execute();
        if (gone == 0) return;
        ctx.update(EVENTS).set(EVENTS.FOLLOWER_COUNT, EVENTS.FOLLOWER_COUNT.minus(1)).where(EVENTS.ID.eq(id)).execute();
        boolean guest = !event.getCreatorId().equals(user);
        if (guest) {
            ctx.update(EVENTS).set(EVENTS.GUEST_COUNT, DSL.greatest(EVENTS.GUEST_COUNT.minus(1), DSL.inline(0))).where(EVENTS.ID.eq(id)).execute();
            UUID chat = eventChat(ctx, id);
            if (chat != null) {
                int left = ctx.deleteFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat)).and(CHAT_MEMBERS.USER_ID.eq(user)).execute();
                if (left > 0) ctx.update(CHATS).set(CHATS.MEMBER_COUNT, CHATS.MEMBER_COUNT.minus(1)).where(CHATS.ID.eq(chat)).execute();
                boolean open = event.getCancelledAt() == null && now.isBefore(event.getEndsAt());
                if (open) {
                    outbox.send(user, Map.of("type", "chat.removed", "chatId", "event:" + EventViews.publicId(id)));
                    chats.push(ctx, chat, chats.members(ctx, chat));
                }
            }
        }
        if (removedBy != null) {
            ctx.insertInto(EVENT_BANS).set(EVENT_BANS.EVENT_ID, id).set(EVENT_BANS.USER_ID, user).onConflictDoNothing().execute();
        }
        EventsRecord now2 = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).fetchOne();
        if (now2 == null) return;
        // The event as it is for them now, on all their devices (not "Going" any more)
        outbox.send(user, Map.of("type", "event", "event", views.summary(ctx, user, now2, now)));
        if (removedBy != null) notifications.notify(ctx, user, "event.removed", removedBy, now2, null);
        spots(now2);
    }

    @PutMapping("/events/{eventId}/saved/me")
    public Map<String, Object> save(Viewer viewer, @PathVariable String eventId) {
        UUID id = id(eventId);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            Database.lockPerson(ctx, viewer.id());
            EventsRecord event = visible(ctx, id, viewer.id(), false);
            limits.check(viewer.id(), Limits.Action.SAVE);
            boolean saved = ctx.fetchExists(EVENT_SAVED, EVENT_SAVED.USER_ID.eq(viewer.id()).and(EVENT_SAVED.EVENT_ID.eq(id)));
            if (!saved) {
                // What is over cannot be saved any more: it could never be taken out again
                if (EventViews.tookPlace(event, now)) throw ApiError.conflict("past_event", "this event is over");
                // Only what can still happen counts: the past stays in the list, and must not fill it
                int open = ctx.fetchCount(ctx.select(EVENT_SAVED.EVENT_ID).from(EVENT_SAVED).join(EVENTS).on(EVENTS.ID.eq(EVENT_SAVED.EVENT_ID))
                        .where(EVENT_SAVED.USER_ID.eq(viewer.id())).and(EVENTS.CANCELLED_AT.isNull()).and(EVENTS.ENDS_AT.gt(now)));
                if (open >= SAVED_MAX) throw ApiError.conflict("too_many_saved", "you have saved as many events as one can");
                ctx.insertInto(EVENT_SAVED).set(EVENT_SAVED.USER_ID, viewer.id()).set(EVENT_SAVED.EVENT_ID, id).set(EVENT_SAVED.SINCE, now)
                        .onConflictDoNothing().execute();
            }
            ctx.deleteFrom(SAVED_HIDDEN).where(SAVED_HIDDEN.USER_ID.eq(viewer.id())).and(SAVED_HIDDEN.EVENT_ID.eq(id)).execute();
            return Map.<String, Object>of("saved", true);
        });
    }

    @DeleteMapping("/events/{eventId}/saved/me")
    public Map<String, Object> unsave(Viewer viewer, @PathVariable String eventId) {
        UUID id = id(eventId);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            EventsRecord event = visible(ctx, id, viewer.id(), false);
            if (EventViews.tookPlace(event, now)) throw ApiError.conflict("past_event", "this event is over");
            ctx.deleteFrom(EVENT_SAVED).where(EVENT_SAVED.USER_ID.eq(viewer.id())).and(EVENT_SAVED.EVENT_ID.eq(id)).execute();
            // One cancelled before it began also leaves the lists, for who joined or organized it too
            if (event.getCancelledAt() != null) {
                ctx.insertInto(SAVED_HIDDEN).set(SAVED_HIDDEN.USER_ID, viewer.id()).set(SAVED_HIDDEN.EVENT_ID, id).onConflictDoNothing().execute();
            }
            return Map.<String, Object>of("saved", false);
        });
    }

    @DeleteMapping("/me/saved/cancelled")
    public ResponseEntity<Void> clearCancelled(Viewer viewer) {
        db.txRun(ctx -> {
            var mine = ctx.select(EVENTS.ID).from(EVENTS).where(EVENTS.CANCELLED_AT.isNotNull()).and(EVENTS.CANCELLED_AT.lt(EVENTS.STARTS_AT))
                    .and(EVENTS.ID.in(ctx.select(EVENT_SAVED.EVENT_ID).from(EVENT_SAVED).where(EVENT_SAVED.USER_ID.eq(viewer.id())))
                            .or(EVENTS.ID.in(ctx.select(EVENT_ATTENDEES.EVENT_ID).from(EVENT_ATTENDEES).where(EVENT_ATTENDEES.USER_ID.eq(viewer.id())))))
                    .fetch(EVENTS.ID);
            for (UUID id : mine) {
                ctx.deleteFrom(EVENT_SAVED).where(EVENT_SAVED.USER_ID.eq(viewer.id())).and(EVENT_SAVED.EVENT_ID.eq(id)).execute();
                ctx.insertInto(SAVED_HIDDEN).set(SAVED_HIDDEN.USER_ID, viewer.id()).set(SAVED_HIDDEN.EVENT_ID, id).onConflictDoNothing().execute();
            }
        });
        return ResponseEntity.noContent().build();
    }

    // --- ratings ---

    @PostMapping("/events/{eventId}/ratings")
    public ResponseEntity<Map<String, Object>> rate(Viewer viewer, @PathVariable String eventId, @RequestBody(required = false) @Nullable JsonNode raw) {
        UUID id = id(eventId);
        Body body = Body.of(raw);
        Instant now = clock.instant();
        Map<String, Object> answer = db.tx(ctx -> {
            EventsRecord event = visible(ctx, id, viewer.id(), false);
            String status = EventViews.status(event, now);
            boolean going = ctx.fetchExists(EVENT_ATTENDEES, EVENT_ATTENDEES.EVENT_ID.eq(id).and(EVENT_ATTENDEES.USER_ID.eq(viewer.id())));
            if (viewer.id().equals(event.getCreatorId()) || !going || !("ongoing".equals(status) || "concluded".equals(status))) {
                throw ApiError.forbidden("only people who joined it rate it, once it started");
            }
            if (ctx.fetchExists(EVENT_RATINGS, EVENT_RATINGS.EVENT_ID.eq(id).and(EVENT_RATINGS.USER_ID.eq(viewer.id())))) {
                throw ApiError.conflict("conflict", "already rated");
            }
            Rating input = Rating.of(body);
            limits.check(viewer.id(), Limits.Action.RATING);
            EventRatingsRecord rating = ctx.newRecord(EVENT_RATINGS);
            rating.setId(Ids.next());
            rating.setEventId(id);
            rating.setUserId(viewer.id());
            rating.setRating(input.value());
            rating.setComment(input.comment());
            rating.setDate(now);
            rating.insert();
            ctx.update(EVENTS).set(EVENTS.RATING_COUNT, EVENTS.RATING_COUNT.plus(1)).set(EVENTS.RATING_SUM, EVENTS.RATING_SUM.plus((double) input.value()))
                    .where(EVENTS.ID.eq(id)).execute();
            notifications.notify(ctx, event.getCreatorId(), "event.rated", viewer.id(), event, Map.of("rating", (double) input.value()));
            return EventViews.rating(rating, people.summary(ctx, viewer.id()));
        });
        return ResponseEntity.status(HttpStatus.CREATED).body(answer);
    }

    @PutMapping("/events/{eventId}/ratings/me")
    public Map<String, Object> rerate(Viewer viewer, @PathVariable String eventId, @RequestBody(required = false) @Nullable JsonNode raw) {
        UUID id = id(eventId);
        Body body = Body.of(raw);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            visible(ctx, id, viewer.id(), false);
            EventRatingsRecord rating = ctx.selectFrom(EVENT_RATINGS).where(EVENT_RATINGS.EVENT_ID.eq(id)).and(EVENT_RATINGS.USER_ID.eq(viewer.id()))
                    .forUpdate().fetchOne();
            if (rating == null) throw ApiError.notFound("no rating to change");
            Rating input = Rating.of(body);
            double before = rating.getRating();
            rating.setRating(input.value());
            rating.setComment(input.comment());
            rating.setModified(now);
            rating.update();
            ctx.update(EVENTS).set(EVENTS.RATING_SUM, EVENTS.RATING_SUM.plus(input.value() - before)).where(EVENTS.ID.eq(id)).execute();
            return EventViews.rating(rating, people.summary(ctx, viewer.id()));
        });
    }

    @DeleteMapping("/events/{eventId}/ratings/me")
    public ResponseEntity<Void> unrate(Viewer viewer, @PathVariable String eventId) {
        UUID id = id(eventId);
        // Their own words: they can take them back also from who blocked them
        db.txRun(ctx -> {
            EventRatingsRecord rating = ctx.selectFrom(EVENT_RATINGS).where(EVENT_RATINGS.EVENT_ID.eq(id)).and(EVENT_RATINGS.USER_ID.eq(viewer.id()))
                    .forUpdate().fetchOne();
            if (rating == null) return;
            rating.delete();
            ctx.update(EVENTS).set(EVENTS.RATING_COUNT, DSL.greatest(EVENTS.RATING_COUNT.minus(1), DSL.inline(0)))
                    .set(EVENTS.RATING_SUM, EVENTS.RATING_SUM.minus((double) rating.getRating())).where(EVENTS.ID.eq(id)).execute();
        });
        return ResponseEntity.noContent().build();
    }

    record Rating(float value, String comment) {
        static Rating of(Body body) {
            Double value = body.number("rating");
            if (value == null || value < 0 || value > 10) throw ApiError.badRequest("rating: 0–10");
            String comment = body.string("comment");
            if (comment == null) comment = "";
            if (Text.length(comment) > 500) throw ApiError.badRequest("comment: at most 500 characters");
            return new Rating(value.floatValue(), Text.strip(Text.plain(comment)));
        }
    }

    // --- rules ---

    /** The event, unless it does not exist or a block either way hides it. {@code lock}: FOR UPDATE. */
    public static EventsRecord visible(DSLContext ctx, UUID id, UUID viewer, boolean lock) {
        var query = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id));
        EventsRecord event = lock ? query.forUpdate().fetchOne() : query.fetchOne();
        if (event == null || Relations.blockedEither(ctx, viewer, event.getCreatorId())) throw ApiError.notFound("event not found");
        return event;
    }

    static EventsRecord own(DSLContext ctx, UUID id, UUID viewer) {
        EventsRecord event = visible(ctx, id, viewer, false);
        if (!event.getCreatorId().equals(viewer)) throw ApiError.forbidden("only the organizer can do this");
        return event;
    }

    public static UUID id(String publicId) {
        return Ids.require("ev", publicId, "event");
    }

    static @Nullable UUID eventChat(DSLContext ctx, UUID event) {
        return ctx.select(CHATS.ID).from(CHATS).where(CHATS.EVENT_ID.eq(event)).fetchOne(CHATS.ID);
    }

    static List<UUID> attendees(DSLContext ctx, UUID event) {
        return ctx.select(EVENT_ATTENDEES.USER_ID).from(EVENT_ATTENDEES).where(EVENT_ATTENDEES.EVENT_ID.eq(event)).fetch(EVENT_ATTENDEES.USER_ID);
    }

    /** A flash event looking for people: how many it still needs changed, for everyone who sees it. */
    private void spots(EventsRecord event) {
        if (event.getFlash() && event.getSpotsNeeded() > 0) notifier.changed(event.getId(), 0);
    }

    /** 409 too_many_events when the organizer already has five others on. */
    static void checkActive(DSLContext ctx, UUID user, @Nullable UUID self, Draft draft, Instant now) {
        if (!draft.end.isAfter(now)) return;
        int others = ctx.fetchCount(EVENTS, EVENTS.CREATOR_ID.eq(user).and(EVENTS.CANCELLED_AT.isNull()).and(EVENTS.ENDS_AT.gt(now))
                .and(self == null ? DSL.trueCondition() : EVENTS.ID.ne(self)));
        if (others >= MAX_ACTIVE) throw ApiError.conflict("too_many_events", "at most " + MAX_ACTIVE + " events on at once");
    }

    /**
     * 409 too_close when another event within 15 m is not over (§4.9, §7.3): under a lock on
     * every square of 0.01° the circle touches, in order, so two requests never both pass.
     */
    static void checkRoom(DSLContext ctx, @Nullable UUID self, Draft draft, Instant now) {
        for (String square : squares(draft.latitude, draft.longitude)) Database.lockZone(ctx, square);
        boolean taken = ctx.fetchExists(ctx.selectOne().from(EVENTS).where(DSL.condition(
                        "ST_DWithin(location, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)", draft.longitude, draft.latitude, MIN_SPACING))
                .and(EVENTS.CANCELLED_AT.isNull()).and(EVENTS.ENDS_AT.gt(now)).and(self == null ? DSL.trueCondition() : EVENTS.ID.ne(self)));
        if (taken) throw ApiError.conflict("too_close", "another event is within 15 m");
    }

    /** The squares of 0.01° a circle of 15 m around the point touches, in increasing order. */
    static java.util.SortedSet<String> squares(double lat, double lon) {
        TreeSet<String> squares = new TreeSet<>();
        double dLat = MIN_SPACING / Geo.METRES_PER_DEGREE;
        double dLon = MIN_SPACING / (Geo.METRES_PER_DEGREE * Math.max(Math.cos(Math.toRadians(lat)), 0.01));
        for (double a : new double[] {lat - dLat, lat + dLat}) {
            for (double b : new double[] {lon - dLon, lon + dLon}) {
                long row = (long) Math.floor((Math.max(-90, Math.min(90, a)) + 90) / 0.01);
                long column = (long) Math.floor((((b + 180) % 360 + 360) % 360) / 0.01);
                squares.add(row + ":" + column);
            }
        }
        return squares;
    }

    /**
     * 409 too_far for a flash event farther than 500 m from its organizer, 409 position_needed
     * when where they are is not known: the presence's GPS first, else the {@code from} of the request.
     */
    void flashNear(UUID user, Draft draft, Body body) {
        Optional<Point> where = ask(() -> presence.position(user).get(200, TimeUnit.MILLISECONDS));
        Point at;
        if (where != null && where.isPresent()) {
            at = where.get();
        } else {
            Body from = body.object("from");
            Double lat = from == null ? null : from.number("latitude");
            Double lon = from == null ? null : from.number("longitude");
            if (lat == null || lon == null || !(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) {
                throw ApiError.conflict("position_needed", "where you are is needed to make a flash event");
            }
            at = new Point(lat, lon);
            Boolean plausible = ask(() -> presence.plausible(user, at).get(200, TimeUnit.MILLISECONDS));
            if (Boolean.FALSE.equals(plausible)) throw ApiError.conflict("too_far", "flash events are made within 500 m of you");
        }
        if (Geo.distance(at.latitude(), at.longitude(), draft.latitude, draft.longitude) > FLASH_MAX_DISTANCE) {
            throw ApiError.conflict("too_far", "flash events are made within 500 m of you");
        }
    }

    // --- the fields of EventInput ---

    /** The event as it will be, before anything is written: a refused change leaves the event as it was. */
    static final class Draft {
        String title = "";
        String description = "";
        String[] categories = new String[0];
        double latitude;
        double longitude;
        @Nullable String address;
        Instant start;
        Instant end;
        Instant created;
        @Nullable String links;
        boolean flash;
        int spots;
        @Nullable EventTheme theme;
        boolean themeSet;
        int reach = Promotions.REACH_MAX;

        private Draft(Instant now) {
            start = now;
            end = now;
            created = now;
        }

        static Draft fresh(UUID user, Instant now) {
            return new Draft(now);
        }

        static Draft of(EventsRecord event) {
            Draft draft = new Draft(event.getCreatedAt());
            draft.title = event.getTitle();
            draft.description = event.getDescription();
            draft.categories = event.getCategories();
            draft.latitude = event.getLatitude();
            draft.longitude = event.getLongitude();
            draft.address = event.getAddress();
            draft.start = event.getStartsAt();
            draft.end = event.getEndsAt();
            draft.links = event.getLinks();
            draft.flash = event.getFlash();
            draft.spots = event.getSpotsNeeded();
            draft.reach = event.getReach();
            return draft;
        }

        void apply(Body body, boolean creating, Instant now) {
            List<String> errors = new ArrayList<>();
            if (creating || body.has("title")) {
                String title = Text.words(Text.plain(orEmpty(body.string("title"))));
                if (Text.length(title) < 1 || Text.length(title) > 50) errors.add("title: 1–50 characters");
                this.title = title;
            }
            if (creating || body.has("description")) {
                String description = Text.strip(Text.plain(orEmpty(body.string("description"))));
                if (Text.length(description) < 1 || Text.length(description) > 500) errors.add("description: 1–500 characters");
                this.description = description;
            }
            if (creating || body.has("categories")) {
                List<String> categories = null;
                try {
                    categories = body.strings("categories", 20);
                } catch (ApiError error) {
                    categories = null;
                }
                if (categories == null || categories.isEmpty() || !CATEGORIES.containsAll(categories)) {
                    errors.add("categories: at least one known category");
                } else {
                    this.categories = new LinkedHashSet<>(categories).toArray(String[]::new);
                }
            }
            if (creating || body.has("location")) {
                Body location = null;
                try {
                    location = body.object("location");
                } catch (ApiError error) {
                    location = null;
                }
                Double lat = location == null ? null : number(location, "latitude");
                Double lon = location == null ? null : number(location, "longitude");
                if (lat == null || lon == null || !(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180)) {
                    errors.add("location: latitude and longitude");
                } else {
                    this.latitude = lat;
                    this.longitude = lon;
                }
                String address = null;
                try {
                    address = location == null ? null : location.string("address");
                } catch (ApiError error) {
                    errors.add("location.address: at most 200 characters");
                }
                if (address != null && Text.length(address) > 200) errors.add("location.address: at most 200 characters");
                this.address = address == null || address.isEmpty() ? null : Text.plain(address);
            }
            if (creating || body.has("dates")) dates(body, creating, now, errors);
            if (body.has("links")) {
                String links = null;
                try {
                    links = body.string("links");
                } catch (ApiError error) {
                    errors.add("links: a full https link");
                }
                if (links != null && (Text.length(links) > 500 || !LINK.matcher(Text.strip(links)).matches())) errors.add("links: a full https link");
                this.links = links == null || links.isEmpty() ? null : Text.strip(links);
            }
            // What it is stays what it was made as: a normal event turned flash would skip its check
            if (creating && body.has("flash")) {
                Boolean flash = null;
                try {
                    flash = body.bool("flash");
                } catch (ApiError error) {
                    errors.add("flash: true or false");
                }
                this.flash = Boolean.TRUE.equals(flash);
            }
            if (body.has("spotsNeeded")) {
                Integer spots = null;
                try {
                    spots = body.integer("spotsNeeded");
                } catch (ApiError error) {
                    spots = null;
                }
                if (spots == null || spots < 0 || spots > 20) errors.add("spotsNeeded: 0–20");
                else this.spots = spots;
            }
            if (body.has("theme")) {
                this.theme = EventTheme.of(body.raw("theme"));
                this.themeSet = true;
            }
            if (body.has("reach")) {
                Integer reach = null;
                try {
                    reach = body.integer("reach");
                } catch (ApiError error) {
                    reach = null;
                }
                if (reach == null || reach < Promotions.REACH_MIN || reach > Promotions.REACH_MAX) {
                    errors.add("reach: " + Promotions.REACH_MIN + "–" + Promotions.REACH_MAX + " metres");
                } else {
                    this.reach = reach;
                }
            }
            if (flash && errors.isEmpty()
                    && (start.isAfter(now.plusMillis(65 * MINUTE)) || Duration.between(start, end).toMillis() > 185 * MINUTE)) {
                errors.add("flash events start within the hour and last at most 3 h");
            }
            if (!errors.isEmpty()) throw ApiError.badRequest("invalid event", errors);
        }

        private void dates(Body body, boolean creating, Instant now, List<String> errors) {
            Body dates = null;
            try {
                dates = body.object("dates");
            } catch (ApiError error) {
                dates = null;
            }
            Instant newStart = date(dates, "startDate"), newEnd = date(dates, "endDate");
            long nowMs = now.toEpochMilli();
            if (newStart == null || newEnd == null || !newEnd.isAfter(newStart)) {
                errors.add("dates: startDate before endDate");
                return;
            }
            long length = newEnd.toEpochMilli() - newStart.toEpochMilli();
            boolean startMoves = creating || !newStart.equals(start);
            if (length > MAX_DAYS_LONG * DAY && (creating || length > end.toEpochMilli() - start.toEpochMilli())) {
                errors.add("dates: the event lasts at most " + MAX_DAYS_LONG + " days");
            } else if (startMoves && newStart.toEpochMilli() < nowMs - 5 * MINUTE) {
                errors.add("dates: the event cannot start in the past");
            } else if (newEnd.toEpochMilli() <= nowMs) {
                errors.add("dates: the event must end in the future");
            } else if (!creating && !newStart.equals(start) && start.toEpochMilli() <= nowMs) {
                errors.add("dates: an event under way keeps its start");
            } else if (!creating && newEnd.toEpochMilli() > created.toEpochMilli() + (MAX_DAYS_AHEAD + MAX_DAYS_LONG) * DAY) {
                errors.add("dates: an event ends at most " + (MAX_DAYS_AHEAD + MAX_DAYS_LONG) + " days after it was made");
            } else if (startMoves && newStart.toEpochMilli() > nowMs + MAX_DAYS_AHEAD * DAY) {
                errors.add("dates: the event starts at most " + MAX_DAYS_AHEAD + " days ahead");
            } else {
                start = newStart;
                end = newEnd;
            }
        }

        void into(EventsRecord row) {
            row.setTitle(title);
            row.setDescription(description);
            row.setCategories(categories);
            row.setLatitude(latitude);
            row.setLongitude(longitude);
            row.setAddress(address);
            row.setStartsAt(start);
            row.setEndsAt(end);
            row.setLinks(links);
            row.setFlash(flash);
            row.setSpotsNeeded(spots);
            if (themeSet) row.setTheme(theme == null ? null : theme.jsonb());
            row.setReach(reach);
        }

        private static @Nullable Instant date(@Nullable Body dates, String field) {
            if (dates == null) return null;
            try {
                String value = dates.string(field);
                return value == null ? null : Times.parse(value, field);
            } catch (ApiError error) {
                return null;
            }
        }

        private static @Nullable Double number(Body body, String field) {
            try {
                return body.number(field);
            } catch (ApiError error) {
                return null;
            }
        }

        private static String orEmpty(@Nullable String value) {
            return value == null ? "" : value;
        }
    }

    // --- small things ---

    private static double coordinate(@Nullable String value, String name) {
        if (value == null || !NUMBER.matcher(value).matches()) throw ApiError.badRequest(name + ": a number is needed");
        return Double.parseDouble(value);
    }

    private static int integer(String value, String name) {
        if (!INTEGER.matcher(value).matches()) throw ApiError.badRequest(name + ": an integer is needed");
        return Integer.parseInt(value);
    }

    private static List<EventsRecord> reversed(List<EventsRecord> events) {
        List<EventsRecord> out = new ArrayList<>(events);
        java.util.Collections.reverse(out);
        return out;
    }

    private interface Question<T> {
        T get() throws Exception;
    }

    /** What the presence answers in time, or null: the rule of §5 decides what null means. */
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
