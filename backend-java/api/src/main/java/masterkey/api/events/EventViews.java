// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.events;

import static masterkey.store.db.Tables.ALBUM_SETTINGS;
import static masterkey.store.db.Tables.CONNECTIONS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.EVENT_RATINGS;
import static masterkey.store.db.Tables.EVENT_SAVED;
import static masterkey.store.db.Tables.PROMOTIONS;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.api.Urls;
import masterkey.api.common.People;
import masterkey.api.common.Relations;
import masterkey.api.people.Views;
import masterkey.core.Ids;
import masterkey.store.db.tables.records.AlbumSettingsRecord;
import masterkey.store.db.tables.records.EventRatingsRecord;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.PromotionsRecord;
import masterkey.api.money.Promotions;
import org.jooq.DSLContext;
import org.jooq.Record3;
import org.jspecify.annotations.Nullable;

/**
 * EventSummary and Event of API.md, each made for the one who reads it ({@code views.event_summary},
 * {@code event_detail}): following, saved and friends are theirs. A list costs a handful of
 * queries whatever its length, never one per event (§7.4).
 */
public final class EventViews {

    static final int FRIENDS_SHOWN = 3;
    static final int MAX_FOLLOWERS = 200;
    static final int MAX_RATINGS = 100;

    private final People people;
    private final Urls urls;

    public EventViews(People people, Urls urls) {
        this.people = people;
        this.urls = urls;
    }

    public static String publicId(UUID event) {
        return Ids.publicId("ev", event);
    }

    public static String status(EventsRecord event, Instant now) {
        if (event.getCancelledAt() != null) return "cancelled";
        if (!now.isBefore(event.getEndsAt())) return "concluded";
        if (!now.isBefore(event.getStartsAt())) return "ongoing";
        return "upcoming";
    }

    /** It happened, even in part: it stays in the lists. Only one cancelled before it began can leave them. */
    public static boolean tookPlace(EventsRecord event, Instant now) {
        Instant cancelled = event.getCancelledAt();
        if (cancelled != null) return !cancelled.isBefore(event.getStartsAt());
        return "concluded".equals(status(event, now));
    }

