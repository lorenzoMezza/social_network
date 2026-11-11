// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.privacy;

import static masterkey.store.db.Tables.ALBUM_SETTINGS;
import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.CHAT_MEMBERS;
import static masterkey.store.db.Tables.ERASED_ACCOUNTS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.EVENT_PHOTOS;
import static masterkey.store.db.Tables.EVENT_RATINGS;
import static masterkey.store.db.Tables.EVENT_SAVED;
import static masterkey.store.db.Tables.NOTIFICATIONS;
import static masterkey.store.db.Tables.PROMOTIONS;
import static masterkey.store.db.Tables.REPORTS;
import static masterkey.store.db.Tables.SENT_MESSAGES;
import static masterkey.store.db.Tables.UPLOADS;
import static masterkey.store.db.Tables.USERS;

import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiConsumer;
import masterkey.api.Limits;
import masterkey.api.chats.Chats;
import masterkey.api.common.Later;
import masterkey.api.common.Outbox;
import masterkey.api.events.EventNotifier;
import masterkey.api.events.EventViews;
import masterkey.api.money.Promotions;
import masterkey.api.money.Wallets;
import masterkey.api.notifications.Notifications;
import masterkey.api.people.ConnectSessions;
import masterkey.auth.TokenVerifier;
import masterkey.presence.Presence;
import masterkey.store.Database;
import masterkey.store.db.tables.records.ChatsRecord;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.UploadsRecord;
import masterkey.store.db.tables.records.UsersRecord;
import org.jooq.DSLContext;
import org.jooq.impl.DSL;

/**
 * DELETE /me (GDPR art. 17; API.md; {@code privacy.erase_user}): everything that is the user's,
 * in one transaction under the person's lock; what can be long (their messages everywhere, the
 * chats of their events, the files, the identity at Logto) as jobs written in it, so that they
 * happen if and only if the account is gone. After the commit: sockets closed with 4001, the
 * presence forgets them, a token issued before can no longer make the account again.
 */
public final class Erasure {

    private final Database db;
    private final Chats chats;
    private final Notifications notifications;
    private final EventNotifier notifier;
    private final Outbox outbox;
    private final Later later;
    private final Presence presence;
    private final Limits limits;
    private final ConnectSessions sessions;
    private final TokenVerifier tokens;
    private final BiConsumer<String, Instant> erasedNow;
    private final InstantSource clock;

    public Erasure(Database db, Chats chats, Notifications notifications, EventNotifier notifier, Outbox outbox, Later later,
                   Presence presence, Limits limits, ConnectSessions sessions, TokenVerifier tokens, BiConsumer<String, Instant> erasedNow,
                   InstantSource clock) {
        this.db = db;
        this.chats = chats;
        this.notifications = notifications;
        this.notifier = notifier;
        this.outbox = outbox;
        this.later = later;
        this.presence = presence;
        this.limits = limits;
        this.sessions = sessions;
        this.tokens = tokens;
        this.erasedNow = erasedNow;
        this.clock = clock;
    }

    /** Erases the account; an account already gone is the same answer (a DELETE sent again). */
    public void erase(UUID user, String sub) {
        Instant now = clock.instant();
        db.txRun(ctx -> {
            Database.lockPerson(ctx, user);
            UsersRecord me = ctx.selectFrom(USERS).where(USERS.ID.eq(user)).forUpdate().fetchOne();
            if (me == null) return;
            List<String> files = new ArrayList<>();
            if (me.getPictureKey() != null) files.add(me.getPictureKey());
            List<UUID> gone = new ArrayList<>();
            ownEvents(ctx, user, now, files, gone);
            othersEvents(ctx, user, files);
            chats(ctx, user, files);
            ctx.deleteFrom(SENT_MESSAGES).where(SENT_MESSAGES.SENDER.eq(user)).execute();
            // Their name leaves others' notifications; reports they filed stay, without them
            ctx.update(NOTIFICATIONS).set(NOTIFICATIONS.ACTORS, DSL.field("array_remove({0}, {1})", NOTIFICATIONS.ACTORS.getDataType(),
                    NOTIFICATIONS.ACTORS, DSL.val(user))).where(DSL.condition("{0} @> ARRAY[{1}]::uuid[]", NOTIFICATIONS.ACTORS, DSL.val(user))).execute();
            ctx.update(REPORTS).setNull(REPORTS.BY_USER).where(REPORTS.BY_USER.eq(user)).execute();
            // Uploads never used: their files
            for (UploadsRecord upload : ctx.selectFrom(UPLOADS).where(UPLOADS.USER_ID.eq(user)).and(UPLOADS.USED.isFalse()).fetch()) {
                files.add(upload.getStorageKey());
                files.addAll(List.of(upload.getOutputKeys()));
            }
            // The wallet goes with the account; its purchases stay known, never credited again
            Wallets.forget(ctx, user);
            // A token issued before must not make the account again (2 hours, more than a token lives)
            ctx.insertInto(ERASED_ACCOUNTS).set(ERASED_ACCOUNTS.SUB, sub).set(ERASED_ACCOUNTS.AT, now)
                    .onConflict(ERASED_ACCOUNTS.SUB).doUpdate().set(ERASED_ACCOUNTS.AT, now).execute();
            // The rest goes with the row: connections both ways, blocks, push tokens, consents, saved
            // events, ratings, photos, memberships, votes, notifications, uploads, links, the wallet
            ctx.deleteFrom(USERS).where(USERS.ID.eq(user)).execute();
            later.deleteFiles(files);
            later.eraseMessages(user, gone);
            later.deleteIdentity(sub);
            outbox.afterCommit(() -> {
                erasedNow.accept(sub, now);
                tokens.forget(sub);
                presence.accountErased(user);
                sessions.forget(user);
                limits.forget(user);
            });
        });
    }

