// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.jobs.push;

import static masterkey.store.db.Tables.BLOCKS;
import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.CHAT_MEMBERS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.MESSAGES;
import static masterkey.store.db.Tables.NOTIFICATIONS;
import static masterkey.store.db.Tables.PUSH_TOKENS;
import static masterkey.store.db.Tables.USERS;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import masterkey.api.chats.Chats;
import masterkey.api.events.EventViews;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.presence.Presence;
import masterkey.store.Database;
import masterkey.store.db.tables.records.ChatMembersRecord;
import masterkey.store.db.tables.records.ChatsRecord;
import masterkey.store.db.tables.records.NotificationsRecord;
import masterkey.store.db.tables.records.PushTokensRecord;
import org.jooq.DSLContext;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

/**
 * Who is told by a push, and what (JAVA-BACKEND.md §18, Push): only who has no socket open
 * (the app shows the rest by itself), respecting {@code notifyMessages}, never about
 * someone blocked either way; one push per chat with the count, never the text; in event chats
 * only what the organizer and the admins write. Without an answer from the presence in time the
 * push goes (a push more is the smaller harm, §4). Tokens a service says are gone are removed.
 */
public final class Pushes {

    private static final Logger log = LoggerFactory.getLogger(Pushes.class);
    static final int MESSAGES_LOOKED_AT = 2_000;

    private final Database db;
    private final Presence presence;
    private final @Nullable PushSender apns;
    private final @Nullable PushSender fcm;

    public Pushes(Database db, Presence presence, @Nullable PushSender apns, @Nullable PushSender fcm) {
        this.db = db;
        this.presence = presence;
        this.apns = apns;
        this.fcm = fcm;
    }

