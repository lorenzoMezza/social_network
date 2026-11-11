// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.privacy;

import static masterkey.store.db.Tables.BLOCKS;
import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.CONNECTIONS;
import static masterkey.store.db.Tables.CONSENTS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.EVENT_PHOTOS;
import static masterkey.store.db.Tables.EVENT_RATINGS;
import static masterkey.store.db.Tables.EVENT_SAVED;
import static masterkey.store.db.Tables.EXPORT_TOKENS;
import static masterkey.store.db.Tables.MESSAGES;
import static masterkey.store.db.Tables.NOTIFICATIONS;
import static masterkey.store.db.Tables.PUSH_TOKENS;
import static masterkey.store.db.Tables.REPORTS;
import static masterkey.store.db.Tables.STORY_HIDDEN;
import static masterkey.store.db.Tables.USERS;
import static masterkey.store.db.Tables.WALLETS;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import masterkey.api.Urls;
import masterkey.api.chats.Chats;
import masterkey.api.events.EventViews;
import masterkey.api.money.Wallets;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.store.Database;
import masterkey.store.db.tables.records.ChatsRecord;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.UsersRecord;
import org.jooq.Cursor;
import org.jooq.DSLContext;
import org.jooq.JSONB;
import org.jooq.Record4;
import org.jspecify.annotations.Nullable;
import tools.jackson.core.JsonGenerator;
import tools.jackson.databind.JsonNode;

/**
 * A copy of the user's data (GDPR art. 15 and 20; {@code privacy.export_data}): a one-time link
 * of 10 minutes (its hash kept, the token never), then everything the service keeps that is
 * theirs, as JSON. Other people appear by their public name and username only. Written to a
 * temporary file inside a read transaction, sent after it: a slow phone never holds a database
 * connection (§16), and a long history never sits whole in memory.
 */
public final class Export {

    static final Duration VALID = Duration.ofMinutes(10);

    private final Database db;
    private final Urls urls;
    private final InstantSource clock;

    public Export(Database db, Urls urls, InstantSource clock) {
        this.db = db;
        this.urls = urls;
        this.clock = clock;
    }

    public record Ticket(String url, Instant expiresAt) {
        @Override
        public String toString() {
            return "Ticket[…]";
        }
    }

    static byte[] hash(String token) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    /** A new link: 256 random bits, only their hash kept. */
    public Ticket ticket(UUID user) {
        String token = Ids.secret(32);
        Instant expires = clock.instant().plus(VALID);
        db.txRun(ctx -> ctx.insertInto(EXPORT_TOKENS).set(EXPORT_TOKENS.TOKEN_HASH, hash(token)).set(EXPORT_TOKENS.USER_ID, user)
                .set(EXPORT_TOKENS.EXPIRES_AT, expires).execute());
        return new Ticket(urls.api() + "/v1/exports/" + token, expires);
    }

    /** The user a token was made for, once (DELETE … RETURNING) and while it lasts; else null. */
    public @Nullable UUID redeem(String token) {
        if (token.isEmpty() || token.length() > 100) return null;
        Instant now = clock.instant();
        return db.tx(ctx -> ctx.deleteFrom(EXPORT_TOKENS).where(EXPORT_TOKENS.TOKEN_HASH.eq(hash(token))).and(EXPORT_TOKENS.EXPIRES_AT.gt(now))
                .returning(EXPORT_TOKENS.USER_ID).fetchOne(EXPORT_TOKENS.USER_ID));
    }

    /** The copy of the user's data into {@code file}; false when the account is gone. */
    public boolean write(UUID user, Path file) throws IOException {
        try (OutputStream out = Files.newOutputStream(file)) {
            return db.read(ctx -> {
                UsersRecord me = ctx.selectFrom(USERS).where(USERS.ID.eq(user)).fetchOne();
                if (me == null) return false;
                try (JsonGenerator json = Json.MAPPER.createGenerator(out)) {
                    write(ctx, me, json);
                }
                return true;
            });
        }
    }

    private Map<String, Object> person(DSLContext ctx, UUID other, Map<UUID, UsersRecord> known) {
        UsersRecord row = known.computeIfAbsent(other, id -> ctx.selectFrom(USERS).where(USERS.ID.eq(id)).fetchOne());
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", Ids.publicId("usr", other));
        if (row != null) {
            view.put("username", row.getUsername());
            view.put("name", row.getName());
        }
        return view;
    }

    private static @Nullable JsonNode json(@Nullable JSONB value) {
        return value == null ? null : Json.parse(value.data());
    }

