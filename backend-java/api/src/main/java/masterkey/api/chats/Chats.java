// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.chats;

import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.CHAT_MEMBERS;
import static masterkey.store.db.Tables.CHAT_PINS;
import static masterkey.store.db.Tables.DIRECT_CHATS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.MESSAGES;
import static masterkey.store.db.Tables.POLL_VOTES;
import static masterkey.store.db.Tables.SENT_MESSAGES;
import static masterkey.store.db.Tables.USERS;

import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.api.Urls;
import masterkey.api.common.ChatPush;
import masterkey.api.common.Outbox;
import masterkey.api.common.People;
import masterkey.api.common.Relations;
import masterkey.api.events.EventTheme;
import masterkey.api.events.EventViews;
import masterkey.api.people.Views;
import masterkey.core.ApiError;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.store.db.tables.records.ChatMembersRecord;
import masterkey.store.db.tables.records.ChatsRecord;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.MessagesRecord;
import org.jooq.DSLContext;
import org.jooq.JSONB;
import org.jooq.Record3;
import org.jooq.impl.DSL;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * What a chat is for a user, and what changes it ({@code domain.py}, {@code views.py},
 * {@code moderation.py}). Every rule of who sees what is here: blocks either way, a group from
 * the moment someone joined ({@code joined_seq}, never a comparison of times), an event chat
 * while its event is on. Frames leave after the commit.
 */
public final class Chats implements ChatPush {

    public static final int MAX_MEMBERS_SHOWN = 200;
    public static final int INBOX_MAX = 500;
    public static final int GROUP_MEMBERS_MAX = 256;
    public static final int GROUPS_OWNED_MAX = 50;
    public static final int PIN_MAX = 3;
    /** owner 2, admin 1, member 0. */
    static int rank(@Nullable String role) {
        return "owner".equals(role) ? 2 : "admin".equals(role) ? 1 : 0;
    }
    /** The slow count of unread messages stops here: the app shows a number and that is all. */
    static final int SLOW_UNREAD_MAX = 100;

    private final People people;
    private final Relations relations;
    private final Outbox outbox;
    private final Urls urls;
    private final masterkey.api.common.Later later;
    private final InstantSource clock;

    public Chats(People people, Relations relations, Outbox outbox, Urls urls, masterkey.api.common.Later later, InstantSource clock) {
        this.later = later;
        this.people = people;
        this.relations = relations;
        this.outbox = outbox;
        this.urls = urls;
        this.clock = clock;
    }

    // --- ids ---

    /** {@code chat_…} for direct chats and groups, {@code event:ev_…} for event chats. */
    public static String publicId(ChatsRecord chat) {
        UUID event = chat.getEventId();
        return event != null ? "event:" + EventViews.publicId(event) : Ids.publicId("chat", chat.getId());
    }

    public static String messageId(UUID id) {
        return Ids.publicId("msg", id);
    }

    /** The chat named by a public id, or 404 like anything that does not exist. */
    public static ChatsRecord find(DSLContext ctx, String publicId, boolean lock) {
        ChatsRecord chat;
        if (publicId.startsWith("event:")) {
            UUID event = Ids.parse("ev", publicId.substring(6)).orElseThrow(() -> ApiError.notFound("chat not found"));
            var query = ctx.selectFrom(CHATS).where(CHATS.EVENT_ID.eq(event));
            chat = lock ? query.forUpdate().fetchOne() : query.fetchOne();
        } else {
            UUID id = Ids.parse("chat", publicId).orElseThrow(() -> ApiError.notFound("chat not found"));
            var query = ctx.selectFrom(CHATS).where(CHATS.ID.eq(id)).and(CHATS.KIND.ne("event"));
            chat = lock ? query.forUpdate().fetchOne() : query.fetchOne();
        }
        if (chat == null) throw ApiError.notFound("chat not found");
        return chat;
    }

    // --- who is in it, and with what role ---

