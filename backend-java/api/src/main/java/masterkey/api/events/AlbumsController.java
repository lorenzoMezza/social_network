// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.events;

import static masterkey.store.db.Tables.ALBUM_SETTINGS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.EVENT_PHOTOS;
import static masterkey.store.db.Tables.IDEMPOTENCY_KEYS;

import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.api.Urls;
import masterkey.api.common.People;
import masterkey.api.common.Relations;
import masterkey.api.media.Imaging;
import masterkey.api.media.Uploads;
import masterkey.api.notifications.Notifications;
import masterkey.api.people.Views;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.core.Ids;
import masterkey.store.Database;
import masterkey.store.db.tables.records.AlbumSettingsRecord;
import masterkey.store.db.tables.records.EventPhotosRecord;
import masterkey.store.db.tables.records.EventsRecord;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;
import org.jspecify.annotations.Nullable;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/** Albums of events (API.md, Albums; {@code routes/events.py}, albums; JAVA-BACKEND.md §19). */
@RestController
@RequestMapping("/v1")
public class AlbumsController {

    public static final int PHOTOS_PER_EVENT = 500;
    public static final int PHOTOS_PER_PERSON = 30;
    public static final int PHOTOS_BY_ORGANIZER = 200;
    public static final int PHOTOS_PER_DAY = 100;
    public static final int PHOTOS_PER_ACCOUNT = 2000;

    private final Database db;
    private final People people;
    private final Uploads uploads;
    private final Notifications notifications;
    private final Urls urls;
    private final InstantSource clock;

    public AlbumsController(Database db, People people, Uploads uploads, Notifications notifications, Urls urls, InstantSource clock) {
        this.db = db;
        this.people = people;
        this.uploads = uploads;
        this.notifications = notifications;
        this.urls = urls;
        this.clock = clock;
    }

    // --- the rules ---

    /** Who may add a photo now: the album opens when the event starts; who posts is going to it. */
    public static boolean canPost(DSLContext ctx, EventsRecord event, UUID user, Instant now) {
        if (event.getCancelledAt() != null || now.isBefore(event.getStartsAt())) return false;
        if (event.getCreatorId().equals(user)) return true;
        AlbumSettingsRecord settings = ctx.selectFrom(ALBUM_SETTINGS).where(ALBUM_SETTINGS.EVENT_ID.eq(event.getId())).fetchOne();
        String who = settings == null ? "everyone" : settings.getWhoCanPost();
        if ("organizer".equals(who)) return false;
        if (!ctx.fetchExists(EVENT_ATTENDEES, EVENT_ATTENDEES.EVENT_ID.eq(event.getId()).and(EVENT_ATTENDEES.USER_ID.eq(user)))) return false;
        return !"chosen".equals(who) || (settings != null && List.of(settings.getContributors()).contains(user));
    }

    /** 409 album_full, or photo_limit when this person has added all they may (under the lock on the person). */
    public static void checkRoom(DSLContext ctx, EventsRecord event, UUID user, Instant now) {
        int inAlbum = ctx.fetchCount(EVENT_PHOTOS, EVENT_PHOTOS.EVENT_ID.eq(event.getId()));
        if (inAlbum >= PHOTOS_PER_EVENT) throw ApiError.conflict("album_full", "this album is full");
        int allowed = event.getCreatorId().equals(user) ? PHOTOS_BY_ORGANIZER : PHOTOS_PER_PERSON;
        if (ctx.fetchCount(EVENT_PHOTOS, EVENT_PHOTOS.EVENT_ID.eq(event.getId()).and(EVENT_PHOTOS.AUTHOR_ID.eq(user))) >= allowed) {
            throw ApiError.conflict("photo_limit", "at most " + allowed + " photos in an album");
        }
        int kept = ctx.fetchCount(EVENT_PHOTOS, EVENT_PHOTOS.AUTHOR_ID.eq(user));
        int today = ctx.fetchCount(EVENT_PHOTOS, EVENT_PHOTOS.AUTHOR_ID.eq(user).and(EVENT_PHOTOS.CREATED_AT.gt(now.minus(Duration.ofDays(1)))));
        if (kept >= PHOTOS_PER_ACCOUNT || today >= PHOTOS_PER_DAY) throw ApiError.conflict("photo_limit", "you have added all the photos you can for now");
    }

