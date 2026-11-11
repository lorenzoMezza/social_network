// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.jobs;

import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.CHAT_MEMBERS;
import static masterkey.store.db.Tables.CHAT_PINS;
import static masterkey.store.db.Tables.ERASED_ACCOUNTS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.EVENT_PHOTOS;
import static masterkey.store.db.Tables.EXPORT_TOKENS;
import static masterkey.store.db.Tables.IDEMPOTENCY_KEYS;
import static masterkey.store.db.Tables.MESSAGES;
import static masterkey.store.db.Tables.NOTIFICATIONS;
import static masterkey.store.db.Tables.POLL_VOTES;
import static masterkey.store.db.Tables.REPORTS;
import static masterkey.store.db.Tables.SENT_MESSAGES;

import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.api.Limits;
import masterkey.api.common.Later;
import masterkey.api.common.Outbox;
import masterkey.api.events.EventNotifier;
import masterkey.api.events.EventViews;
import masterkey.api.media.Storage;
import masterkey.api.media.Uploads;
import masterkey.api.money.Promotions;
import masterkey.api.notifications.Notifications;
import masterkey.auth.LogtoAdmin;
import masterkey.store.Database;
import masterkey.store.db.tables.records.EventsRecord;
import org.jooq.Condition;
import org.jooq.DSLContext;
import org.jooq.Field;
import org.jooq.Table;
import org.jooq.impl.DSL;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * What the jobs do (JAVA-BACKEND.md §8; {@code janitor.py}, {@code privacy.retention_sweep}):
 * short transactions, in batches, never the network inside one (frames and files go after the
 * commit). Each method can run twice and does nothing more the second time.
 */
public final class Work {

    private static final Logger log = LoggerFactory.getLogger(Work.class);

    static final int BATCH = 5_000;
    static final int EVENTS_PER_RUN = 200;
    static final int MESSAGES_PER_STEP = 10_000;
    static final Duration SENT_KEPT = Duration.ofDays(1);
    static final Duration ERASED_KEPT = Duration.ofHours(2);
    static final Duration NOTIFICATIONS_KEPT = Duration.ofDays(60);
    static final Duration REMIND_BEFORE = Duration.ofHours(1);
    /** An event ended longer ago than this when chat.close first sees it: nobody's phone shows its chat. */
    static final Duration CLOSE_LATE = Duration.ofDays(1);
    static final Duration EVENT_CHAT_KEPT = Duration.ofDays(30);
    static final Duration EVENT_KEPT = Duration.ofDays(365);
    static final Duration REPORT_KEPT = Duration.ofDays(365);

    private final Database db;
    private final Storage storage;
    private final Uploads uploads;
    private final Limits limits;
    private final Notifications notifications;
    private final Outbox outbox;
    private final EventNotifier notifier;
    private final Later later;
    private final @Nullable LogtoAdmin logto;
    private final InstantSource clock;

    public Work(Database db, Storage storage, Uploads uploads, Limits limits, Notifications notifications, Outbox outbox,
                EventNotifier notifier, Later later, @Nullable LogtoAdmin logto, InstantSource clock) {
        this.logto = logto;
        this.db = db;
        this.storage = storage;
        this.uploads = uploads;
        this.limits = limits;
        this.notifications = notifications;
        this.outbox = outbox;
        this.notifier = notifier;
        this.later = later;
        this.clock = clock;
    }

    // --- files.delete ---

    public void deleteFiles(List<String> keys) {
        storage.delete(keys);
    }

    // --- account.erase, identity.delete (DELETE /me) ---

    static final int ERASE_BATCH = 1_000;