    /**
     * The events they organized, with everything that hangs from them. Who was going to one not
     * over is told, with its title (the event itself will be gone); who has it on a list or the
     * map asks for theirs again.
     */
    private void ownEvents(DSLContext ctx, UUID user, Instant now, List<String> files, List<UUID> gone) {
        for (EventsRecord event : ctx.selectFrom(EVENTS).where(EVENTS.CREATOR_ID.eq(user)).orderBy(EVENTS.ID).forUpdate().fetch()) {
            UUID id = event.getId();
            int reach = Promotions.reachNow(event, ctx.selectFrom(PROMOTIONS).where(PROMOTIONS.EVENT_ID.eq(id)).fetchOne(), now);
            Set<UUID> involved = new LinkedHashSet<>(ctx.select(EVENT_ATTENDEES.USER_ID).from(EVENT_ATTENDEES)
                    .where(EVENT_ATTENDEES.EVENT_ID.eq(id)).fetch(EVENT_ATTENDEES.USER_ID));
            Set<UUID> followers = new LinkedHashSet<>(involved);
            involved.addAll(ctx.select(EVENT_SAVED.USER_ID).from(EVENT_SAVED).where(EVENT_SAVED.EVENT_ID.eq(id)).fetch(EVENT_SAVED.USER_ID));
            involved.remove(user);
            followers.remove(user);
            if (event.getCancelledAt() == null && now.isBefore(event.getEndsAt())) {
                event.setCancelledAt(now);
                event.update();
                notifications.notifyGoing(ctx, event, "event.cancelled", null, Map.of("title", event.getTitle()), List.of(), List.of());
            }
            UUID chat = ctx.select(CHATS.ID).from(CHATS).where(CHATS.EVENT_ID.eq(id)).fetchOne(CHATS.ID);
            if (chat != null) gone.add(chat);
            files.addAll(List.of(event.getImageKeys()));
            ctx.select(EVENT_PHOTOS.KEY, EVENT_PHOTOS.THUMB_KEY).from(EVENT_PHOTOS).where(EVENT_PHOTOS.EVENT_ID.eq(id)).fetch()
                    .forEach(photo -> {
                        files.add(photo.value1());
                        files.add(photo.value2());
                    });
            outbox.send(followers, Map.of("type", "chat.removed", "chatId", "event:" + EventViews.publicId(id)));
            notifier.gone(event, reach, involved);
            // Attendees, saved, ratings, photos, album, its chat and promotion go with the row
            ctx.deleteFrom(EVENTS).where(EVENTS.ID.eq(id)).execute();
        }
    }