    static int room(DSLContext ctx, EventsRecord event, UUID user) {
        int inAlbum = ctx.fetchCount(EVENT_PHOTOS, EVENT_PHOTOS.EVENT_ID.eq(event.getId()));
        int mine = ctx.fetchCount(EVENT_PHOTOS, EVENT_PHOTOS.EVENT_ID.eq(event.getId()).and(EVENT_PHOTOS.AUTHOR_ID.eq(user)));
        int allowed = event.getCreatorId().equals(user) ? PHOTOS_BY_ORGANIZER : PHOTOS_PER_PERSON;
        return Math.max(0, Math.min(PHOTOS_PER_EVENT - inAlbum, allowed - mine));
    }

    // --- routes ---

    @GetMapping("/events/{eventId}/photos")
    public Map<String, Object> photos(Viewer viewer, @PathVariable String eventId, @RequestParam(required = false) @Nullable String cursor,
                                      @RequestParam(required = false) @Nullable String limit) {
        UUID id = EventsController.id(eventId);
        int size = limit != null && limit.matches("[0-9]{1,4}") ? Math.max(1, Math.min(100, Integer.parseInt(limit))) : 60;
        int start = cursor != null && cursor.matches("[0-9]{1,6}") ? Integer.parseInt(cursor) : 0;
        return db.read(ctx -> {
            EventsRecord event = EventsController.visible(ctx, id, viewer.id(), false);
            Set<UUID> blocked = Relations.blockedWith(ctx, viewer.id());
            List<EventPhotosRecord> shown = event.getCancelledAt() != null ? List.of() : ctx.selectFrom(EVENT_PHOTOS)
                    .where(EVENT_PHOTOS.EVENT_ID.eq(id)).and(blocked.isEmpty() ? DSL.trueCondition() : EVENT_PHOTOS.AUTHOR_ID.notIn(blocked))
                    .orderBy(EVENT_PHOTOS.ID.desc()).fetch();
            List<EventPhotosRecord> page = shown.subList(Math.min(start, shown.size()), Math.min(start + size, shown.size()));
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("settings", EventViews.album(ctx, event, viewer.id()));
            answer.put("items", views(ctx, event, page, viewer.id()));
            answer.put("total", shown.size());
            // How many more the user may add here, so the app never asks for what would fail
            answer.put("room", room(ctx, event, viewer.id()));
            answer.put("nextCursor", start + size < shown.size() ? Integer.toString(start + size) : null);
            return answer;
        });
    }

    @PutMapping("/events/{eventId}/photos/settings")
    public Map<String, Object> settings(Viewer viewer, @PathVariable String eventId, @RequestBody(required = false) @Nullable JsonNode raw) {
        UUID id = EventsController.id(eventId);
        Body body = Body.of(raw);
        String who = body.string("whoCanPost");
        if (!"everyone".equals(who) && !"chosen".equals(who) && !"organizer".equals(who)) {
            throw ApiError.badRequest("whoCanPost: everyone, chosen or organizer");
        }
        JsonNode list = body.raw("contributors");
        return db.tx(ctx -> {
            EventsRecord event = EventsController.own(ctx, id, viewer.id());
            Set<UUID> going = new HashSet<>(ctx.select(EVENT_ATTENDEES.USER_ID).from(EVENT_ATTENDEES).where(EVENT_ATTENDEES.EVENT_ID.eq(id))
                    .fetch(EVENT_ATTENDEES.USER_ID));
            LinkedHashSet<UUID> chosen = new LinkedHashSet<>();
            if (list != null && !list.isNull()) {
                if (!list.isArray()) throw ApiError.badRequest("contributors: people who joined the event");
                for (JsonNode item : list) {
                    UUID person = item.isString() ? Ids.parse("usr", item.stringValue()).orElse(null) : null;
                    if (person == null || !going.contains(person)) throw ApiError.badRequest("contributors: people who joined the event");
                    chosen.add(person);
                }
            }
            ctx.insertInto(ALBUM_SETTINGS).set(ALBUM_SETTINGS.EVENT_ID, id).set(ALBUM_SETTINGS.WHO_CAN_POST, who)
                    .set(ALBUM_SETTINGS.CONTRIBUTORS, chosen.toArray(UUID[]::new))
                    .onConflict(ALBUM_SETTINGS.EVENT_ID).doUpdate().set(ALBUM_SETTINGS.WHO_CAN_POST, who)
                    .set(ALBUM_SETTINGS.CONTRIBUTORS, chosen.toArray(UUID[]::new)).execute();
            return EventViews.album(ctx, event, viewer.id());
        });
    }