    private void write(DSLContext ctx, UsersRecord me, JsonGenerator out) {
        UUID uid = me.getId();
        Map<UUID, UsersRecord> known = new HashMap<>();
        out.writeStartObject();
        out.writeStringProperty("format", "masterkey.export");
        out.writeNumberProperty("version", 1);
        out.writePOJOProperty("exportedAt", clock.instant());
        out.writePOJOProperty("notes", List.of(
                "Your position on the map is never stored as history: only the latest one, in memory, while the map is open.",
                "Messages show what you sent; the conversations themselves also belong to the people you wrote with."));
        Map<String, Object> account = new LinkedHashMap<>();
        account.put("id", Ids.publicId("usr", uid));
        account.put("username", me.getUsername());
        account.put("name", me.getName());
        account.put("email", me.getEmail());
        account.put("bio", me.getBio());
        account.put("picture", urls.media(me.getPictureKey()));
        account.put("created", me.getCreatedAt());
        out.writePOJOProperty("account", account);
        out.writePOJOProperty("settings", json(me.getSettings()));
        Map<String, List<Map<String, Object>>> consents = new LinkedHashMap<>();
        for (var row : ctx.selectFrom(CONSENTS).where(CONSENTS.USER_ID.eq(uid)).orderBy(CONSENTS.KIND, CONSENTS.AT).fetch()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("version", row.getVersion());
            entry.put("at", row.getAt());
            if (row.getMode() != null) entry.put("mode", row.getMode());
            consents.computeIfAbsent(row.getKind(), kind -> new java.util.ArrayList<>()).add(entry);
        }
        out.writePOJOProperty("consents", consents);
        out.writePOJOProperty("profileStyle", json(me.getStyle()));
        out.writePOJOProperty("avatar", json(me.getAvatar()));
        out.writePOJOProperty("pushTokens", ctx.select(PUSH_TOKENS.PLATFORM).from(PUSH_TOKENS).where(PUSH_TOKENS.USER_ID.eq(uid))
                .fetch(PUSH_TOKENS.PLATFORM).stream().map(platform -> Map.of("platform", platform)).toList());

        out.writeArrayPropertyStart("connections");
        for (var row : ctx.selectFrom(CONNECTIONS).where(CONNECTIONS.USER_ID.eq(uid)).orderBy(CONNECTIONS.SINCE).fetch()) {
            Map<String, Object> entry = person(ctx, row.getOtherId(), known);
            entry.put("since", row.getSince());
            entry.put("place", row.getPlace());
            out.writePOJO(entry);
        }
        out.writeEndArray();
        out.writeArrayPropertyStart("blocked");
        for (var row : ctx.selectFrom(BLOCKS).where(BLOCKS.BLOCKER.eq(uid)).orderBy(BLOCKS.SINCE).fetch()) {
            Map<String, Object> entry = person(ctx, row.getBlocked(), known);
            entry.put("since", row.getSince());
            out.writePOJO(entry);
        }
        out.writeEndArray();

        out.writeArrayPropertyStart("eventsOrganized");
        for (EventsRecord event : ctx.selectFrom(EVENTS).where(EVENTS.CREATOR_ID.eq(uid)).orderBy(EVENTS.CREATED_AT).fetch()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("id", EventViews.publicId(event.getId()));
            entry.put("title", event.getTitle());
            entry.put("description", event.getDescription());
            entry.put("categories", List.of(event.getCategories()));
            entry.put("latitude", event.getLatitude());
            entry.put("longitude", event.getLongitude());
            entry.put("address", event.getAddress());
            entry.put("start", event.getStartsAt());
            entry.put("end", event.getEndsAt());
            entry.put("created", event.getCreatedAt());
            entry.put("cancelled", event.getCancelledAt());
            entry.put("links", event.getLinks());
            entry.put("pictures", List.of(event.getImageKeys()).stream().map(urls::media).toList());
            out.writePOJO(entry);
        }
        out.writeEndArray();
        out.writePOJOProperty("eventsFollowed", ctx.select(EVENT_ATTENDEES.EVENT_ID, EVENT_ATTENDEES.JOINED_AT).from(EVENT_ATTENDEES)
                .where(EVENT_ATTENDEES.USER_ID.eq(uid)).orderBy(EVENT_ATTENDEES.JOINED_AT).fetch()
                .map(row -> Map.of("eventId", EventViews.publicId(row.value1()), "since", row.value2())));
        out.writePOJOProperty("eventsSaved", ctx.select(EVENT_SAVED.EVENT_ID, EVENT_SAVED.SINCE).from(EVENT_SAVED)
                .where(EVENT_SAVED.USER_ID.eq(uid)).orderBy(EVENT_SAVED.SINCE).fetch()
                .map(row -> Map.of("eventId", EventViews.publicId(row.value1()), "since", row.value2())));
        Map<String, Object> story = new LinkedHashMap<>();
        story.put("audience", me.getStoryAudience());
        story.put("shows", json(me.getStory()));
        story.put("hiddenMoments", ctx.select(STORY_HIDDEN.MOMENT_ID).from(STORY_HIDDEN).where(STORY_HIDDEN.USER_ID.eq(uid))
                .orderBy(STORY_HIDDEN.MOMENT_ID).fetch(STORY_HIDDEN.MOMENT_ID));
        out.writePOJOProperty("story", story);
        out.writeArrayPropertyStart("notifications");
        for (var row : ctx.select(NOTIFICATIONS.KIND, NOTIFICATIONS.AT, NOTIFICATIONS.EVENT_ID).from(NOTIFICATIONS)
                .where(NOTIFICATIONS.USER_ID.eq(uid)).orderBy(NOTIFICATIONS.AT).fetch()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("kind", row.value1());
            entry.put("at", row.value2());
            entry.put("eventId", row.value3() == null ? null : EventViews.publicId(row.value3()));
            out.writePOJO(entry);
        }
        out.writeEndArray();
        out.writeArrayPropertyStart("ratings");
        for (var row : ctx.selectFrom(EVENT_RATINGS).where(EVENT_RATINGS.USER_ID.eq(uid)).orderBy(EVENT_RATINGS.DATE).fetch()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("eventId", EventViews.publicId(row.getEventId()));
            entry.put("rating", row.getRating());
            entry.put("comment", row.getComment());
            entry.put("date", row.getDate());
            out.writePOJO(entry);
        }
        out.writeEndArray();
        out.writeArrayPropertyStart("photosPosted");
        for (var row : ctx.selectFrom(EVENT_PHOTOS).where(EVENT_PHOTOS.AUTHOR_ID.eq(uid)).orderBy(EVENT_PHOTOS.CREATED_AT).fetch()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("eventId", EventViews.publicId(row.getEventId()));
            entry.put("id", Ids.publicId("ph", row.getId()));
            entry.put("url", urls.media(row.getKey()));
            entry.put("posted", row.getCreatedAt());
            out.writePOJO(entry);
        }
        out.writeEndArray();
        writeChats(ctx, uid, out);
        Map<String, Object> credits = null;
        if (ctx.fetchExists(WALLETS, WALLETS.USER_ID.eq(uid))) {
            credits = new LinkedHashMap<>(Wallets.view(ctx, uid));
            credits.remove("accountToken");
        }
        out.writePOJOProperty("promotionCredits", credits);
        out.writeArrayPropertyStart("reportsFiled");
        for (var row : ctx.selectFrom(REPORTS).where(REPORTS.BY_USER.eq(uid)).orderBy(REPORTS.AT).fetch()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("kind", row.getKind());
            entry.put("targetId", row.getTargetId());
            entry.put("reasons", List.of(row.getReasons()));
            entry.put("details", row.getDetails());
            entry.put("at", row.getAt());
            out.writePOJO(entry);
        }
        out.writeEndArray();
        out.writeEndObject();
    }