    /** What they did on other people's events: the counters there go down; the rows go with the account. */
    private static void othersEvents(DSLContext ctx, UUID user, List<String> files) {
        Set<UUID> touched = new java.util.TreeSet<>(masterkey.core.Ids::compare);
        touched.addAll(ctx.select(EVENT_ATTENDEES.EVENT_ID).from(EVENT_ATTENDEES).where(EVENT_ATTENDEES.USER_ID.eq(user)).fetch(EVENT_ATTENDEES.EVENT_ID));
        Map<UUID, Double> rated = new HashMap<>();
        ctx.select(EVENT_RATINGS.EVENT_ID, EVENT_RATINGS.RATING).from(EVENT_RATINGS).where(EVENT_RATINGS.USER_ID.eq(user)).fetch()
                .forEach(row -> rated.put(row.value1(), row.value2().doubleValue()));
        Map<UUID, Integer> photos = new HashMap<>();
        ctx.select(EVENT_PHOTOS.EVENT_ID, EVENT_PHOTOS.KEY, EVENT_PHOTOS.THUMB_KEY).from(EVENT_PHOTOS).where(EVENT_PHOTOS.AUTHOR_ID.eq(user)).fetch()
                .forEach(row -> {
                    photos.merge(row.value1(), 1, Integer::sum);
                    files.add(row.value2());
                    files.add(row.value3());
                });
        touched.addAll(rated.keySet());
        touched.addAll(photos.keySet());
        if (touched.isEmpty()) return;
        // Locked in one order, as every request locks one event: no two wait for each other
        ctx.select(EVENTS.ID).from(EVENTS).where(EVENTS.ID.in(touched)).orderBy(EVENTS.ID).forUpdate().fetch();
        ctx.update(EVENTS).set(EVENTS.FOLLOWER_COUNT, DSL.greatest(EVENTS.FOLLOWER_COUNT.minus(1), DSL.inline(0)))
                .set(EVENTS.GUEST_COUNT, DSL.greatest(EVENTS.GUEST_COUNT.minus(1), DSL.inline(0)))
                .where(EVENTS.ID.in(ctx.select(EVENT_ATTENDEES.EVENT_ID).from(EVENT_ATTENDEES).where(EVENT_ATTENDEES.USER_ID.eq(user)))).execute();
        rated.forEach((event, rating) -> ctx.update(EVENTS).set(EVENTS.RATING_COUNT, DSL.greatest(EVENTS.RATING_COUNT.minus(1), DSL.inline(0)))
                .set(EVENTS.RATING_SUM, EVENTS.RATING_SUM.minus(rating)).where(EVENTS.ID.eq(event)).execute());
        photos.forEach((event, count) -> ctx.update(EVENTS).set(EVENTS.PHOTO_COUNT, DSL.greatest(EVENTS.PHOTO_COUNT.minus(count), DSL.inline(0)))
                .where(EVENTS.ID.eq(event)).execute());
        ctx.update(ALBUM_SETTINGS).set(ALBUM_SETTINGS.CONTRIBUTORS, DSL.field("array_remove({0}, {1})", ALBUM_SETTINGS.CONTRIBUTORS.getDataType(),
                ALBUM_SETTINGS.CONTRIBUTORS, DSL.val(user))).where(DSL.condition("{0} @> ARRAY[{1}]::uuid[]", ALBUM_SETTINGS.CONTRIBUTORS, DSL.val(user)))
                .execute();
    }

    /**
     * Chats: direct ones go, from the other's phone too. A group they own passes to who has been
     * in it longest (what the others said is theirs), and goes only if nobody is left. Elsewhere
     * they are no longer there; their messages are emptied by the job.
     */
    private void chats(DSLContext ctx, UUID user, List<String> files) {
        List<ChatsRecord> theirs = ctx.selectFrom(CHATS).where(CHATS.ID.in(ctx.select(CHAT_MEMBERS.CHAT_ID).from(CHAT_MEMBERS)
                .where(CHAT_MEMBERS.USER_ID.eq(user)))).orderBy(CHATS.ID).forUpdate().fetch();
        for (ChatsRecord chat : theirs) {
            if ("direct".equals(chat.getKind())) {
                chats.endGroup(ctx, chat);
                continue;
            }
            UUID next = "group".equals(chat.getKind()) && user.equals(chat.getOwnerId()) ? Chats.nextOwner(ctx, chat, user) : null;
            if ("group".equals(chat.getKind()) && user.equals(chat.getOwnerId()) && next == null) {
                if (chat.getPictureKey() != null) files.add(chat.getPictureKey());
                chats.endGroup(ctx, chat);
                continue;
            }
            // Out without a word in the chat: a message with their name would stay after them
            ctx.deleteFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).and(CHAT_MEMBERS.USER_ID.eq(user)).execute();
            ctx.update(CHATS).set(CHATS.MEMBER_COUNT, DSL.greatest(CHATS.MEMBER_COUNT.minus(1), DSL.inline(0))).where(CHATS.ID.eq(chat.getId())).execute();
            if (next != null) chats.handOver(ctx, chat, next);
            else chats.push(ctx, chat.getId(), chats.members(ctx, chat.getId()));
        }
        // Groups they own and are no longer in (cannot happen, but an owner without a row must not stay)
        ctx.update(CHATS).setNull(CHATS.OWNER_ID).where(CHATS.OWNER_ID.eq(user)).execute();
    }
}
