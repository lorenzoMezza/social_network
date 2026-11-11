// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.notifications;

import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.NOTIFICATIONS;
import static masterkey.store.db.Tables.USERS;

import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import masterkey.api.common.Outbox;
import masterkey.api.common.People;
import masterkey.api.common.Relations;
import masterkey.api.events.EventViews;
import masterkey.api.people.Views;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.NotificationsRecord;
import masterkey.store.db.tables.records.UsersRecord;
import org.jooq.DSLContext;
import org.jooq.JSONB;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Notifications (API.md, Notifications; {@code notifications.py}): only what matters, never
 * noise. Alike ones still unread within a day are gathered into one, newest actor first; each
 * goes over the socket at once with the unread count; the user's settings decide; nobody hears
 * about someone blocked either way. Always written in the caller's transaction, sent after it.
 */
public final class Notifications {

    static final Duration GATHER = Duration.ofDays(1);
    static final int MAX_KEPT = 100;
    static final int SHOWN = 50;
    static final int ACTORS_SHOWN = 3;
    static final Map<String, String> SETTING_OF = Map.of(
            "event.changed", "notifyEventUpdates",
            "event.cancelled", "notifyEventUpdates",
            "event.starting", "notifyEventUpdates",
            "event.removed", "notifyEventUpdates",
            "event.joined", "notifyEventUpdates",
            "event.rated", "notifyEventUpdates",
            "album.photos", "notifyEventUpdates",
            "connect.invite", "notifyConnections");
    static final Set<String> GATHERED = Set.of("event.changed", "event.joined", "event.rated", "album.photos");

    private final People people;
    private final EventViews events;
    private final Outbox outbox;
    private final masterkey.api.common.Later later;
    private final InstantSource clock;

    public Notifications(People people, EventViews events, Outbox outbox, masterkey.api.common.Later later, InstantSource clock) {
        this.later = later;
        this.people = people;
        this.events = events;
        this.outbox = outbox;
        this.clock = clock;
    }

    public void notify(DSLContext ctx, UUID user, String kind, @Nullable UUID actor, @Nullable EventsRecord event,
                       @Nullable Map<String, Object> data) {
        if (user.equals(actor)) return;
        UsersRecord target = ctx.selectFrom(USERS).where(USERS.ID.eq(user)).fetchOne();
        if (target == null) return;
        if (actor != null && Relations.blockedEither(ctx, user, actor)) return;
        if (event != null && Relations.blockedEither(ctx, user, event.getCreatorId())) return;
        String setting = SETTING_OF.get(kind);
        if (setting != null) {
            JsonNode value = Views.json(target.getSettings()).get(setting);
            if (value != null && value.isBoolean() && !value.booleanValue()) return;
        }
        Instant now = clock.instant();
        UUID eventId = event == null ? null : event.getId();
        NotificationsRecord same = null;
        if (GATHERED.contains(kind)) {
            same = ctx.selectFrom(NOTIFICATIONS).where(NOTIFICATIONS.USER_ID.eq(user)).and(NOTIFICATIONS.KIND.eq(kind))
                    .and(NOTIFICATIONS.READ.isFalse()).and(eventId == null ? NOTIFICATIONS.EVENT_ID.isNull() : NOTIFICATIONS.EVENT_ID.eq(eventId))
                    .and(NOTIFICATIONS.AT.gt(now.minus(GATHER))).orderBy(NOTIFICATIONS.AT.desc()).limit(1).forUpdate().fetchOne();
        }
        NotificationsRecord entry;
        if (same != null) {
            if (actor != null) {
                List<UUID> actors = new ArrayList<>();
                actors.add(actor);
                for (UUID other : same.getActors()) if (!other.equals(actor)) actors.add(other);
                same.setActors(actors.toArray(UUID[]::new));
            }
            same.setCount(same.getCount() + 1);
            same.setAt(now);
            if (data != null) same.setData(merge(same.getData(), data));
            same.update();
            entry = same;
        } else {
            entry = ctx.newRecord(NOTIFICATIONS);
            entry.setId(Ids.next());
            entry.setUserId(user);
            entry.setKind(kind);
            entry.setEventId(eventId);
            entry.setAt(now);
            entry.setActors(actor == null ? new UUID[0] : new UUID[] {actor});
            entry.setCount(1);
            entry.setData(JSONB.valueOf(Json.text(data == null ? Map.of() : data)));
            entry.setRead(false);
            entry.insert();
            // A user keeps their newest MAX_KEPT
            ctx.deleteFrom(NOTIFICATIONS).where(NOTIFICATIONS.USER_ID.eq(user)).and(NOTIFICATIONS.ID.in(
                    ctx.select(NOTIFICATIONS.ID).from(NOTIFICATIONS).where(NOTIFICATIONS.USER_ID.eq(user))
                            .orderBy(NOTIFICATIONS.AT.desc()).offset(MAX_KEPT))).execute();
        }
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("type", "notification");
        frame.put("notification", views(ctx, user, List.of(entry)).getFirst());
        frame.put("unread", unread(ctx, user));
        outbox.send(user, frame);
        // A phone that is not online hears of it by a push, if it registered one
        if (ctx.fetchExists(masterkey.store.db.Tables.PUSH_TOKENS, masterkey.store.db.Tables.PUSH_TOKENS.USER_ID.eq(user))) {
            later.pushNotification(entry.getId());
        }
    }