    /** Thrown when some push could not go now: the job tries again later. */
    public static final class Later extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Later() {
            super("a push service could not take a push now", null, false, false);
        }
    }

    // --- notifications ---

    public void notification(UUID id) {
        record Found(NotificationsRecord entry, List<PushTokensRecord> tokens, @Nullable String event, @Nullable String actor) {
        }
        Found found = db.read(ctx -> {
            NotificationsRecord entry = ctx.selectFrom(NOTIFICATIONS).where(NOTIFICATIONS.ID.eq(id)).fetchOne();
            if (entry == null || entry.getRead()) return null;
            List<PushTokensRecord> tokens = ctx.selectFrom(PUSH_TOKENS).where(PUSH_TOKENS.USER_ID.eq(entry.getUserId())).fetch();
            if (tokens.isEmpty()) return null;
            String event = entry.getEventId() == null ? null
                    : ctx.select(EVENTS.TITLE).from(EVENTS).where(EVENTS.ID.eq(entry.getEventId())).fetchOne(EVENTS.TITLE);
            UUID first = entry.getActors().length == 0 ? null : entry.getActors()[0];
            String actor = first == null ? null : ctx.select(USERS.NAME).from(USERS).where(USERS.ID.eq(first)).fetchOne(USERS.NAME);
            return new Found(entry, tokens, event, actor);
        });
        if (found == null || online(List.of(found.entry().getUserId())).contains(found.entry().getUserId())) return;
        PushSender.Message message = text(found.entry(), found.event(), found.actor());
        if (message == null) return;
        if (!sendAll(found.tokens(), message)) throw new Later();
    }

    /** The words of a notification (the app's language: English), with its event and first person. */
    static PushSender.@Nullable Message text(NotificationsRecord entry, @Nullable String event, @Nullable String actor) {
        JsonNode data = entry.getData() == null ? Json.object() : Json.parse(entry.getData().data());
        String title = event != null ? event : data.path("title").stringValue("Masterkey");
        String who = actor != null ? actor : "Someone";
        int others = Math.max(0, entry.getCount() - 1);
        String body = switch (entry.getKind()) {
            case "connect.invite" -> who + " wants to connect";
            case "event.joined" -> others > 0 ? who + " and " + others + (others == 1 ? " other are" : " others are") + " going" : who + " is going";
            case "event.changed" -> "The event changed";
            case "event.cancelled" -> "The event was cancelled";
            case "event.starting" -> "Starts within the hour";
            case "event.rated" -> others > 0 ? (others + 1) + " new ratings" : who + " rated it";
            case "album.photos" -> "New photos in the album";
            case "event.removed" -> "You are no longer in this event";
            case "promotion.paused" -> "Promotion paused: not enough credits";
            default -> null;
        };
        if (body == null) return null;
        if ("connect.invite".equals(entry.getKind())) title = "Connect";
        Map<String, String> fields = new LinkedHashMap<>();
        fields.put("type", "notification");
        fields.put("notificationId", Ids.publicId("nt", entry.getId()));
        fields.put("kind", entry.getKind());
        if (entry.getEventId() != null) fields.put("eventId", EventViews.publicId(entry.getEventId()));
        return new PushSender.Message(title, body, fields, "nt-" + entry.getId());
    }

    // --- chats ---

    /** The new messages of a chat, to each member not online who has not been told of them. */
    public void chat(UUID chatId) {
        record Member(ChatMembersRecord row, List<PushTokensRecord> tokens) {
        }
        record Plan(ChatsRecord chat, String title, List<Member> members, List<NewMessage> messages, Map<UUID, Set<UUID>> blocked) {
        }
        Plan plan = db.read(ctx -> {
            ChatsRecord chat = ctx.selectFrom(CHATS).where(CHATS.ID.eq(chatId)).fetchOne();
            if (chat == null) return null;
            List<ChatMembersRecord> rows = ctx.selectFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chatId)).fetch();
            long since = Long.MAX_VALUE;
            List<UUID> people = new ArrayList<>();
            for (ChatMembersRecord row : rows) {
                since = Math.min(since, Math.max(row.getReadCounter(), row.getPushedCounter()));
                people.add(row.getUserId());
            }
            if (rows.isEmpty() || since >= chat.getCounter()) return null;
            Map<UUID, List<PushTokensRecord>> tokens = new HashMap<>();
            for (PushTokensRecord token : ctx.selectFrom(PUSH_TOKENS).where(PUSH_TOKENS.USER_ID.in(people)).fetch()) {
                tokens.computeIfAbsent(token.getUserId(), user -> new ArrayList<>()).add(token);
            }
            Map<UUID, Boolean> wantsMessages = new HashMap<>();
            ctx.select(USERS.ID, USERS.SETTINGS).from(USERS).where(USERS.ID.in(tokens.keySet())).fetch().forEach(row -> {
                JsonNode value = row.value2() == null ? null : Json.parse(row.value2().data()).get("notifyMessages");
                wantsMessages.put(row.value1(), value == null || !value.isBoolean() || value.booleanValue());
            });
            List<Member> members = new ArrayList<>();
            for (ChatMembersRecord row : rows) {
                List<PushTokensRecord> mine = tokens.get(row.getUserId());
                // A member muted by a moderator still reads: only notifyMessages keeps a push away
                if (mine == null || !wantsMessages.getOrDefault(row.getUserId(), true)) continue;
                members.add(new Member(row, mine));
            }
            if (members.isEmpty()) return null;
            Map<UUID, String> roles = new HashMap<>();
            for (ChatMembersRecord row : rows) roles.put(row.getUserId(), row.getRole());
            List<NewMessage> messages = new ArrayList<>();
            ctx.select(MESSAGES.SEQ, MESSAGES.COUNTER, MESSAGES.SENDER).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chatId))
                    .and(MESSAGES.COUNTER.gt(since)).and(MESSAGES.SYSTEM.isFalse()).and(MESSAGES.DELETED_AT.isNull()).and(MESSAGES.SENDER.isNotNull())
                    .orderBy(MESSAGES.COUNTER.desc()).limit(MESSAGES_LOOKED_AT).fetch().forEach(row -> {
                        // An event's chat: only who runs it, the rest would be noise to thousands
                        String role = roles.get(row.value3());
                        if (!"event".equals(chat.getKind()) || "owner".equals(role) || "admin".equals(role)) {
                            messages.add(new NewMessage(row.value1(), row.value2(), row.value3()));
                        }
                    });
            if (messages.isEmpty()) return null;
            Set<UUID> senders = new HashSet<>();
            for (NewMessage message : messages) senders.add(message.sender());
            Map<UUID, Set<UUID>> blocked = blocks(ctx, people, senders);
            return new Plan(chat, title(ctx, chat), members, messages, blocked);
        });
        if (plan == null) return;
        List<UUID> people = plan.members().stream().map(member -> member.row().getUserId()).toList();
        Set<UUID> online = new HashSet<>(online(people));
        Map<UUID, Long> told = new HashMap<>();
        boolean later = false;
        for (Member member : plan.members()) {
            UUID user = member.row().getUserId();
            if (online.contains(user)) continue;
            long base = Math.max(member.row().getReadCounter(), member.row().getPushedCounter());
            Set<UUID> hidden = plan.blocked().getOrDefault(user, Set.of());
            int count = 0;
            UUID from = null;
            for (NewMessage message : plan.messages()) {
                if (message.counter() <= base || message.sender().equals(user) || hidden.contains(message.sender())) continue;
                if ("group".equals(plan.chat().getKind()) && message.seq() < member.row().getJoinedSeq()) continue;
                count++;
                if (from == null) from = message.sender();
            }
            if (count == 0) continue;
            String title = "direct".equals(plan.chat().getKind()) && from != null ? nameOf(from) : plan.title();
            String body = count == 1 ? "New message" : (count >= MESSAGES_LOOKED_AT ? "Many" : Integer.toString(count)) + " new messages";
            if ("event".equals(plan.chat().getKind())) body += count == 1 ? " from the organizer" : " from the organizers";
            Map<String, String> data = Map.of("type", "chat", "chatId", Chats.publicId(plan.chat()));
            if (sendAll(member.tokens(), new PushSender.Message(title, body, data, "chat-" + chatId))) told.put(user, plan.chat().getCounter());
            else later = true;
        }
        if (!told.isEmpty()) {
            db.txRun(ctx -> told.forEach((user, counter) -> ctx.update(CHAT_MEMBERS)
                    .set(CHAT_MEMBERS.PUSHED_COUNTER, org.jooq.impl.DSL.greatest(CHAT_MEMBERS.PUSHED_COUNTER, org.jooq.impl.DSL.val(counter)))
                    .where(CHAT_MEMBERS.CHAT_ID.eq(chatId)).and(CHAT_MEMBERS.USER_ID.eq(user)).execute()));
        }
        if (later) throw new Later();
    }

    record NewMessage(long seq, long counter, UUID sender) {
    }

    private String nameOf(UUID user) {
        String name = db.read(ctx -> ctx.select(USERS.NAME).from(USERS).where(USERS.ID.eq(user)).fetchOne(USERS.NAME));
        return name == null ? "Masterkey" : name;
    }

    private static String title(DSLContext ctx, ChatsRecord chat) {
        if (chat.getEventId() != null) {
            String event = ctx.select(EVENTS.TITLE).from(EVENTS).where(EVENTS.ID.eq(chat.getEventId())).fetchOne(EVENTS.TITLE);
            if (event != null) return event;
        }
        return chat.getTitle() != null ? chat.getTitle() : "Masterkey";
    }

    /** Member → the senders they have a block with, either way. */
    private static Map<UUID, Set<UUID>> blocks(DSLContext ctx, List<UUID> members, Set<UUID> senders) {
        Map<UUID, Set<UUID>> blocked = new HashMap<>();
        ctx.select(BLOCKS.BLOCKER, BLOCKS.BLOCKED).from(BLOCKS)
                .where(BLOCKS.BLOCKER.in(members).and(BLOCKS.BLOCKED.in(senders)))
                .or(BLOCKS.BLOCKER.in(senders).and(BLOCKS.BLOCKED.in(members))).fetch().forEach(row -> {
                    blocked.computeIfAbsent(row.value1(), user -> new HashSet<>()).add(row.value2());
                    blocked.computeIfAbsent(row.value2(), user -> new HashSet<>()).add(row.value1());
                });
        return blocked;
    }

    // --- sending ---

    private List<UUID> online(List<UUID> users) {
        try {
            return presence.online(users).get(500, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return List.of();
        } catch (Exception noAnswer) {
            return List.of();
        }
    }

    /** To every phone of one person; false when some service asked to try later. Gone tokens are removed. */
    private boolean sendAll(List<PushTokensRecord> tokens, PushSender.Message message) {
        boolean all = true;
        List<String> gone = new ArrayList<>();
        for (PushTokensRecord token : tokens) {
            PushSender sender = "ios".equals(token.getPlatform()) ? apns : fcm;
            if (sender == null) continue;
            PushSender.Result result;
            try {
                result = sender.send(token.getToken(), message);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            } catch (RuntimeException error) {
                log.warn("push: a push failed: {}", error.getClass().getSimpleName());
                result = PushSender.Result.RETRY;
            }
            if (result == PushSender.Result.GONE) gone.add(token.getToken());
            if (result == PushSender.Result.RETRY) all = false;
        }
        if (!gone.isEmpty()) db.txRun(ctx -> ctx.deleteFrom(PUSH_TOKENS).where(PUSH_TOKENS.TOKEN.in(gone)).execute());
        return all;
    }
}