    /** What a list shows of each event, for this viewer, in the order given. */
    public List<Map<String, Object>> summaries(DSLContext ctx, UUID viewer, List<EventsRecord> events, Instant now) {
        if (events.isEmpty()) return List.of();
        List<UUID> ids = events.stream().map(EventsRecord::getId).toList();
        Map<UUID, PromotionsRecord> promotions = new HashMap<>();
        for (PromotionsRecord promotion : ctx.selectFrom(PROMOTIONS).where(PROMOTIONS.EVENT_ID.in(ids)).fetch()) {
            promotions.put(promotion.getEventId(), promotion);
        }
        Set<UUID> following = new HashSet<>(ctx.select(EVENT_ATTENDEES.EVENT_ID).from(EVENT_ATTENDEES)
                .where(EVENT_ATTENDEES.USER_ID.eq(viewer)).and(EVENT_ATTENDEES.EVENT_ID.in(ids)).fetch(EVENT_ATTENDEES.EVENT_ID));
        Set<UUID> saved = new HashSet<>(ctx.select(EVENT_SAVED.EVENT_ID).from(EVENT_SAVED)
                .where(EVENT_SAVED.USER_ID.eq(viewer)).and(EVENT_SAVED.EVENT_ID.in(ids)).fetch(EVENT_SAVED.EVENT_ID));
        // The viewer's connections going: first joined first (a block ends a connection)
        Map<UUID, List<UUID>> friends = new HashMap<>();
        for (Record3<UUID, UUID, Instant> row : ctx.select(EVENT_ATTENDEES.EVENT_ID, EVENT_ATTENDEES.USER_ID, EVENT_ATTENDEES.JOINED_AT)
                .from(EVENT_ATTENDEES).join(CONNECTIONS).on(CONNECTIONS.OTHER_ID.eq(EVENT_ATTENDEES.USER_ID)).and(CONNECTIONS.USER_ID.eq(viewer))
                .where(EVENT_ATTENDEES.EVENT_ID.in(ids)).orderBy(EVENT_ATTENDEES.JOINED_AT, EVENT_ATTENDEES.USER_ID).fetch()) {
            friends.computeIfAbsent(row.value1(), key -> new ArrayList<>()).add(row.value2());
        }
        Set<UUID> named = new HashSet<>();
        for (EventsRecord event : events) {
            named.add(event.getCreatorId());
            List<UUID> theirs = friends.getOrDefault(event.getId(), List.of());
            named.addAll(theirs.subList(0, Math.min(FRIENDS_SHOWN, theirs.size())));
        }
        Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, named);
        List<Map<String, Object>> out = new ArrayList<>(events.size());
        for (EventsRecord event : events) {
            List<UUID> theirs = friends.getOrDefault(event.getId(), List.of());
            out.add(summary(event, promotions.get(event.getId()), summaries, following.contains(event.getId()),
                    saved.contains(event.getId()), theirs, now));
        }
        return out;
    }

    public Map<String, Object> summary(DSLContext ctx, UUID viewer, EventsRecord event, Instant now) {
        return summaries(ctx, viewer, List.of(event), now).getFirst();
    }

    private Map<String, Object> summary(EventsRecord event, @Nullable PromotionsRecord promotion, Map<UUID, Views.UserSummary> summaries,
                                        boolean following, boolean saved, List<UUID> friends, Instant now) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", publicId(event.getId()));
        view.put("title", event.getTitle());
        view.put("description", event.getDescription());
        view.put("categories", List.of(event.getCategories()));
        Map<String, Object> location = new LinkedHashMap<>();
        location.put("latitude", event.getLatitude());
        location.put("longitude", event.getLongitude());
        location.put("address", event.getAddress());
        view.put("location", location);
        Map<String, Object> dates = new LinkedHashMap<>();
        dates.put("creationDate", event.getCreatedAt());
        dates.put("startDate", event.getStartsAt());
        dates.put("endDate", event.getEndsAt());
        if (event.getModifiedAt() != null) dates.put("modifiedDate", event.getModifiedAt());
        if (event.getCancelledAt() != null) dates.put("cancelDate", event.getCancelledAt());
        view.put("dates", dates);
        view.put("status", status(event, now));
        view.put("flash", event.getFlash());
        view.put("spotsNeeded", event.getSpotsNeeded());
        view.put("theme", EventTheme.read(event.getTheme()));
        List<String> images = new ArrayList<>();
        for (String key : event.getImageKeys()) {
            String url = urls.media(key);
            if (url != null) images.add(url);
        }
        view.put("imageUrls", images);
        view.put("links", event.getLinks());
        view.put("creator", summaries.get(event.getCreatorId()));
        view.put("followerCount", event.getFollowerCount());
        view.put("photoCount", event.getPhotoCount());
        view.put("following", following);
        view.put("saved", saved);
        view.put("friendsGoing", friends.size());
        List<Views.UserSummary> shown = new ArrayList<>();
        for (UUID friend : friends.subList(0, Math.min(FRIENDS_SHOWN, friends.size()))) {
            Views.UserSummary summary = summaries.get(friend);
            if (summary != null) shown.add(summary);
        }
        view.put("friends", shown);
        view.put("reach", Promotions.reachNow(event, promotion, now));
        view.put("sponsored", Promotions.sponsored(event, promotion, now));
        return view;
    }

    /** The event's page: who goes, its ratings, the album's rules, and for the organizer their promotion. */
    public Map<String, Object> detail(DSLContext ctx, UUID viewer, EventsRecord event, Instant now) {
        Map<String, Object> view = summary(ctx, viewer, event, now);
        boolean organizer = viewer.equals(event.getCreatorId());
        Set<UUID> blocked = Relations.blockedWith(ctx, viewer);
        Set<UUID> mine = Relations.connectionsOf(ctx, viewer);
        // The user first, then their connections, then the others, each in joining order
        List<UUID> going = new ArrayList<>(ctx.select(EVENT_ATTENDEES.USER_ID).from(EVENT_ATTENDEES)
                .where(EVENT_ATTENDEES.EVENT_ID.eq(event.getId())).and(EVENT_ATTENDEES.USER_ID.eq(viewer)
                        .or(EVENT_ATTENDEES.USER_ID.in(mine)))
                .orderBy(EVENT_ATTENDEES.JOINED_AT, EVENT_ATTENDEES.USER_ID).fetch(EVENT_ATTENDEES.USER_ID));
        going.sort((a, b) -> Boolean.compare(!a.equals(viewer), !b.equals(viewer)));
        // Then the others: who lets everyone know they go, or all of them for the organizer
        var others = ctx.select(EVENT_ATTENDEES.USER_ID).from(EVENT_ATTENDEES).where(EVENT_ATTENDEES.EVENT_ID.eq(event.getId()))
                .and(EVENT_ATTENDEES.USER_ID.ne(viewer)).and(mine.isEmpty() ? org.jooq.impl.DSL.trueCondition() : EVENT_ATTENDEES.USER_ID.notIn(mine));
        if (!organizer) others = others.and(EVENT_ATTENDEES.PUBLIC.isTrue());
        going.addAll(others.orderBy(EVENT_ATTENDEES.JOINED_AT, EVENT_ATTENDEES.USER_ID).limit(MAX_FOLLOWERS + blocked.size()).fetch(EVENT_ATTENDEES.USER_ID));
        going.removeIf(blocked::contains);
        if (going.size() > MAX_FOLLOWERS) going = going.subList(0, MAX_FOLLOWERS);
        List<EventRatingsRecord> ratings = ctx.selectFrom(EVENT_RATINGS).where(EVENT_RATINGS.EVENT_ID.eq(event.getId()))
                .orderBy(EVENT_RATINGS.DATE.desc()).fetch();
        ratings.removeIf(rating -> blocked.contains(rating.getUserId()));
        EventRatingsRecord own = ctx.selectFrom(EVENT_RATINGS).where(EVENT_RATINGS.EVENT_ID.eq(event.getId()))
                .and(EVENT_RATINGS.USER_ID.eq(viewer)).fetchOne();
        List<EventRatingsRecord> shown = ratings.subList(0, Math.min(MAX_RATINGS, ratings.size()));
        Set<UUID> raters = new HashSet<>();
        for (EventRatingsRecord rating : shown) raters.add(rating.getUserId());
        Set<UUID> knowable = Relations.seesStoryOf(ctx, viewer, raters);
        Set<UUID> named = new HashSet<>(going);
        named.addAll(raters);
        named.add(viewer);
        Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, named);
        List<Views.UserSummary> followers = new ArrayList<>();
        for (UUID id : going) {
            Views.UserSummary summary = summaries.get(id);
            if (summary != null) followers.add(summary);
        }
        view.put("followers", followers);
        List<Map<String, Object>> ratingViews = new ArrayList<>();
        // Not named: it counts and it shows, without saying who went
        for (EventRatingsRecord rating : shown) {
            ratingViews.add(rating(rating, organizer || knowable.contains(rating.getUserId()) ? summaries.get(rating.getUserId()) : null));
        }
        view.put("ratings", ratingViews);
        view.put("ratingCount", ratings.size());
        double sum = 0;
        for (EventRatingsRecord rating : ratings) sum += rating.getRating();
        view.put("ratingAverage", ratings.isEmpty() ? null : Math.round(sum / ratings.size() * 100) / 100.0);
        view.put("myRating", own == null ? null : rating(own, summaries.get(viewer)));
        view.put("album", album(ctx, event, viewer));
        if (organizer) {
            view.put("baseReach", event.getReach());
            view.put("promotion", Promotions.view(event, ctx.selectFrom(PROMOTIONS).where(PROMOTIONS.EVENT_ID.eq(event.getId())).fetchOne(), now));
        }
        return view;
    }

    public static Map<String, Object> rating(EventRatingsRecord rating, Views.@Nullable UserSummary user) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", Ids.publicId("rt", rating.getId()));
        view.put("user", user);
        view.put("rating", (double) rating.getRating());
        view.put("comment", rating.getComment());
        view.put("date", rating.getDate());
        if (rating.getModified() != null) view.put("modifiedDate", rating.getModified());
        return view;
    }

    /**
     * Who may add photos. The ones chosen are people going: their names go to the organizer;
     * anyone else learns only whether they themselves are among them.
     */
    public static Map<String, Object> album(DSLContext ctx, EventsRecord event, UUID viewer) {
        AlbumSettingsRecord settings = ctx.selectFrom(ALBUM_SETTINGS).where(ALBUM_SETTINGS.EVENT_ID.eq(event.getId())).fetchOne();
        String who = settings == null ? "everyone" : settings.getWhoCanPost();
        List<UUID> chosen = settings == null ? List.of() : List.of(settings.getContributors());
        List<String> contributors = new ArrayList<>();
        if (viewer.equals(event.getCreatorId())) {
            for (UUID id : chosen) contributors.add(Ids.publicId("usr", id));
        } else if (chosen.contains(viewer)) {
            contributors.add(Ids.publicId("usr", viewer));
        }
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("whoCanPost", who);
        view.put("contributors", contributors);
        return view;
    }

    public static List<UUID> ids(Collection<EventsRecord> events) {
        return events.stream().map(EventsRecord::getId).toList();
    }
}
