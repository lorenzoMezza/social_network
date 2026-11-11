// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.people;

import static masterkey.store.db.Tables.CONNECTIONS;
import static masterkey.store.db.Tables.CONSENTS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.EVENT_RATINGS;
import static masterkey.store.db.Tables.PUSH_TOKENS;
import static masterkey.store.db.Tables.STORY_HIDDEN;
import static masterkey.store.db.Tables.USERS;

import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.api.Limits;
import masterkey.api.Urls;
import masterkey.api.common.People;
import masterkey.api.common.Relations;
import masterkey.api.events.EventViews;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.core.Ids;
import masterkey.store.Database;
import masterkey.store.db.tables.records.EventRatingsRecord;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.UsersRecord;
import org.jooq.DSLContext;
import org.jooq.Record3;
import org.jspecify.annotations.Nullable;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/** Other people's profiles, their events, story and connections; the own story, push tokens, consents ({@code routes/people.py}). */
@RestController
@RequestMapping("/v1")
public class PeopleController {

    static final int STORY_HIDDEN_MAX = 2000;
    static final int PUSH_TOKENS_MAX = 10;
    static final int CONSENTS_KEPT = 50;
    static final int OWN_EVENTS_MAX = 500;

    private final Database db;
    private final People people;
    private final Relations relations;
    private final EventViews events;
    private final Urls urls;
    private final Limits limits;
    private final InstantSource clock;

    public PeopleController(Database db, People people, Relations relations, EventViews events, Urls urls, Limits limits, InstantSource clock) {
        this.db = db;
        this.people = people;
        this.relations = relations;
        this.events = events;
        this.urls = urls;
        this.limits = limits;
        this.clock = clock;
    }

    /** Who blocked the viewer is gone for them; whom the viewer blocked stays (to unblock). */
    private UsersRecord visible(DSLContext ctx, String publicId, UUID viewer) {
        limits.check(viewer, Limits.Action.PEOPLE);
        UUID id = People.id(publicId);
        UsersRecord user = ctx.selectFrom(USERS).where(USERS.ID.eq(id)).fetchOne();
        if (user == null || Relations.blocks(ctx, id, viewer)) throw ApiError.notFound("user not found");
        return user;
    }

    @GetMapping("/users/{userId}")
    public Map<String, Object> user(Viewer viewer, @PathVariable String userId) {
        // The network first: whether they are around now, for canMessage
        UUID id = People.id(userId);
        Relations.CanMessage can = id.equals(viewer.id()) ? new Relations.CanMessage(false, null) : db.read(ctx -> relations.canMessage(ctx, viewer.id(), id));
        return db.read(ctx -> {
            UsersRecord other = visible(ctx, userId, viewer.id());
            boolean sees = Relations.seesStory(ctx, viewer.id(), other.getId());
            Instant since = ctx.select(CONNECTIONS.SINCE).from(CONNECTIONS).where(CONNECTIONS.USER_ID.eq(viewer.id()))
                    .and(CONNECTIONS.OTHER_ID.eq(other.getId())).fetchOne(CONNECTIONS.SINCE);
            Views.UserSummary summary = Views.summary(other, urls);
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("id", summary.id());
            view.put("username", summary.username());
            view.put("name", summary.name());
            view.put("pictureUrl", summary.pictureUrl());
            view.put("avatarVersion", summary.avatarVersion());
            view.put("backdrop", summary.backdrop());
            view.put("bio", other.getBio());
            view.put("style", Views.json(other.getStyle()));
            Map<String, Object> stats = new LinkedHashMap<>();
            stats.put("organized", sees ? ctx.fetchCount(EVENTS, EVENTS.CREATOR_ID.eq(other.getId()).and(EVENTS.CANCELLED_AT.isNull())) : null);
            stats.put("connections", sees ? ctx.fetchCount(CONNECTIONS, CONNECTIONS.USER_ID.eq(other.getId())) : null);
            view.put("stats", stats);
            Map<String, Object> relation = new LinkedHashMap<>();
            relation.put("connected", since != null);
            relation.put("connectedSince", since);
            relation.put("blocked", Relations.blocks(ctx, viewer.id(), other.getId()));
            relation.put("canMessage", can.allowed());
            relation.put("seesStory", sees);
            view.put("relation", relation);
            return view;
        });
    }