    public static @Nullable ChatMembersRecord member(DSLContext ctx, UUID chat, UUID user) {
        return ctx.selectFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat)).and(CHAT_MEMBERS.USER_ID.eq(user)).fetchOne();
    }

    @Override
    public List<UUID> members(DSLContext ctx, UUID chat) {
        return ctx.select(CHAT_MEMBERS.USER_ID).from(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat)).fetch(CHAT_MEMBERS.USER_ID);
    }

    static @Nullable EventsRecord eventOf(DSLContext ctx, ChatsRecord chat) {
        UUID event = chat.getEventId();
        return event == null ? null : ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(event)).fetchOne();
    }

    /** An event chat is there while its event is on: not cancelled, not over. */
    static boolean open(@Nullable EventsRecord event, Instant now) {
        return event != null && event.getCancelledAt() == null && now.isBefore(event.getEndsAt());
    }

    /** A group, or the chat of an event not over: who runs it, and what each role may do. */
    static boolean moderated(ChatsRecord chat, @Nullable EventsRecord event, Instant now) {
        return "group".equals(chat.getKind()) || ("event".equals(chat.getKind()) && open(event, now));
    }

    static boolean muted(ChatMembersRecord member, Instant now) {
        Instant until = member.getMutedUntil();
        return member.getMutedForever() || (until != null && until.isAfter(now));
    }

    /** Why a member cannot write now: "muted", "readonly", or null. */
    static @Nullable String writeRule(ChatsRecord chat, ChatMembersRecord member, Instant now) {
        if (muted(member, now)) return "muted";
        if (chat.getReadOnly() && rank(member.getRole()) < rank("admin")) return "readonly";
        return null;
    }

    /** The member's role when it is at least {@code rank}: 404 outside the chat, 403 below. */
    static ChatMembersRecord requireRank(DSLContext ctx, ChatsRecord chat, UUID user, String rank, Instant now) {
        ChatMembersRecord member = member(ctx, chat.getId(), user);
        if (member == null || !moderated(chat, eventOf(ctx, chat), now)) throw ApiError.notFound("chat not found");
        if (rank(member.getRole()) < rank(rank)) {
            throw ApiError.forbidden("only the " + ("owner".equals(rank) ? "owner" : "owner or an admin") + " can do this");
        }
        return member;
    }

    /** {@link #requireRank} for the other areas (uploads of a group's picture). */
    public static ChatMembersRecord requireRankOf(DSLContext ctx, ChatsRecord chat, UUID user, String rank, Instant now) {
        return requireRank(ctx, chat, user, rank, now);
    }

    public static String nameOfUser(DSLContext ctx, UUID user) {
        return nameOf(ctx, user);
    }

    /** The actor may act on the target: both in the chat, the actor's role higher. */
    static ChatMembersRecord requireAbove(DSLContext ctx, ChatsRecord chat, UUID actor, UUID target, Instant now) {
        ChatMembersRecord acting = requireRank(ctx, chat, actor, "admin", now);
        if (target.equals(actor)) throw ApiError.forbidden("not on yourself");
        ChatMembersRecord other = member(ctx, chat.getId(), target);
        if (other == null) throw ApiError.notFound("member not found");
        if (rank(other.getRole()) >= rank(acting.getRole())) throw ApiError.forbidden("only on someone with a lower role");
        return other;
    }

    // --- what a user sees ---

    /** The chat as the user sees it, or null when they are not in it or it is hidden from them. */
    public @Nullable Map<String, Object> summary(DSLContext ctx, ChatsRecord chat, UUID user) {
        List<Map<String, Object>> found = summaries(ctx, List.of(chat), user, false);
        return found.isEmpty() ? null : found.getFirst();
    }

    public Map<String, Object> require(DSLContext ctx, ChatsRecord chat, UUID user) {
        Map<String, Object> summary = summary(ctx, chat, user);
        if (summary == null) throw ApiError.notFound("chat not found");
        return summary;
    }

    /**
     * The chats as the user sees them, in one pass for a whole inbox (§7.4): their rows, the
     * last messages, the unread, who they are with, roles and pins, each in one query.
     * {@code inbox}: also leave out a direct chat opened by the other and never written in.
     */
    public List<Map<String, Object>> summaries(DSLContext ctx, List<ChatsRecord> chats, UUID user, boolean inbox) {
        if (chats.isEmpty()) return List.of();
        Instant now = clock.instant();
        List<UUID> ids = chats.stream().map(ChatsRecord::getId).toList();
        Map<UUID, ChatMembersRecord> mine = new HashMap<>();
        for (ChatMembersRecord member : ctx.selectFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.USER_ID.eq(user)).and(CHAT_MEMBERS.CHAT_ID.in(ids)).fetch()) {
            mine.put(member.getChatId(), member);
        }
        Map<UUID, EventsRecord> events = new HashMap<>();
        Set<UUID> eventIds = new HashSet<>();
        for (ChatsRecord chat : chats) if (chat.getEventId() != null) eventIds.add(chat.getEventId());
        if (!eventIds.isEmpty()) for (EventsRecord event : ctx.selectFrom(EVENTS).where(EVENTS.ID.in(eventIds)).fetch()) events.put(event.getId(), event);
        // Who the direct chats are with
        Map<UUID, UUID> others = new HashMap<>();
        for (var row : ctx.select(CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID).from(CHAT_MEMBERS)
                .where(CHAT_MEMBERS.CHAT_ID.in(chats.stream().filter(c -> "direct".equals(c.getKind())).map(ChatsRecord::getId).toList()))
                .and(CHAT_MEMBERS.USER_ID.ne(user)).fetch()) {
            others.put(row.value1(), row.value2());
        }
        Set<UUID> blocked = Relations.blockedWith(ctx, user);
        Set<UUID> connections = Relations.connectionsOf(ctx, user);
        List<ChatsRecord> shown = new ArrayList<>();
        for (ChatsRecord chat : chats) {
            ChatMembersRecord member = mine.get(chat.getId());
            if (member == null) continue;
            if ("event".equals(chat.getKind()) && !open(events.get(chat.getEventId()), now)) continue;
            if ("direct".equals(chat.getKind())) {
                UUID other = others.get(chat.getId());
                if (other == null || blocked.contains(other)) continue;
                if (inbox && chat.getSeq() == 0 && chat.getOpenedBy() != null && !user.equals(chat.getOpenedBy())) continue;
            }
            shown.add(chat);
        }
        // Who among the strangers the direct chats are with is nearby: one question to the presence
        List<UUID> strangers = new ArrayList<>();
        for (ChatsRecord chat : shown) {
            UUID other = others.get(chat.getId());
            if (other != null && !connections.contains(other)) strangers.add(other);
        }
        Set<UUID> disconnected = new HashSet<>();
        if (!strangers.isEmpty()) {
            for (var row : ctx.select(masterkey.store.db.Tables.DISCONNECTED_PAIRS.A, masterkey.store.db.Tables.DISCONNECTED_PAIRS.B)
                    .from(masterkey.store.db.Tables.DISCONNECTED_PAIRS)
                    .where(masterkey.store.db.Tables.DISCONNECTED_PAIRS.A.eq(user).and(masterkey.store.db.Tables.DISCONNECTED_PAIRS.B.in(strangers))
                            .or(masterkey.store.db.Tables.DISCONNECTED_PAIRS.B.eq(user).and(masterkey.store.db.Tables.DISCONNECTED_PAIRS.A.in(strangers))))
                    .fetch()) {
                disconnected.add(row.value1().equals(user) ? row.value2() : row.value1());
            }
        }
        List<UUID> askNear = new ArrayList<>(strangers);
        askNear.removeAll(disconnected);
        Map<UUID, Boolean> near = relations.near(user, askNear);
        // The last message each user may see, and the unread
        Map<UUID, MessagesRecord> last = lastMessages(ctx, shown, mine, blocked);
        Map<UUID, Integer> unread = unread(ctx, shown, mine, user, blocked);
        Set<UUID> pinChats = new HashSet<>();
        for (ChatsRecord chat : shown) pinChats.add(chat.getId());
        Map<UUID, List<MessagesRecord>> pins = pins(ctx, pinChats);
        Set<UUID> named = new HashSet<>(others.values());
        for (MessagesRecord message : last.values()) if (message.getSender() != null) named.add(message.getSender());
        Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, named);
        Map<UUID, Map<UUID, List<String>>> votes = votesOf(ctx, user, collect(last.values(), pins.values()));
        List<Map<String, Object>> out = new ArrayList<>();
        for (ChatsRecord chat : shown) {
            ChatMembersRecord member = mine.get(chat.getId());
            if (member == null) continue;
            EventsRecord event = chat.getEventId() == null ? null : events.get(chat.getEventId());
            MessagesRecord lastMessage = last.get(chat.getId());
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("id", publicId(chat));
            view.put("lastMessage", lastMessage == null ? null : message(lastMessage, chat, votes.get(lastMessage.getId()), true));
            view.put("lastAuthor", lastMessage == null || lastMessage.getSender() == null ? null : summaries.get(lastMessage.getSender()));
            view.put("unread", unread.getOrDefault(chat.getId(), 0));
            Instant readAt = member.getReadAt();
            view.put("readAt", readAt == null ? Instant.EPOCH : readAt);
            view.put("kind", chat.getKind());
            boolean canWrite = true;
            String why = null;
            if ("event".equals(chat.getKind()) && event != null) {
                view.put("title", event.getTitle());
                JsonNode theme = EventTheme.read(event.getTheme());
                JsonNode color = theme == null ? null : theme.get("color");
                view.put("color", color == null || color.isNull() ? null : color.stringValue());
                view.put("pictureUrl", null);
                view.put("with", null);
                Map<String, Object> about = new LinkedHashMap<>();
                about.put("id", EventViews.publicId(event.getId()));
                about.put("title", event.getTitle());
                about.put("categories", List.of(event.getCategories()));
                about.put("theme", theme);
                view.put("event", about);
                view.put("memberCount", chat.getMemberCount());
                view.put("ownerId", Ids.publicId("usr", event.getCreatorId()));
                view.put("closesAt", null);
            } else {
                UUID other = others.get(chat.getId());
                Views.UserSummary with = other == null ? null : summaries.get(other);
                view.put("title", with != null ? with.name() : chat.getTitle());
                view.put("color", chat.getColor());
                view.put("pictureUrl", urls.media(chat.getPictureKey()));
                view.put("with", with);
                view.put("event", null);
                view.put("memberCount", chat.getMemberCount());
                view.put("ownerId", chat.getOwnerId() == null ? null : Ids.publicId("usr", chat.getOwnerId()));
                view.put("closesAt", null);
                if ("direct".equals(chat.getKind()) && other != null) {
                    if (connections.contains(other)) {
                        why = null;
                    } else if (disconnected.contains(other)) {
                        canWrite = false;
                        why = "disconnected";
                    } else if (near.getOrDefault(other, false)) {
                        why = "nearby";
                    } else {
                        canWrite = false;
                        why = "away";
                    }
                }
            }
            if ("event".equals(chat.getKind()) && event != null) {
                view.put("closesAt", event.getEndsAt());
            }
            view.put("canWrite", canWrite);
            view.put("why", why);
            if (!moderated(chat, event, now)) {
                view.put("role", null);
                view.put("readOnly", false);
                view.put("muted", false);
                view.put("mutedUntil", null);
                view.put("pinned", List.of());
            } else {
                boolean isMuted = muted(member, now);
                view.put("role", member.getRole());
                view.put("readOnly", chat.getReadOnly());
                view.put("muted", isMuted);
                view.put("mutedUntil", isMuted && !member.getMutedForever() ? member.getMutedUntil() : null);
                List<Map<String, Object>> pinned = new ArrayList<>();
                for (MessagesRecord pin : pins.getOrDefault(chat.getId(), List.of())) {
                    if (sees(pin, chat, member, blocked)) pinned.add(message(pin, chat, votes.get(pin.getId()), true));
                }
                view.put("pinned", pinned);
                String rule = writeRule(chat, member, now);
                if (rule != null && canWrite) {
                    view.put("canWrite", false);
                    view.put("why", rule);
                }
            }
            out.add(view);
        }
        return out;
    }

    /** The chat's page: its summary and its people (owner, admins and the user first; 200 at most). */
    public Map<String, Object> detail(DSLContext ctx, ChatsRecord chat, UUID user) {
        Map<String, Object> view = require(ctx, chat, user);
        Instant now = clock.instant();
        EventsRecord event = eventOf(ctx, chat);
        Set<UUID> blocked = Relations.blockedWith(ctx, user);
        List<ChatMembersRecord> members = ctx.selectFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).fetch();
        members.removeIf(member -> blocked.contains(member.getUserId()));
        boolean moderated = moderated(chat, event, now);
        ChatMembersRecord me = member(ctx, chat.getId(), user);
        boolean seesMutes = moderated && me != null && rank(me.getRole()) >= rank("admin");
        if ("event".equals(chat.getKind()) && moderated && !seesMutes) {
            // An event's people, as on its page: the others see only who lets them know they go
            Set<UUID> plain = new HashSet<>();
            for (ChatMembersRecord member : members) if ("member".equals(member.getRole())) plain.add(member.getUserId());
            Set<UUID> knowable = Relations.seesStoryOf(ctx, user, plain);
            members.removeIf(member -> "member".equals(member.getRole()) && !knowable.contains(member.getUserId()));
        }
        Map<UUID, Views.UserSummary> summaries = people.summaries(ctx, members.stream().map(ChatMembersRecord::getUserId).toList());
        members.sort((a, b) -> {
            int byRank = moderated ? Integer.compare(rank(b.getRole()), rank(a.getRole())) : 0;
            if (byRank != 0) return byRank;
            int mineFirst = Boolean.compare(!a.getUserId().equals(user), !b.getUserId().equals(user));
            if (mineFirst != 0) return mineFirst;
            return name(summaries.get(a.getUserId())).compareTo(name(summaries.get(b.getUserId())));
        });
        List<Map<String, Object>> entries = new ArrayList<>();
        for (ChatMembersRecord member : members) {
            if (entries.size() >= MAX_MEMBERS_SHOWN) break;
            Views.UserSummary summary = summaries.get(member.getUserId());
            if (summary == null) continue;
            boolean isMuted = seesMutes && muted(member, now);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("user", summary);
            entry.put("role", moderated ? member.getRole() : "member");
            entry.put("muted", isMuted);
            entry.put("mutedUntil", isMuted && !member.getMutedForever() ? member.getMutedUntil() : null);
            entries.add(entry);
        }
        view.put("members", entries);
        return view;
    }

    private static String name(Views.@Nullable UserSummary summary) {
        return summary == null ? "" : summary.name().toLowerCase(Locale.ROOT);
    }

    // --- messages ---

    /**
     * Whether the member sees the message: nothing from someone blocked either way; a group
     * from the message they joined on ({@code views.sees_message}).
     */
    static boolean sees(MessagesRecord message, ChatsRecord chat, ChatMembersRecord member, Set<UUID> blocked) {
        if (message.getSender() != null && blocked.contains(message.getSender())) return false;
        return !"group".equals(chat.getKind()) || message.getSeq() >= member.getJoinedSeq();
    }

    /** A Message of API.md; {@code mine}: the reader's choices in a poll (never in what goes to the whole chat). */
    Map<String, Object> message(MessagesRecord message, ChatsRecord chat, @Nullable Map<UUID, List<String>> votes, boolean withMine) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("id", messageId(message.getId()));
        view.put("chatId", publicId(chat));
        view.put("from", message.getSender() == null ? null : Ids.publicId("usr", message.getSender()));
        view.put("text", message.getText());
        view.put("at", message.getAt());
        view.put("clientId", message.getClientId());
        view.put("system", message.getSystem());
        view.put("deleted", message.getDeletedAt() != null);
        view.put("poll", message.getPoll() == null || message.getDeletedAt() != null ? null : Polls.view(message, votes, withMine));
        return view;
    }

    private Map<UUID, MessagesRecord> lastMessages(DSLContext ctx, List<ChatsRecord> chats, Map<UUID, ChatMembersRecord> mine, Set<UUID> blocked) {
        Map<UUID, MessagesRecord> found = new HashMap<>();
        List<org.jooq.Condition> wanted = new ArrayList<>();
        for (ChatsRecord chat : chats) {
            if (chat.getSeq() > 0) wanted.add(MESSAGES.CHAT_ID.eq(chat.getId()).and(MESSAGES.SEQ.eq(chat.getSeq())));
        }
        if (!wanted.isEmpty()) {
            for (MessagesRecord message : ctx.selectFrom(MESSAGES).where(DSL.or(wanted)).fetch()) found.put(message.getChatId(), message);
        }
        // What the user does not see is not the chat's last message: the slow path, rare
        for (ChatsRecord chat : chats) {
            MessagesRecord message = found.get(chat.getId());
            ChatMembersRecord member = mine.get(chat.getId());
            if (message == null || member == null || sees(message, chat, member, blocked)) continue;
            var query = ctx.selectFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.getId()));
            if ("group".equals(chat.getKind())) query = query.and(MESSAGES.SEQ.ge(member.getJoinedSeq()));
            if (!blocked.isEmpty()) query = query.and(MESSAGES.SENDER.isNull().or(MESSAGES.SENDER.notIn(blocked)));
            MessagesRecord visible = query.orderBy(MESSAGES.SEQ.desc()).limit(1).fetchOne();
            if (visible == null) found.remove(chat.getId());
            else found.put(chat.getId(), visible);
        }
        return found;
    }

    /**
     * Unread: the chat's counter minus the member's (§18, Non letti), one write a message whatever
     * the size of the chat. Who has a block with someone who wrote there counts slowly, up to 100.
     */
    private Map<UUID, Integer> unread(DSLContext ctx, List<ChatsRecord> chats, Map<UUID, ChatMembersRecord> mine, UUID user, Set<UUID> blocked) {
        Map<UUID, Integer> unread = new HashMap<>();
        for (ChatsRecord chat : chats) {
            ChatMembersRecord member = mine.get(chat.getId());
            if (member == null) continue;
            long fast = chat.getCounter() - member.getReadCounter();
            if (fast <= 0) {
                unread.put(chat.getId(), 0);
                continue;
            }
            if (blocked.isEmpty()) {
                unread.put(chat.getId(), (int) Math.min(fast, Integer.MAX_VALUE));
                continue;
            }
            int slow = ctx.fetchCount(ctx.select(MESSAGES.SEQ).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.getId()))
                    .and(MESSAGES.COUNTER.gt(member.getReadCounter())).and(MESSAGES.SYSTEM.isFalse()).and(MESSAGES.SENDER.ne(user))
                    .and(MESSAGES.SENDER.notIn(blocked)).and(MESSAGES.SEQ.ge(member.getJoinedSeq())).limit(SLOW_UNREAD_MAX));
            unread.put(chat.getId(), slow);
        }
        return unread;
    }

    /** The pinned messages of the chats, newest pin first, three at most each. */
    private static Map<UUID, List<MessagesRecord>> pins(DSLContext ctx, Set<UUID> chats) {
        Map<UUID, List<MessagesRecord>> found = new HashMap<>();
        if (chats.isEmpty()) return found;
        var rows = ctx.select(CHAT_PINS.CHAT_ID, CHAT_PINS.MESSAGE_ID).from(CHAT_PINS).where(CHAT_PINS.CHAT_ID.in(chats))
                .orderBy(CHAT_PINS.PINNED_AT.desc()).fetch();
        if (rows.isEmpty()) return found;
        Map<UUID, MessagesRecord> messages = new HashMap<>();
        List<org.jooq.Condition> wanted = new ArrayList<>();
        for (var row : rows) wanted.add(MESSAGES.CHAT_ID.eq(row.value1()).and(MESSAGES.ID.eq(row.value2())));
        for (MessagesRecord message : ctx.selectFrom(MESSAGES).where(DSL.or(wanted)).fetch()) messages.put(message.getId(), message);
        for (var row : rows) {
            MessagesRecord message = messages.get(row.value2());
            if (message != null) found.computeIfAbsent(row.value1(), key -> new ArrayList<>()).add(message);
        }
        return found;
    }

    static List<MessagesRecord> collect(Collection<MessagesRecord> last, Collection<List<MessagesRecord>> pins) {
        List<MessagesRecord> all = new ArrayList<>(last);
        for (List<MessagesRecord> list : pins) all.addAll(list);
        return all;
    }

    /** The votes of the polls among these messages: everyone's (to count) and so the reader's. */
    static Map<UUID, Map<UUID, List<String>>> votesOf(DSLContext ctx, UUID reader, Collection<MessagesRecord> messages) {
        Map<UUID, Map<UUID, List<String>>> found = new HashMap<>();
        List<UUID> polls = new ArrayList<>();
        for (MessagesRecord message : messages) if (message.getPoll() != null) polls.add(message.getId());
        if (polls.isEmpty()) return found;
        for (Record3<UUID, UUID, String[]> row : ctx.select(POLL_VOTES.MESSAGE_ID, POLL_VOTES.USER_ID, POLL_VOTES.OPTION_IDS).from(POLL_VOTES)
                .where(POLL_VOTES.MESSAGE_ID.in(polls)).fetch()) {
            found.computeIfAbsent(row.value1(), key -> new HashMap<>()).put(row.value2(), List.of(row.value3()));
        }
        for (UUID poll : polls) found.computeIfAbsent(poll, key -> new HashMap<>());
        found.forEach((poll, votes) -> votes.putIfAbsent(Polls.READER, votes.getOrDefault(reader, List.of())));
        return found;
    }

    /** A direct chat is told soon; a group or an event once in a while, with the count (§18, Push). */
    static final java.time.Duration DIRECT_PUSH = java.time.Duration.ofSeconds(5);
    static final java.time.Duration GROUP_PUSH = java.time.Duration.ofSeconds(30);

    /** A push of this chat for who is not online, written with the message: in an event's chat only for who runs it. */
    private void pushLater(DSLContext ctx, ChatsRecord chat, UUID sender) {
        if ("event".equals(chat.getKind())) {
            String role = ctx.select(CHAT_MEMBERS.ROLE).from(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId()))
                    .and(CHAT_MEMBERS.USER_ID.eq(sender)).fetchOne(CHAT_MEMBERS.ROLE);
            if (!"owner".equals(role) && !"admin".equals(role)) return;
        }
        later.pushChat(chat.getId(), "direct".equals(chat.getKind()) ? DIRECT_PUSH : GROUP_PUSH);
    }

    /**
     * A message in the chat: the row of the chat gives its number and keeps the order (§18); the
     * system ones do not count as unread. Sent twice with the same clientId: the first one.
     * The frame goes after the commit, to every member but who has a block with the sender.
     */
    public MessagesRecord post(DSLContext ctx, ChatsRecord chat, @Nullable UUID sender, String text, @Nullable String clientId, boolean system,
                               @Nullable JSONB poll) {
        Instant now = clock.instant();
        var numbered = ctx.update(CHATS)
                .set(CHATS.SEQ, CHATS.SEQ.plus(1))
                .set(CHATS.COUNTER, system ? CHATS.COUNTER : CHATS.COUNTER.plus(1))
                // Always later than the last one of the chat: what was read is told by this time
                .set(CHATS.LAST_AT, DSL.field("GREATEST(?::timestamptz, COALESCE(last_at + interval '1 millisecond', ?::timestamptz))",
                        org.jooq.impl.SQLDataType.INSTANT, now, now))
                .where(CHATS.ID.eq(chat.getId()))
                .returning(CHATS.SEQ, CHATS.COUNTER, CHATS.LAST_AT).fetchOne();
        if (numbered == null) throw ApiError.notFound("chat not found");
        MessagesRecord message = ctx.newRecord(MESSAGES);
        message.setChatId(chat.getId());
        message.setSeq(numbered.getSeq());
        message.setId(Ids.next());
        message.setCounter(numbered.getCounter());
        message.setAt(numbered.getLastAt());
        message.setSender(sender);
        message.setText(text);
        message.setClientId(clientId);
        message.setSystem(system);
        message.setPoll(poll);
        message.insert();
        if (clientId != null && sender != null) {
            int kept = ctx.insertInto(SENT_MESSAGES).set(SENT_MESSAGES.CHAT_ID, chat.getId()).set(SENT_MESSAGES.SENDER, sender)
                    .set(SENT_MESSAGES.CLIENT_ID, clientId).set(SENT_MESSAGES.MESSAGE_ID, message.getId()).set(SENT_MESSAGES.AT, now)
                    .onConflictDoNothing().execute();
            // Two sends at once: the second one rolls back, and the caller answers the first
            if (kept == 0) throw new Duplicate();
        }
        if (!system && sender != null) pushLater(ctx, chat, sender);
        if (sender != null) {
            ctx.update(CHAT_MEMBERS).set(CHAT_MEMBERS.READ_COUNTER, DSL.greatest(CHAT_MEMBERS.READ_COUNTER, DSL.val(numbered.getCounter())))
                    .set(CHAT_MEMBERS.READ_AT, numbered.getLastAt())
                    .where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).and(CHAT_MEMBERS.USER_ID.eq(sender)).execute();
        }
        chat.setSeq(numbered.getSeq());
        chat.setCounter(numbered.getCounter());
        chat.setLastAt(numbered.getLastAt());
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("type", "message");
        frame.put("message", message(message, chat, poll == null ? null : Map.of(), false));
        frame.put("author", sender == null ? null : people.summary(ctx, sender));
        Set<UUID> to = new HashSet<>(members(ctx, chat.getId()));
        if (sender != null) to.removeAll(Relations.blockedWith(ctx, sender));
        outbox.send(to, frame);
        return message;
    }

    /** Two sends of one clientId at once: the transaction rolls back and the caller answers the saved one. */
    static final class Duplicate extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Duplicate() {
            super("duplicate", null, false, false);
        }
    }

    /** {@code message.updated} to everyone in the chat who sees it (poll counts, a message removed). */
    void updated(DSLContext ctx, ChatsRecord chat, MessagesRecord message) {
        Map<String, Object> frame = new LinkedHashMap<>();
        frame.put("type", "message.updated");
        frame.put("message", message(message, chat, votesOf(ctx, new UUID(0, 0), List.of(message)).get(message.getId()), false));
        List<ChatMembersRecord> members = ctx.selectFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).fetch();
        Set<UUID> blocked = message.getSender() == null ? Set.of() : Relations.blockedWith(ctx, message.getSender());
        List<UUID> to = new ArrayList<>();
        for (ChatMembersRecord member : members) {
            if (!blocked.contains(member.getUserId()) && ("group".equals(chat.getKind()) ? message.getSeq() >= member.getJoinedSeq() : true)) {
                to.add(member.getUserId());
            }
        }
        outbox.send(to, frame);
    }

    // --- frames for everyone ---

    /** Each of these people gets the chat as they see it ({@code chat}); who no longer sees it, nothing. */
    @Override
    public void push(DSLContext ctx, UUID chatId, Collection<UUID> users) {
        ChatsRecord chat = ctx.selectFrom(CHATS).where(CHATS.ID.eq(chatId)).fetchOne();
        if (chat == null) return;
        for (UUID user : new LinkedHashSet<UUID>(users)) {
            Map<String, Object> summary = summary(ctx, chat, user);
            if (summary != null) outbox.send(user, Map.of("type", "chat", "chat", summary));
        }
    }

    public void removed(UUID user, ChatsRecord chat) {
        outbox.send(user, Map.of("type", "chat.removed", "chatId", publicId(chat)));
    }

    // --- leaving, passing on, ending ---

    /** The display name of someone, for the system messages of a group. */
    static String nameOf(DSLContext ctx, UUID user) {
        String name = ctx.select(USERS.NAME).from(USERS).where(USERS.ID.eq(user)).fetchOne(USERS.NAME);
        return name == null ? "Someone" : name;
    }

    /**
     * Out of a group ({@code domain.leave_chat} for groups): they leave, or a higher role removes
     * them; said in the chat, since in a group its people know each other.
     */
    public void leaveGroup(DSLContext ctx, ChatsRecord chat, UUID user, @Nullable UUID removedBy) {
        int gone = ctx.deleteFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).and(CHAT_MEMBERS.USER_ID.eq(user)).execute();
        if (gone == 0) return;
        ctx.update(CHATS).set(CHATS.MEMBER_COUNT, DSL.greatest(CHATS.MEMBER_COUNT.minus(1), DSL.inline(0))).where(CHATS.ID.eq(chat.getId())).execute();
        removed(user, chat);
        String name = nameOf(ctx, user);
        if (removedBy != null) post(ctx, chat, removedBy, nameOf(ctx, removedBy) + " removed " + name, null, true, null);
        else post(ctx, chat, user, name + " left", null, true, null);
        push(ctx, chat.getId(), members(ctx, chat.getId()));
    }

    /** Who takes a group over: the admin in it longest, else whoever is ({@code domain.next_owner}). */
    public static @Nullable UUID nextOwner(DSLContext ctx, ChatsRecord chat, UUID leaving) {
        return ctx.select(CHAT_MEMBERS.USER_ID).from(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).and(CHAT_MEMBERS.USER_ID.ne(leaving))
                .orderBy(DSL.when(CHAT_MEMBERS.ROLE.eq("admin"), 0).otherwise(1), CHAT_MEMBERS.JOINED_AT, CHAT_MEMBERS.USER_ID)
                .limit(1).fetchOne(CHAT_MEMBERS.USER_ID);
    }

    /**
     * The group passes to {@code owner}, told in it; whoever has a block with them leaves: a block
     * must not make someone invisible to who runs where they write ({@code domain.hand_over}).
     */
    public void handOver(DSLContext ctx, ChatsRecord chat, UUID owner) {
        ctx.update(CHATS).set(CHATS.OWNER_ID, owner).where(CHATS.ID.eq(chat.getId())).execute();
        ctx.update(CHAT_MEMBERS).set(CHAT_MEMBERS.ROLE, "owner").setNull(CHAT_MEMBERS.MUTED_UNTIL).set(CHAT_MEMBERS.MUTED_FOREVER, false)
                .where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).and(CHAT_MEMBERS.USER_ID.eq(owner)).execute();
        chat.setOwnerId(owner);
        Set<UUID> blocked = Relations.blockedWith(ctx, owner);
        for (UUID member : members(ctx, chat.getId())) {
            if (!blocked.contains(member)) continue;
            ctx.deleteFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).and(CHAT_MEMBERS.USER_ID.eq(member)).execute();
            ctx.update(CHATS).set(CHATS.MEMBER_COUNT, DSL.greatest(CHATS.MEMBER_COUNT.minus(1), DSL.inline(0))).where(CHATS.ID.eq(chat.getId())).execute();
            removed(member, chat);
        }
        post(ctx, chat, owner, nameOf(ctx, owner) + " now runs the group", null, true, null);
        push(ctx, chat.getId(), members(ctx, chat.getId()));
    }

    /** A group gone for everyone, with its picture and messages ({@code domain.end_group}). */
    public void endGroup(DSLContext ctx, ChatsRecord chat) {
        for (UUID member : members(ctx, chat.getId())) removed(member, chat);
        ctx.deleteFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.getId())).execute();
        ctx.deleteFrom(SENT_MESSAGES).where(SENT_MESSAGES.CHAT_ID.eq(chat.getId())).execute();
        ctx.deleteFrom(DIRECT_CHATS).where(DIRECT_CHATS.CHAT_ID.eq(chat.getId())).execute();
        ctx.deleteFrom(CHATS).where(CHATS.ID.eq(chat.getId())).execute();
    }

    /** The owner leaves or goes: the group passes on, or ends with nobody left. */
    public void ownerLeaves(DSLContext ctx, ChatsRecord chat, UUID owner) {
        UUID next = nextOwner(ctx, chat, owner);
        if (next == null) {
            endGroup(ctx, chat);
            return;
        }
        // In the chat as it happened: they leave, then the other takes over
        leaveGroup(ctx, chat, owner, null);
        handOver(ctx, chat, next);
    }

    /** Each of the two leaves the groups the other owns (a block, a disconnection). */
    public void leaveOwnGroups(DSLContext ctx, UUID owner, UUID other) {
        for (ChatsRecord chat : ctx.selectFrom(CHATS).where(CHATS.KIND.eq("group")).and(CHATS.OWNER_ID.eq(owner))
                .and(CHATS.ID.in(ctx.select(CHAT_MEMBERS.CHAT_ID).from(CHAT_MEMBERS).where(CHAT_MEMBERS.USER_ID.eq(other)))).fetch()) {
            ctx.deleteFrom(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).and(CHAT_MEMBERS.USER_ID.eq(other)).execute();
            ctx.update(CHATS).set(CHATS.MEMBER_COUNT, DSL.greatest(CHATS.MEMBER_COUNT.minus(1), DSL.inline(0))).where(CHATS.ID.eq(chat.getId())).execute();
            removed(other, chat);
            push(ctx, chat.getId(), members(ctx, chat.getId()));
        }
    }

    /** The direct chat between two people, if they have one. */
    public static @Nullable ChatsRecord direct(DSLContext ctx, UUID a, UUID b) {
        UUID low = Ids.low(a, b), high = Ids.high(a, b);
        UUID chat = ctx.select(DIRECT_CHATS.CHAT_ID).from(DIRECT_CHATS).where(DIRECT_CHATS.A.eq(low)).and(DIRECT_CHATS.B.eq(high))
                .fetchOne(DIRECT_CHATS.CHAT_ID);
        return chat == null ? null : ctx.selectFrom(CHATS).where(CHATS.ID.eq(chat)).fetchOne();
    }

    static JsonNode json(@Nullable JSONB value) {
        return value == null ? Json.object() : Json.parse(value.data());
    }
}