    /** Everyone who joins the event (not its organizer), and {@code also}, but not {@code but}. */
    public void notifyGoing(DSLContext ctx, EventsRecord event, String kind, @Nullable UUID actor, @Nullable Map<String, Object> data,
                            Collection<UUID> also, Collection<UUID> but) {
        Set<UUID> people = new LinkedHashSet<>(ctx.select(EVENT_ATTENDEES.USER_ID).from(EVENT_ATTENDEES)
                .where(EVENT_ATTENDEES.EVENT_ID.eq(event.getId())).and(EVENT_ATTENDEES.USER_ID.ne(event.getCreatorId()))
                .fetch(EVENT_ATTENDEES.USER_ID));
        people.addAll(also);
        people.removeAll(but);
        for (UUID user : people) notify(ctx, user, kind, actor, event, data);
    }

    public int unread(DSLContext ctx, UUID user) {
        return ctx.fetchCount(NOTIFICATIONS, NOTIFICATIONS.USER_ID.eq(user).and(NOTIFICATIONS.READ.isFalse()));
    }

    public Map<String, Object> list(DSLContext ctx, UUID user) {
        List<NotificationsRecord> mine = ctx.selectFrom(NOTIFICATIONS).where(NOTIFICATIONS.USER_ID.eq(user))
                .orderBy(NOTIFICATIONS.AT.desc(), NOTIFICATIONS.ID.desc()).limit(SHOWN).fetch();
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("items", views(ctx, user, mine));
        answer.put("unread", unread(ctx, user));
        return answer;
    }

    public void markRead(DSLContext ctx, UUID user) {
        ctx.update(NOTIFICATIONS).set(NOTIFICATIONS.READ, true).where(NOTIFICATIONS.USER_ID.eq(user)).and(NOTIFICATIONS.READ.isFalse()).execute();
    }

    List<Map<String, Object>> views(DSLContext ctx, UUID viewer, List<NotificationsRecord> entries) {
        if (entries.isEmpty()) return List.of();
        Set<UUID> eventIds = new HashSet<>();
        Set<UUID> actors = new HashSet<>();
        for (NotificationsRecord entry : entries) {
            if (entry.getEventId() != null) eventIds.add(entry.getEventId());
            actors.addAll(Arrays.asList(entry.getActors()));
        }
        Map<UUID, EventsRecord> byId = new HashMap<>();
        if (!eventIds.isEmpty()) for (EventsRecord event : ctx.selectFrom(EVENTS).where(EVENTS.ID.in(eventIds)).fetch()) byId.put(event.getId(), event);
        Set<UUID> blocked = Relations.blockedWith(ctx, viewer);
        Set<UUID> knowable = Relations.seesStoryOf(ctx, viewer, actors);
        Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, actors);
        Instant now = clock.instant();
        List<EventsRecord> shownEvents = new ArrayList<>();
        for (EventsRecord event : byId.values()) if (!blocked.contains(event.getCreatorId())) shownEvents.add(event);
        Map<UUID, Map<String, Object>> eventViews = new HashMap<>();
        List<Map<String, Object>> made = events.summaries(ctx, viewer, shownEvents, now);
        for (int i = 0; i < shownEvents.size(); i++) eventViews.put(shownEvents.get(i).getId(), made.get(i));
        List<Map<String, Object>> out = new ArrayList<>();
        for (NotificationsRecord entry : entries) {
            EventsRecord event = entry.getEventId() == null ? null : byId.get(entry.getEventId());
            List<Views.UserSummary> named = new ArrayList<>();
            for (UUID actor : entry.getActors()) {
                Views.UserSummary summary = summaries.get(actor);
                if (summary == null || blocked.contains(actor)) continue;
                // New photos do not say who went to someone who may not know; the organizer knows
                boolean allowed = !"album.photos".equals(entry.getKind()) || knowable.contains(actor)
                        || (event != null && event.getCreatorId().equals(viewer));
                if (allowed && named.size() < ACTORS_SHOWN) named.add(summary);
            }
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("id", Ids.publicId("nt", entry.getId()));
            view.put("kind", entry.getKind());
            view.put("at", entry.getAt());
            view.put("read", entry.getRead());
            view.put("actors", named);
            view.put("count", entry.getCount());
            view.put("event", event == null ? null : eventViews.get(event.getId()));
            view.put("data", entry.getData() == null ? Json.object() : Json.parse(entry.getData().data()));
            out.add(view);
        }
        return out;
    }

    /** Lists (what changed) add up, the rest is the latest. */
    static JSONB merge(@Nullable JSONB old, Map<String, Object> data) {
        ObjectNode merged = old == null ? Json.object() : (ObjectNode) Json.parse(old.data());
        for (Map.Entry<String, Object> entry : data.entrySet()) {
            JsonNode value = Json.tree(entry.getValue());
            JsonNode before = merged.get(entry.getKey());
            if (value.isArray() && before != null && before.isArray()) {
                TreeSet<String> all = new TreeSet<>();
                for (Iterator<JsonNode> it = before.iterator(); it.hasNext(); ) all.add(it.next().asString());
                for (Iterator<JsonNode> it = value.iterator(); it.hasNext(); ) all.add(it.next().asString());
                ArrayNode list = merged.putArray(entry.getKey());
                for (String item : all) list.add(item);
            } else {
                merged.set(entry.getKey(), value);
            }
        }
        return JSONB.valueOf(Json.text(merged));
    }
}