    @PostMapping("/events/{eventId}/photos")
    public ResponseEntity<Map<String, Object>> add(Viewer viewer, @PathVariable String eventId, @RequestBody(required = false) @Nullable JsonNode raw,
                                                   @RequestHeader(value = "Idempotency-Key", required = false) @Nullable String key) {
        UUID id = EventsController.id(eventId);
        if (key != null && (key.isEmpty() || key.length() > 64)) throw ApiError.badRequest("Idempotency-Key: at most 64 characters");
        Body body = Body.of(raw);
        Instant now = clock.instant();
        // The same photo sent again (its answer lost): the photo already added, as it is now
        Map<String, Object> again = key == null ? null : db.read(ctx -> again(ctx, viewer.id(), id, key));
        if (again != null) return ResponseEntity.status(HttpStatus.CREATED).body(again);
        Uploads.Claimed claimed = uploads.claim(viewer.id(), body.string("uploadId"), "event-photo", id, null, Imaging.Kind.PHOTO, ctx -> {
            Database.lockPerson(ctx, viewer.id());
            EventsRecord event = EventsController.visible(ctx, id, viewer.id(), false);
            if (!canPost(ctx, event, viewer.id(), now)) throw ApiError.forbidden("you can't add photos to this event");
            checkRoom(ctx, event, viewer.id(), now);
        });
        Map<String, Object> photo;
        try {
            photo = db.tx(ctx -> {
                Database.lockPerson(ctx, viewer.id());
                if (key != null) {
                    Map<String, Object> made = again(ctx, viewer.id(), id, key);
                    if (made != null) {
                        uploads.discardAll(claimed.keys());
                        Uploads.finish(ctx, claimed.upload());
                        return made;
                    }
                }
                EventsRecord event = EventsController.visible(ctx, id, viewer.id(), true);
                if (!canPost(ctx, event, viewer.id(), now)) throw ApiError.forbidden("you can't add photos to this event");
                // Another photo may have come in meanwhile: the limits of now
                checkRoom(ctx, event, viewer.id(), now);
                Imaging.Made big = claimed.files().get(0), thumb = claimed.files().get(1);
                EventPhotosRecord row = ctx.newRecord(EVENT_PHOTOS);
                row.setId(Ids.next());
                row.setEventId(id);
                row.setAuthorId(viewer.id());
                row.setKey(big.key());
                row.setThumbKey(thumb.key());
                row.setWidth(big.width());
                row.setHeight(big.height());
                row.setCreatedAt(now);
                row.insert();
                ctx.update(EVENTS).set(EVENTS.PHOTO_COUNT, EVENTS.PHOTO_COUNT.plus(1)).where(EVENTS.ID.eq(id)).execute();
                Uploads.finish(ctx, claimed.upload());
                if (key != null) {
                    ctx.insertInto(IDEMPOTENCY_KEYS).set(IDEMPOTENCY_KEYS.USER_ID, viewer.id()).set(IDEMPOTENCY_KEYS.SCOPE, "photo")
                            .set(IDEMPOTENCY_KEYS.KEY, key).set(IDEMPOTENCY_KEYS.MADE_ID, row.getId()).set(IDEMPOTENCY_KEYS.AT, now).execute();
                }
                // Who was there (and its organizer) see the album grow; gathered per event
                notifications.notifyGoing(ctx, event, "album.photos", viewer.id(), null, List.of(event.getCreatorId()), List.of(viewer.id()));
                return views(ctx, event, List.of(row), viewer.id()).getFirst();
            });
        } catch (ApiError error) {
            // A limit reached just now, or the right to post gone: the files made go, the upload is used up
            uploads.abandon(claimed, error.status() == 409 || error.status() == 403);
            throw error;
        } catch (RuntimeException error) {
            uploads.abandon(claimed, false);
            throw error;
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(photo);
    }

    private @Nullable Map<String, Object> again(DSLContext ctx, UUID user, UUID event, String key) {
        UUID made = ctx.select(IDEMPOTENCY_KEYS.MADE_ID).from(IDEMPOTENCY_KEYS).where(IDEMPOTENCY_KEYS.USER_ID.eq(user))
                .and(IDEMPOTENCY_KEYS.SCOPE.eq("photo")).and(IDEMPOTENCY_KEYS.KEY.eq(key)).fetchOne(IDEMPOTENCY_KEYS.MADE_ID);
        if (made == null) return null;
        EventPhotosRecord photo = ctx.selectFrom(EVENT_PHOTOS).where(EVENT_PHOTOS.ID.eq(made)).and(EVENT_PHOTOS.EVENT_ID.eq(event)).fetchOne();
        EventsRecord found = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(event)).fetchOne();
        // Removed meanwhile: it does not come back (the upload is used: 410)
        return photo == null || found == null ? null : views(ctx, found, List.of(photo), user).getFirst();
    }