    /**
     * The messages of a deleted account where its chats stay: emptied of text, poll and author,
     * so that counters, unread and the last message stay what they are ("Message removed" in the
     * app). Then every message of the chats that went with the account. Run twice, nothing more.
     */
    public void eraseMessages(UUID user, List<UUID> chats) {
        Instant now = clock.instant();
        for (UUID chat : chats) emptyChat(chat);
        while (true) {
            int done = db.tx(ctx -> {
                var rows = ctx.select(MESSAGES.CHAT_ID, MESSAGES.SEQ, MESSAGES.ID).from(MESSAGES).where(MESSAGES.SENDER.eq(user))
                        .limit(ERASE_BATCH).fetch();
                if (rows.isEmpty()) return 0;
                List<UUID> ids = rows.map(row -> row.value3());
                ctx.deleteFrom(POLL_VOTES).where(POLL_VOTES.MESSAGE_ID.in(ids)).execute();
                ctx.deleteFrom(CHAT_PINS).where(CHAT_PINS.MESSAGE_ID.in(ids)).execute();
                Map<UUID, List<Long>> byChat = new java.util.HashMap<>();
                for (var row : rows) byChat.computeIfAbsent(row.value1(), key -> new ArrayList<>()).add(row.value2());
                for (var entry : byChat.entrySet()) {
                    // chat_id first: one partition each
                    ctx.update(MESSAGES).set(MESSAGES.TEXT, "").setNull(MESSAGES.POLL).setNull(MESSAGES.CLIENT_ID).setNull(MESSAGES.SENDER)
                            .set(MESSAGES.DELETED_AT, DSL.coalesce(MESSAGES.DELETED_AT, DSL.val(now)))
                            .where(MESSAGES.CHAT_ID.eq(entry.getKey())).and(MESSAGES.SEQ.in(entry.getValue())).execute();
                }
                return rows.size();
            });
            if (done < ERASE_BATCH) return;
        }
    }