    @GetMapping("/users/{userId}/events")
    public Map<String, Object> userEvents(Viewer viewer, @PathVariable String userId) {
        Instant now = clock.instant();
        return db.read(ctx -> {
            UsersRecord other = visible(ctx, userId, viewer.id());
            if (!Relations.seesStory(ctx, viewer.id(), other.getId())) return Map.of("items", List.of());
            List<EventsRecord> theirs = ctx.selectFrom(EVENTS).where(EVENTS.CREATOR_ID.eq(other.getId())).and(EVENTS.CANCELLED_AT.isNull())
                    .orderBy(EVENTS.STARTS_AT.desc()).limit(OWN_EVENTS_MAX).fetch();
            List<Map<String, Object>> summaries = events.summaries(ctx, viewer.id(), theirs, now);
            List<Map<String, Object>> items = new ArrayList<>();
            for (int i = 0; i < theirs.size(); i++) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("event", summaries.get(i));
                item.put("people", theirs.get(i).getFollowerCount());
                item.put("past", "concluded".equals(EventViews.status(theirs.get(i), now)));
                items.add(item);
            }
            return Map.of("items", items);
        });
    }

    /** One moment of a story while it is being put together. */
    private record Moment(String id, String kind, Instant at, boolean upcoming, @Nullable EventsRecord event,
                          @Nullable EventRatingsRecord rating, @Nullable UUID person, @Nullable String place) {
    }

    @GetMapping("/users/{userId}/activity")
    public Map<String, Object> activity(Viewer viewer, @PathVariable String userId, @RequestParam(required = false) @Nullable String cursor,
                                        @RequestParam(required = false) @Nullable String limit) {
        int size = limit != null && limit.matches("[0-9]{1,4}") ? Math.max(1, Math.min(100, Integer.parseInt(limit))) : 30;
        int start = cursor != null && cursor.matches("[0-9]{1,6}") ? Integer.parseInt(cursor) : 0;
        Instant now = clock.instant();
        return db.read(ctx -> {
            UsersRecord owner = visible(ctx, userId, viewer.id());
            UUID id = owner.getId();
            Map<String, Object> empty = new LinkedHashMap<>();
            empty.put("items", List.of());
            empty.put("nextCursor", null);
            if (!Relations.seesStory(ctx, viewer.id(), id)) return empty;
            Set<UUID> blocked = Relations.blockedWith(ctx, viewer.id());
            List<Moment> moments = new ArrayList<>();
            if (!blocked.contains(id)) {
                for (EventsRecord event : ctx.selectFrom(EVENTS).where(EVENTS.CREATOR_ID.eq(id)).and(EVENTS.CANCELLED_AT.isNull())
                        .orderBy(EVENTS.STARTS_AT.desc()).limit(OWN_EVENTS_MAX).fetch()) {
                    moments.add(new Moment("o-" + EventViews.publicId(event.getId()), "organized", event.getStartsAt(),
                            "upcoming".equals(EventViews.status(event, now)), event, null, null, null));
                }
            }
            // "Going" while it is on too: joining says they mean to go, not where they are now
            for (EventsRecord event : ctx.selectFrom(EVENTS).where(EVENTS.ID.in(ctx.select(EVENT_ATTENDEES.EVENT_ID).from(EVENT_ATTENDEES)
                    .where(EVENT_ATTENDEES.USER_ID.eq(id)))).and(EVENTS.CREATOR_ID.ne(id)).and(EVENTS.CANCELLED_AT.isNull())
                    .orderBy(EVENTS.STARTS_AT.desc()).limit(OWN_EVENTS_MAX).fetch()) {
                if (blocked.contains(event.getCreatorId())) continue;
                boolean went = "concluded".equals(EventViews.status(event, now));
                moments.add(new Moment("j-" + EventViews.publicId(event.getId()), went ? "went" : "going", went ? event.getEndsAt() : event.getStartsAt(),
                        !went, event, null, null, null));
            }
            Map<UUID, EventsRecord> rated = new HashMap<>();
            List<EventRatingsRecord> ratings = ctx.selectFrom(EVENT_RATINGS).where(EVENT_RATINGS.USER_ID.eq(id)).orderBy(EVENT_RATINGS.DATE.desc())
                    .limit(OWN_EVENTS_MAX).fetch();
            if (!ratings.isEmpty()) {
                for (EventsRecord event : ctx.selectFrom(EVENTS).where(EVENTS.ID.in(ratings.stream().map(EventRatingsRecord::getEventId).toList()))
                        .and(EVENTS.CANCELLED_AT.isNull()).fetch()) rated.put(event.getId(), event);
            }
            for (EventRatingsRecord rating : ratings) {
                EventsRecord event = rated.get(rating.getEventId());
                if (event == null || event.getCreatorId().equals(id) || blocked.contains(event.getCreatorId())) continue;
                moments.add(new Moment("r-" + EventViews.publicId(event.getId()), "reviewed", rating.getDate(), false, event, rating, null, null));
            }
            // Connections: all of one's own; on someone else's profile, only theirs with the viewer
            boolean own = id.equals(viewer.id());
            for (Record3<UUID, Instant, String> row : ctx.select(CONNECTIONS.OTHER_ID, CONNECTIONS.SINCE, CONNECTIONS.PLACE).from(CONNECTIONS)
                    .where(CONNECTIONS.USER_ID.eq(id)).and(own ? org.jooq.impl.DSL.trueCondition() : CONNECTIONS.OTHER_ID.eq(viewer.id())).fetch()) {
                moments.add(new Moment("c-" + Ids.publicId("usr", row.value1()), "connected", row.value2(), false, null, null, row.value1(), row.value3()));
            }
            // The story's kinds and hidden moments: gone for others, marked in one's own
            Set<String> hidden = new HashSet<>(ctx.select(STORY_HIDDEN.MOMENT_ID).from(STORY_HIDDEN).where(STORY_HIDDEN.USER_ID.eq(id)).fetch(STORY_HIDDEN.MOMENT_ID));
            JsonNode story = Views.json(owner.getStory());
            List<Moment> upcoming = new ArrayList<>(), past = new ArrayList<>();
            Map<Moment, Boolean> isHidden = new HashMap<>();
            for (Moment moment : moments) {
                String kind = "went".equals(moment.kind()) ? "going" : moment.kind();
                JsonNode shown = story.get(kind);
                boolean off = hidden.contains(moment.id()) || (shown != null && shown.isBoolean() && !shown.booleanValue());
                if (off && !own) continue;
                isHidden.put(moment, off);
                (moment.upcoming() ? upcoming : past).add(moment);
            }
            upcoming.sort(Comparator.comparing(Moment::at));
            past.sort(Comparator.comparing(Moment::at).reversed());
            List<Moment> ordered = new ArrayList<>(upcoming);
            ordered.addAll(past);
            List<Moment> page = ordered.subList(Math.min(start, ordered.size()), Math.min(start + size, ordered.size()));
            List<EventsRecord> shownEvents = new ArrayList<>();
            Set<UUID> persons = new HashSet<>();
            for (Moment moment : page) {
                if (moment.event() != null) shownEvents.add(moment.event());
                if (moment.person() != null) persons.add(moment.person());
            }
            List<Map<String, Object>> made = events.summaries(ctx, viewer.id(), shownEvents, now);
            Map<EventsRecord, Map<String, Object>> eventViews = new HashMap<>();
            for (int i = 0; i < shownEvents.size(); i++) eventViews.put(shownEvents.get(i), made.get(i));
            Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, persons);
            List<Map<String, Object>> items = new ArrayList<>();
            for (Moment moment : page) {
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("id", moment.id());
                item.put("kind", moment.kind());
                item.put("at", moment.at());
                item.put("upcoming", moment.upcoming());
                item.put("event", moment.event() == null ? null : eventViews.get(moment.event()));
                item.put("person", moment.person() == null ? null : summaries.get(moment.person()));
                EventRatingsRecord rating = moment.rating();
                if (rating == null) {
                    item.put("rating", null);
                } else {
                    Map<String, Object> words = new LinkedHashMap<>();
                    words.put("rating", (double) rating.getRating());
                    words.put("comment", rating.getComment());
                    item.put("rating", words);
                }
                item.put("place", moment.place());
                item.put("hidden", isHidden.getOrDefault(moment, false));
                items.add(item);
            }
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("items", items);
            answer.put("nextCursor", start + size < ordered.size() ? Integer.toString(start + size) : null);
            return answer;
        });
    }

    @GetMapping("/users/{userId}/connections")
    public Map<String, Object> connections(Viewer viewer, @PathVariable String userId) {
        return db.read(ctx -> {
            UsersRecord other = visible(ctx, userId, viewer.id());
            Map<String, Object> answer = new LinkedHashMap<>();
            if (!Relations.seesStory(ctx, viewer.id(), other.getId())) {
                answer.put("items", List.of());
                answer.put("total", null);
                answer.put("mutual", 0);
                return answer;
            }
            Set<UUID> mine = Relations.connectionsOf(ctx, viewer.id());
            Set<UUID> blocked = Relations.blockedWith(ctx, viewer.id());
            Set<UUID> theirs = Relations.connectionsOf(ctx, other.getId());
            List<UUID> shown = new ArrayList<>();
            for (UUID id : theirs) if (!id.equals(viewer.id()) && !blocked.contains(id)) shown.add(id);
            Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, shown);
            shown.removeIf(id -> !summaries.containsKey(id));
            shown.sort(Comparator.<UUID, Boolean>comparing(id -> !mine.contains(id))
                    .thenComparing(id -> summaries.get(id).name().toLowerCase(Locale.ROOT)));
            List<Map<String, Object>> items = new ArrayList<>();
            int mutual = 0;
            for (UUID id : shown) {
                boolean both = mine.contains(id);
                if (both) mutual++;
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("user", summaries.get(id));
                item.put("mutual", both);
                items.add(item);
            }
            answer.put("items", items);
            answer.put("total", theirs.size());
            answer.put("mutual", mutual);
            return answer;
        });
    }

    // --- the own story ---

    @PutMapping("/me/story/hidden/{momentId}")
    public ResponseEntity<Void> hide(Viewer viewer, @PathVariable String momentId) {
        if (momentId.length() > 80 || !(momentId.startsWith("o-") || momentId.startsWith("j-") || momentId.startsWith("r-") || momentId.startsWith("c-"))) {
            throw ApiError.badRequest("not a moment of a story");
        }
        db.txRun(ctx -> {
            Database.lockPerson(ctx, viewer.id());
            if (ctx.fetchCount(STORY_HIDDEN, STORY_HIDDEN.USER_ID.eq(viewer.id())) >= STORY_HIDDEN_MAX) {
                throw ApiError.conflict("conflict", "too many hidden moments");
            }
            ctx.insertInto(STORY_HIDDEN).set(STORY_HIDDEN.USER_ID, viewer.id()).set(STORY_HIDDEN.MOMENT_ID, momentId).onConflictDoNothing().execute();
        });
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/me/story/hidden/{momentId}")
    public ResponseEntity<Void> show(Viewer viewer, @PathVariable String momentId) {
        db.txRun(ctx -> ctx.deleteFrom(STORY_HIDDEN).where(STORY_HIDDEN.USER_ID.eq(viewer.id())).and(STORY_HIDDEN.MOMENT_ID.eq(momentId)).execute());
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/me/story/hidden")
    public ResponseEntity<Void> showAll(Viewer viewer) {
        db.txRun(ctx -> ctx.deleteFrom(STORY_HIDDEN).where(STORY_HIDDEN.USER_ID.eq(viewer.id())).execute());
        return ResponseEntity.noContent().build();
    }

    // --- phones, consents ---

    /** A phone is one person's at a time: a token someone else had moves here. At most 10, the oldest goes. */
    @PostMapping("/me/push-tokens")
    public ResponseEntity<Void> pushToken(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        String token = body.string("token");
        String platform = body.string("platform");
        if (token == null || token.isEmpty() || token.length() > 256 || !("ios".equals(platform) || "android".equals(platform))) {
            throw ApiError.badRequest("token and platform (ios, android) are needed");
        }
        Instant now = clock.instant();
        db.txRun(ctx -> {
            Database.lockPerson(ctx, viewer.id());
            ctx.deleteFrom(PUSH_TOKENS).where(PUSH_TOKENS.TOKEN.eq(token)).execute();
            ctx.insertInto(PUSH_TOKENS).set(PUSH_TOKENS.TOKEN, token).set(PUSH_TOKENS.USER_ID, viewer.id()).set(PUSH_TOKENS.PLATFORM, platform)
                    .set(PUSH_TOKENS.ADDED_AT, now).execute();
            ctx.deleteFrom(PUSH_TOKENS).where(PUSH_TOKENS.USER_ID.eq(viewer.id())).and(PUSH_TOKENS.TOKEN.in(
                    ctx.select(PUSH_TOKENS.TOKEN).from(PUSH_TOKENS).where(PUSH_TOKENS.USER_ID.eq(viewer.id()))
                            .orderBy(PUSH_TOKENS.ADDED_AT.desc()).offset(PUSH_TOKENS_MAX))).execute();
        });
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/me/push-tokens/{token}")
    public ResponseEntity<Void> forgetPushToken(Viewer viewer, @PathVariable String token) {
        db.txRun(ctx -> ctx.deleteFrom(PUSH_TOKENS).where(PUSH_TOKENS.TOKEN.eq(token)).and(PUSH_TOKENS.USER_ID.eq(viewer.id())).execute());
        return ResponseEntity.noContent().build();
    }

    /** A consent given in the app, with the version of the text read (GDPR art. 7(1)); in the export. */
    @PutMapping("/me/consents/{kind}")
    public ResponseEntity<Void> consent(Viewer viewer, @PathVariable String kind, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        Integer version;
        try {
            version = body.integer("version");
        } catch (ApiError error) {
            version = null;
        }
        if (!"location-sharing".equals(kind) || version == null || version <= 0 || version >= 1000) {
            throw ApiError.badRequest("unknown consent or version");
        }
        JsonNode mode = body.raw("mode");
        String chosen = mode != null && mode.isString() && ("visible".equals(mode.stringValue()) || "approximate".equals(mode.stringValue()))
                ? mode.stringValue() : null;
        int kept = version;
        Instant now = clock.instant();
        db.txRun(ctx -> {
            ctx.insertInto(CONSENTS).set(CONSENTS.USER_ID, viewer.id()).set(CONSENTS.KIND, kind).set(CONSENTS.VERSION, kept)
                    .set(CONSENTS.MODE, chosen).set(CONSENTS.AT, now).execute();
            ctx.deleteFrom(CONSENTS).where(CONSENTS.USER_ID.eq(viewer.id())).and(CONSENTS.KIND.eq(kind)).and(CONSENTS.AT.lt(
                    ctx.select(CONSENTS.AT).from(CONSENTS).where(CONSENTS.USER_ID.eq(viewer.id())).and(CONSENTS.KIND.eq(kind))
                            .orderBy(CONSENTS.AT.desc()).offset(CONSENTS_KEPT - 1).limit(1).asField())).execute();
        });
        return ResponseEntity.noContent().build();
    }
}