    @DeleteMapping("/events/{eventId}/photos/{photoId}")
    public ResponseEntity<Void> remove(Viewer viewer, @PathVariable String eventId, @PathVariable String photoId) {
        UUID id = EventsController.id(eventId);
        UUID photo = Ids.parse("ph", photoId).orElseThrow(() -> ApiError.notFound("photo not found"));
        db.txRun(ctx -> {
            EventsRecord event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).fetchOne();
            EventPhotosRecord row = ctx.selectFrom(EVENT_PHOTOS).where(EVENT_PHOTOS.ID.eq(photo)).and(EVENT_PHOTOS.EVENT_ID.eq(id)).forUpdate().fetchOne();
            // Their own photo: they can take it back also from who blocked them
            if (event == null || row == null || (!row.getAuthorId().equals(viewer.id()) && Relations.blockedEither(ctx, viewer.id(), event.getCreatorId()))) {
                throw ApiError.notFound("photo not found");
            }
            if (!viewer.id().equals(row.getAuthorId()) && !viewer.id().equals(event.getCreatorId())) throw ApiError.forbidden("only its author or the organizer");
            row.delete();
            ctx.update(EVENTS).set(EVENTS.PHOTO_COUNT, DSL.greatest(EVENTS.PHOTO_COUNT.minus(1), DSL.inline(0))).where(EVENTS.ID.eq(id)).execute();
            uploads.discard(row.getKey(), row.getThumbKey());
        });
        return ResponseEntity.noContent().build();
    }

    /** Photo of API.md: not named to who may not know its author went (never to its author or the organizer). */
    List<Map<String, Object>> views(DSLContext ctx, EventsRecord event, List<EventPhotosRecord> photos, UUID viewer) {
        Set<UUID> authors = new HashSet<>();
        for (EventPhotosRecord photo : photos) authors.add(photo.getAuthorId());
        Set<UUID> knowable = Relations.seesStoryOf(ctx, viewer, authors);
        Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, authors);
        boolean organizer = event.getCreatorId().equals(viewer);
        List<Map<String, Object>> out = new ArrayList<>();
        for (EventPhotosRecord photo : photos) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("id", Ids.publicId("ph", photo.getId()));
            view.put("eventId", EventViews.publicId(photo.getEventId()));
            view.put("url", urls.media(photo.getKey()));
            view.put("thumbUrl", urls.media(photo.getThumbKey()));
            view.put("width", photo.getWidth());
            view.put("height", photo.getHeight());
            view.put("author", organizer || knowable.contains(photo.getAuthorId()) ? summaries.get(photo.getAuthorId()) : null);
            view.put("createdAt", photo.getCreatedAt());
            out.add(view);
        }
        return out;
    }
}