    /** The messages they sent, chat by chat, read with a cursor: a long history is never whole in memory. */
    private static void writeChats(DSLContext ctx, UUID uid, JsonGenerator out) {
        out.writeArrayPropertyStart("chats");
        UUID current = null;
        try (Cursor<Record4<UUID, UUID, String, Instant>> rows = ctx.select(MESSAGES.CHAT_ID, MESSAGES.ID, MESSAGES.TEXT, MESSAGES.AT)
                .from(MESSAGES).where(MESSAGES.SENDER.eq(uid)).and(MESSAGES.SYSTEM.isFalse()).and(MESSAGES.DELETED_AT.isNull())
                .orderBy(MESSAGES.CHAT_ID, MESSAGES.SEQ).fetchSize(1000).fetchLazy()) {
            for (Record4<UUID, UUID, String, Instant> row : rows) {
                if (!row.value1().equals(current)) {
                    if (current != null) {
                        out.writeEndArray();
                        out.writeEndObject();
                    }
                    current = row.value1();
                    UUID chatId = current;
                    ChatsRecord chat = ctx.selectFrom(CHATS).where(CHATS.ID.eq(chatId)).fetchOne();
                    out.writeStartObject();
                    out.writeStringProperty("chatId", chat == null ? Ids.publicId("chat", chatId) : Chats.publicId(chat));
                    out.writeStringProperty("kind", chat == null ? "event" : chat.getKind());
                    out.writePOJOProperty("title", chat == null ? null : chat.getTitle());
                    out.writeArrayPropertyStart("messagesSent");
                }
                out.writeStartObject();
                out.writeStringProperty("id", Chats.messageId(row.value2()));
                out.writeStringProperty("text", row.value3());
                out.writePOJOProperty("at", row.value4());
                out.writeEndObject();
            }
        }
        if (current != null) {
            out.writeEndArray();
            out.writeEndObject();
        }
        out.writeEndArray();
    }
}