    /** Every message of a chat that is gone, a step at a time. */
    private void emptyChat(UUID chat) {
        while (true) {
            Long first = db.read(ctx -> ctx.select(DSL.min(MESSAGES.SEQ)).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat)).fetchOne(0, Long.class));
            if (first == null) return;
            long upTo = first + MESSAGES_PER_STEP;
            db.txRun(ctx -> ctx.deleteFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat)).and(MESSAGES.SEQ.lt(upTo)).execute());
        }
    }

    /** The identity at Logto; without the Management API configured (development) there is nothing to do. */
    public void deleteIdentity(String sub) {
        LogtoAdmin admin = logto;
        if (admin == null) {
            log.warn("identity.delete: LOGTO_M2M_APP_ID is not set, the identity stays at Logto");
            return;
        }
        boolean done;
        try {
            done = admin.deleteUser(sub);
        } catch (java.io.IOException error) {
            throw new java.io.UncheckedIOException(error);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("stopping", interrupted);
        }
        // Not done now: the job fails and is tried again later
        if (!done) throw new IllegalStateException("Logto did not delete the identity");
    }

    // --- cleanup.sweep, every minute ---

    /** Uploads never used, idempotency of 24 hours, export links, erased accounts after 2 hours, old notifications, rate windows. */
    public void cleanup() {
        Instant now = clock.instant();
        uploads.sweep();
        int gone = 0;
        gone += drain(SENT_MESSAGES, SENT_MESSAGES.AT.lt(now.minus(SENT_KEPT)));
        gone += drain(IDEMPOTENCY_KEYS, IDEMPOTENCY_KEYS.AT.lt(now.minus(SENT_KEPT)));
        gone += drain(EXPORT_TOKENS, EXPORT_TOKENS.EXPIRES_AT.lt(now));
        gone += drain(ERASED_ACCOUNTS, ERASED_ACCOUNTS.AT.lt(now.minus(ERASED_KEPT)));
        gone += drain(NOTIFICATIONS, NOTIFICATIONS.AT.lt(now.minus(NOTIFICATIONS_KEPT)));
        limits.sweep();
        if (gone > 0) log.debug("cleanup: {} rows", gone);
    }

    /**
     * Deletes the rows that match, a batch per transaction, a few batches per run: never one
     * statement holding millions of rows. By {@code ctid}: only for tables without partitions
     * (a ctid is unique within one table, not across the partitions of {@code messages}).
     */
    public int drain(Table<?> table, Condition old) {
        Field<Object> ctid = DSL.field("ctid");
        int total = 0;
        for (int round = 0; round < 20; round++) {
            int deleted = db.tx(ctx -> ctx.deleteFrom(table)
                    .where(DSL.condition("ctid = ANY(ARRAY({0}))", DSL.select(ctid).from(table).where(old).limit(BATCH))).execute());
            total += deleted;
            if (deleted < BATCH) break;
        }
        return total;
    }

    // --- promotion.charge, every minute ---

    /** Each promotion due pays its next 24 hours or pauses, in its own transaction (Promotions.tick). */
    public void charge() {
        Instant now = clock.instant();
        for (int round = 0; round < 10; round++) {
            List<UUID> due = db.read(ctx -> Promotions.due(ctx, now, EVENTS_PER_RUN));
            for (UUID event : due) {
                try {
                    db.txRun(ctx -> {
                        Promotions.Changed changed = Promotions.tick(ctx, event, now);
                        if (changed == Promotions.Changed.PAUSED || changed == Promotions.Changed.ENDED) {
                            // A smaller reach: told to whoever saw it from farther
                            notifier.changed(event, Promotions.MAX_RADIUS);
                        }
                        if (changed == Promotions.Changed.PAUSED) {
                            EventsRecord row = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(event)).fetchOne();
                            if (row != null) notifications.notify(ctx, row.getCreatorId(), "promotion.paused", null, row, null);
                        }
                    });
                } catch (RuntimeException error) {
                    // One promotion failing never stops the others: it is due again next minute
                    log.error("promotion.charge: a promotion failed: {}", error.getClass().getSimpleName());
                }
            }
            if (due.size() < EVENTS_PER_RUN) break;
        }
    }

    // --- event.remind, every minute ---

    /** "Starting soon", once per start, within the hour before it: to who joins the event. */
    public void remind() {
        Instant now = clock.instant();
        List<UUID> soon = db.read(ctx -> ctx.select(EVENTS.ID).from(EVENTS).where(EVENTS.CANCELLED_AT.isNull())
                .and(EVENTS.STARTS_AT.gt(now)).and(EVENTS.STARTS_AT.le(now.plus(REMIND_BEFORE)))
                .and(EVENTS.STARTING_NOTIFIED_FOR.isNull().or(EVENTS.STARTING_NOTIFIED_FOR.ne(EVENTS.STARTS_AT)))
                .orderBy(EVENTS.STARTS_AT).limit(EVENTS_PER_RUN).fetch(EVENTS.ID));
        for (UUID id : soon) {
            try {
                db.txRun(ctx -> {
                    EventsRecord event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).forUpdate().skipLocked().fetchOne();
                    // Read again under lock: moved, cancelled or told meanwhile
                    if (event == null || event.getCancelledAt() != null || !event.getStartsAt().isAfter(now)
                            || event.getStartsAt().isAfter(now.plus(REMIND_BEFORE)) || event.getStartsAt().equals(event.getStartingNotifiedFor())) {
                        return;
                    }
                    event.setStartingNotifiedFor(event.getStartsAt());
                    event.update();
                    notifications.notifyGoing(ctx, event, "event.starting", null, null, List.of(), List.of());
                });
            } catch (RuntimeException error) {
                log.error("event.remind: an event failed: {}", error.getClass().getSimpleName());
            }
        }
    }

    // --- chat.close, every minute ---

    /** An event that just ended: its chat leaves the phones of who is online (the others find out at their next load). */
    public void closeChats() {
        Instant now = clock.instant();
        for (int round = 0; round < 10; round++) {
            List<EventsRecord> ended = db.tx(ctx -> {
                List<EventsRecord> rows = ctx.selectFrom(EVENTS).where(EVENTS.CHAT_CLOSED_AT.isNull()).and(EVENTS.CANCELLED_AT.isNull())
                        .and(EVENTS.ENDS_AT.le(now)).orderBy(EVENTS.ENDS_AT).limit(EVENTS_PER_RUN).forUpdate().skipLocked().fetch();
                for (EventsRecord event : rows) {
                    event.setChatClosedAt(now);
                    event.update();
                    if (event.getEndsAt().isBefore(now.minus(CLOSE_LATE))) continue;
                    Set<UUID> members = new LinkedHashSet<>(chatMembers(ctx, event.getId()));
                    members.add(event.getCreatorId());
                    outbox.send(members, Map.of("type", "chat.removed", "chatId", "event:" + EventViews.publicId(event.getId())));
                }
                return rows;
            });
            if (ended.size() < EVENTS_PER_RUN) break;
        }
    }

    private static List<UUID> chatMembers(DSLContext ctx, UUID event) {
        return ctx.select(CHAT_MEMBERS.USER_ID).from(CHAT_MEMBERS).join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
                .where(CHATS.EVENT_ID.eq(event)).fetch(CHAT_MEMBERS.USER_ID);
    }

    // --- retention.sweep, daily (legal/it/compliance/conservazione-dati.md) ---

    /** C4-bis: an event's chat 30 days after its end or cancellation; C5-bis: the event 12 months after, files too; C6: reports after 12 months. */
    public void retention() {
        Instant now = clock.instant();
        Field<Instant> ended = DSL.coalesce(EVENTS.CANCELLED_AT, EVENTS.ENDS_AT);
        for (int round = 0; round < 50; round++) {
            List<UUID> chats = db.read(ctx -> ctx.select(EVENTS.ID).from(EVENTS).where(EVENTS.CHAT_PURGED_AT.isNull())
                    .and(ended.lt(now.minus(EVENT_CHAT_KEPT))).orderBy(ended).limit(EVENTS_PER_RUN).fetch(EVENTS.ID));
            for (UUID event : chats) purgeChat(event, now);
            if (chats.size() < EVENTS_PER_RUN) break;
        }
        for (int round = 0; round < 50; round++) {
            List<UUID> old = db.read(ctx -> ctx.select(EVENTS.ID).from(EVENTS).where(ended.lt(now.minus(EVENT_KEPT)))
                    .orderBy(ended).limit(EVENTS_PER_RUN).fetch(EVENTS.ID));
            for (UUID event : old) eraseEvent(event, now);
            if (old.size() < EVENTS_PER_RUN) break;
        }
        drain(REPORTS, REPORTS.AT.lt(now.minus(REPORT_KEPT)));
    }

    /** The messages of an event's chat, a step at a time, then its votes and pins, and the mark. */
    public void purgeChat(UUID event, Instant now) {
        UUID chat = deleteMessages(event);
        db.txRun(ctx -> {
            EventsRecord row = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(event)).forUpdate().skipLocked().fetchOne();
            if (row == null || row.getChatPurgedAt() != null) return;
            if (chat != null) {
                // Messages sent in the moment between the steps and now
                ctx.deleteFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat)).execute();
                ctx.deleteFrom(POLL_VOTES).where(POLL_VOTES.CHAT_ID.eq(chat)).execute();
                ctx.deleteFrom(CHAT_PINS).where(CHAT_PINS.CHAT_ID.eq(chat)).execute();
            }
            row.setChatPurgedAt(now);
            row.update();
        });
    }

    /** The messages of the event's chat, {@link #MESSAGES_PER_STEP} per transaction (one partition: chat_id). Answers the chat. */
    private @Nullable UUID deleteMessages(UUID event) {
        UUID chat = db.read(ctx -> ctx.select(CHATS.ID).from(CHATS).where(CHATS.EVENT_ID.eq(event)).fetchOne(CHATS.ID));
        if (chat != null) emptyChat(chat);
        return chat;
    }

    /** C5-bis: the event and all that hangs from it (album, ratings, chat, promotion), its files after the commit. */
    public void eraseEvent(UUID event, Instant now) {
        deleteMessages(event);
        db.txRun(ctx -> {
            EventsRecord row = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(event)).forUpdate().skipLocked().fetchOne();
            if (row == null) return;
            Instant end = row.getCancelledAt() != null ? row.getCancelledAt() : row.getEndsAt();
            if (!end.isBefore(now.minus(EVENT_KEPT))) return;
            List<String> files = new ArrayList<>(List.of(row.getImageKeys()));
            ctx.select(EVENT_PHOTOS.KEY, EVENT_PHOTOS.THUMB_KEY).from(EVENT_PHOTOS).where(EVENT_PHOTOS.EVENT_ID.eq(event)).fetch()
                    .forEach(photo -> {
                        files.add(photo.value1());
                        files.add(photo.value2());
                    });
            Set<UUID> followers = new LinkedHashSet<>(ctx.select(EVENT_ATTENDEES.USER_ID).from(EVENT_ATTENDEES)
                    .where(EVENT_ATTENDEES.EVENT_ID.eq(event)).fetch(EVENT_ATTENDEES.USER_ID));
            followers.add(row.getCreatorId());
            UUID chat = ctx.select(CHATS.ID).from(CHATS).where(CHATS.EVENT_ID.eq(event)).fetchOne(CHATS.ID);
            if (chat != null) ctx.deleteFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat)).execute();
            // Everything else goes with the row (ON DELETE CASCADE): attendees, saved, ratings, photos, album, chat, promotion
            ctx.deleteFrom(EVENTS).where(EVENTS.ID.eq(event)).execute();
            later.deleteFiles(files);
            outbox.send(followers, Map.of("type", "chat.removed", "chatId", "event:" + EventViews.publicId(event)));
            outbox.send(followers, Map.of("type", "events.stale"));
        });
    }
}
