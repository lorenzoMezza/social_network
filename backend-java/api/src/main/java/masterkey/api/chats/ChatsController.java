// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.chats;

import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.CHAT_MEMBERS;
import static masterkey.store.db.Tables.CHAT_PINS;
import static masterkey.store.db.Tables.DIRECT_CHATS;
import static masterkey.store.db.Tables.MESSAGES;
import static masterkey.store.db.Tables.POLL_VOTES;
import static masterkey.store.db.Tables.SENT_MESSAGES;

import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.api.Limits;
import masterkey.api.common.Outbox;
import masterkey.api.common.People;
import masterkey.api.common.Relations;
import masterkey.api.events.EventsController;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.core.Text;
import masterkey.store.Database;
import masterkey.store.db.tables.records.ChatMembersRecord;
import masterkey.store.db.tables.records.ChatsRecord;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.store.db.tables.records.MessagesRecord;
import org.jooq.DSLContext;
import org.jooq.JSONB;
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
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** Chats (API.md, Chats, Moderation; {@code routes/chats.py}). */
@RestController
@RequestMapping("/v1")
public class ChatsController {

    static final Set<String> TONES = Set.of("#F2546B", "#2F7BFF", "#1F9D63", "#A855F7", "#E08A00", "#0EA5A4", "#F06A3D", "#6E7FF5");
    static final int MESSAGE_MAX = 1000;
    static final Set<Integer> MUTE_MINUTES = Set.of(60, 480, 10080);

    private final Database db;
    private final Chats chats;
    private final Relations relations;
    private final EventsController events;
    private final Outbox outbox;
    private final Limits limits;
    private final InstantSource clock;
    private final masterkey.api.media.Uploads uploads;

    public ChatsController(Database db, Chats chats, Relations relations, EventsController events, Outbox outbox, Limits limits,
                           InstantSource clock, masterkey.api.media.Uploads uploads) {
        this.uploads = uploads;
        this.db = db;
        this.chats = chats;
        this.relations = relations;
        this.events = events;
        this.outbox = outbox;
        this.limits = limits;
        this.clock = clock;
    }

    // --- the inbox, opening chats ---

    @GetMapping("/chats")
    public Map<String, Object> inbox(Viewer viewer) {
        return db.read(ctx -> {
            List<ChatsRecord> mine = ctx.selectFrom(CHATS)
                    .where(CHATS.ID.in(ctx.select(CHAT_MEMBERS.CHAT_ID).from(CHAT_MEMBERS).where(CHAT_MEMBERS.USER_ID.eq(viewer.id()))))
                    .orderBy(DSL.coalesce(CHATS.LAST_AT, CHATS.CREATED_AT).desc()).limit(Chats.INBOX_MAX + 100).fetch();
            List<Map<String, Object>> items = chats.summaries(ctx, mine, viewer.id(), true);
            // Newest message first; chats without one after
            items.sort((a, b) -> {
                Instant x = lastAt(a), y = lastAt(b);
                if (x == null && y == null) return 0;
                if (x == null) return 1;
                if (y == null) return -1;
                return y.compareTo(x);
            });
            return Map.of("items", items.subList(0, Math.min(Chats.INBOX_MAX, items.size())));
        });
    }

    @SuppressWarnings("unchecked")
    private static @Nullable Instant lastAt(Map<String, Object> summary) {
        Object last = summary.get("lastMessage");
        return last instanceof Map<?, ?> message ? (Instant) ((Map<String, Object>) message).get("at") : null;
    }

    @PostMapping("/chats/direct")
    public ResponseEntity<Map<String, Object>> direct(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        String target = body.string("userId");
        UUID other = target == null ? null : Ids.parse("usr", target).orElse(null);
        if (other == null || other.equals(viewer.id())) throw ApiError.notFound("user not found");
        UUID them = other;
        Map<String, Object> existing = db.read(ctx -> {
            People.requireExists(ctx, them);
            ChatsRecord chat = Chats.direct(ctx, viewer.id(), them);
            if (chat == null) return null;
            Map<String, Object> summary = chats.summary(ctx, chat, viewer.id());
            if (summary == null) throw ApiError.forbidden("you cannot write to this person");
            return summary;
        });
        if (existing != null) return ResponseEntity.ok(existing);
        // The network first: whether they are around now
        if (!db.read(ctx -> relations.canMessage(ctx, viewer.id(), them)).allowed()) {
            throw ApiError.forbidden("only with a connection, or someone nearby right now");
        }
        limits.check(viewer.id(), Limits.Action.DIRECT_CHAT);
        Instant now = clock.instant();
        Map<String, Object> made = db.tx(ctx -> {
            Database.lockPeople(ctx, viewer.id(), them);
            ChatsRecord chat = Chats.direct(ctx, viewer.id(), them);
            if (chat == null) {
                UUID id = Ids.next();
                ctx.insertInto(CHATS).set(CHATS.ID, id).set(CHATS.KIND, "direct").set(CHATS.OPENED_BY, viewer.id())
                        .set(CHATS.MEMBER_COUNT, 2).set(CHATS.CREATED_AT, now).execute();
                for (UUID member : List.of(viewer.id(), them)) {
                    ctx.insertInto(CHAT_MEMBERS).set(CHAT_MEMBERS.CHAT_ID, id).set(CHAT_MEMBERS.USER_ID, member).set(CHAT_MEMBERS.JOINED_AT, now).execute();
                }
                UUID low = Ids.low(viewer.id(), them), high = Ids.high(viewer.id(), them);
                ctx.insertInto(DIRECT_CHATS).set(DIRECT_CHATS.A, low).set(DIRECT_CHATS.B, high).set(DIRECT_CHATS.CHAT_ID, id).execute();
                chat = ctx.selectFrom(CHATS).where(CHATS.ID.eq(id)).fetchOne();
            }
            if (chat == null) throw ApiError.internal();
            return chats.require(ctx, chat, viewer.id());
        });
        return ResponseEntity.status(HttpStatus.CREATED).body(made);
    }

    @PostMapping("/chats")
    public ResponseEntity<Map<String, Object>> group(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        String title = title(body.string("title"));
        String color = color(body);
        List<UUID> members = people(body, "memberIds", false);
        Instant now = clock.instant();
        Map<String, Object> made = db.tx(ctx -> {
            Database.lockPerson(ctx, viewer.id());
            Set<UUID> mine = Relations.connectionsOf(ctx, viewer.id());
            if (!mine.containsAll(members)) throw ApiError.forbidden("only your connections can be added");
            if (members.size() + 1 > Chats.GROUP_MEMBERS_MAX) throw ApiError.conflict("group_full", "a group has at most " + Chats.GROUP_MEMBERS_MAX + " people");
            if (ctx.fetchCount(CHATS, CHATS.KIND.eq("group").and(CHATS.OWNER_ID.eq(viewer.id()))) >= Chats.GROUPS_OWNED_MAX) {
                throw ApiError.conflict("too_many_groups", "at most " + Chats.GROUPS_OWNED_MAX + " groups");
            }
            limits.check(viewer.id(), Limits.Action.GROUP);
            UUID id = Ids.next();
            ctx.insertInto(CHATS).set(CHATS.ID, id).set(CHATS.KIND, "group").set(CHATS.TITLE, title).set(CHATS.COLOR, color)
                    .set(CHATS.OWNER_ID, viewer.id()).set(CHATS.MEMBER_COUNT, members.size() + 1).set(CHATS.CREATED_AT, now).execute();
            ctx.insertInto(CHAT_MEMBERS).set(CHAT_MEMBERS.CHAT_ID, id).set(CHAT_MEMBERS.USER_ID, viewer.id()).set(CHAT_MEMBERS.ROLE, "owner")
                    .set(CHAT_MEMBERS.JOINED_AT, now).set(CHAT_MEMBERS.JOINED_SEQ, 1L).execute();
            for (UUID member : members) {
                ctx.insertInto(CHAT_MEMBERS).set(CHAT_MEMBERS.CHAT_ID, id).set(CHAT_MEMBERS.USER_ID, member).set(CHAT_MEMBERS.JOINED_AT, now)
                        .set(CHAT_MEMBERS.JOINED_SEQ, 1L).execute();
            }
            ChatsRecord chat = ctx.selectFrom(CHATS).where(CHATS.ID.eq(id)).fetchOne();
            if (chat == null) throw ApiError.internal();
            chats.post(ctx, chat, viewer.id(), "Created “" + title + "”", null, true, null);
            chats.push(ctx, id, chats.members(ctx, id));
            return chats.detail(ctx, chat, viewer.id());
        });
        return ResponseEntity.status(HttpStatus.CREATED).body(made);
    }

    @GetMapping("/chats/{chatId}")
    public Map<String, Object> get(Viewer viewer, @PathVariable String chatId) {
        return db.read(ctx -> chats.detail(ctx, Chats.find(ctx, chatId, false), viewer.id()));
    }

    // --- running a chat ---

    @PatchMapping("/chats/{chatId}")
    public Map<String, Object> patch(Viewer viewer, @PathVariable String chatId, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, true);
            Chats.requireRank(ctx, chat, viewer.id(), "admin", now);
            limits.check(viewer.id(), Limits.Action.CHAT_EDIT);
            boolean group = "group".equals(chat.getKind());
            if ((body.has("title") || body.has("color")) && !group) throw ApiError.badRequest("an event chat is named after its event");
            if (body.has("title")) chat.setTitle(title(body.string("title")));
            if (body.has("color")) chat.setColor(color(body));
            if (body.has("readOnly")) {
                Boolean readOnly = body.bool("readOnly");
                if (readOnly == null) throw ApiError.badRequest("readOnly: true or false");
                if (!readOnly.equals(chat.getReadOnly())) {
                    chat.setReadOnly(readOnly);
                    chat.update();
                    chats.post(ctx, chat, viewer.id(), Chats.nameOf(ctx, viewer.id())
                            + (readOnly ? " made the chat read-only: only admins write" : " let everyone write again"), null, true, null);
                }
            }
            if (chat.touched()) chat.update();
            chats.push(ctx, chat.getId(), chats.members(ctx, chat.getId()));
            return chats.detail(ctx, chat, viewer.id());
        });
    }

    @PostMapping("/chats/{chatId}/members")
    public Map<String, Object> addMembers(Viewer viewer, @PathVariable String chatId, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        List<UUID> wanted = people(body, "userIds", true);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, false);
            if (!"group".equals(chat.getKind())) throw ApiError.notFound("chat not found");
            Chats.requireRank(ctx, chat, viewer.id(), "admin", now);
            Set<UUID> mine = Relations.connectionsOf(ctx, viewer.id());
            if (wanted.isEmpty() || !mine.containsAll(wanted)) throw ApiError.forbidden("only your connections can be added");
            // Someone with a block with the owner would be where who runs the group cannot see them
            UUID owner = chat.getOwnerId();
            if (owner != null && !Collections.disjoint(Relations.blockedWith(ctx, owner), wanted)) {
                throw ApiError.forbidden("they cannot be added to this group");
            }
            List<UUID> fresh = new ArrayList<>(wanted);
            fresh.removeAll(chats.members(ctx, chat.getId()));
            if (!fresh.isEmpty()) {
                // One statement holds the row of the chat: no message can come in between (§18)
                Long seq = ctx.update(CHATS).set(CHATS.MEMBER_COUNT, CHATS.MEMBER_COUNT.plus(fresh.size())).where(CHATS.ID.eq(chat.getId()))
                        .and(CHATS.MEMBER_COUNT.plus(fresh.size()).le(Chats.GROUP_MEMBERS_MAX)).returning(CHATS.SEQ).fetchOne(CHATS.SEQ);
                if (seq == null) throw ApiError.conflict("group_full", "a group has at most " + Chats.GROUP_MEMBERS_MAX + " people");
                limits.check(viewer.id(), Limits.Action.MEMBERS);
                List<String> names = new ArrayList<>();
                for (UUID member : fresh) {
                    ctx.insertInto(CHAT_MEMBERS).set(CHAT_MEMBERS.CHAT_ID, chat.getId()).set(CHAT_MEMBERS.USER_ID, member)
                            .set(CHAT_MEMBERS.JOINED_AT, now).set(CHAT_MEMBERS.JOINED_SEQ, seq + 1).set(CHAT_MEMBERS.READ_COUNTER, chat.getCounter())
                            .execute();
                    names.add(Chats.nameOf(ctx, member));
                }
                chats.post(ctx, chat, viewer.id(), Chats.nameOf(ctx, viewer.id()) + " added " + String.join(", ", names), null, true, null);
            }
            chats.push(ctx, chat.getId(), chats.members(ctx, chat.getId()));
            return chats.detail(ctx, chat, viewer.id());
        });
    }

    @DeleteMapping("/chats/{chatId}/members/{memberId}")
    public ResponseEntity<Void> removeMember(Viewer viewer, @PathVariable String chatId, @PathVariable String memberId) {
        Instant now = clock.instant();
        db.txRun(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, true);
            EventsRecord event = Chats.eventOf(ctx, chat);
            ChatMembersRecord me = Chats.member(ctx, chat.getId(), viewer.id());
            if (me == null || !Chats.moderated(chat, event, now)) throw ApiError.notFound("chat not found");
            UUID target = "me".equals(memberId) ? viewer.id() : Ids.parse("usr", memberId).orElseThrow(() -> ApiError.notFound("member not found"));
            if (target.equals(viewer.id())) {
                if ("owner".equals(me.getRole())) {
                    if (event != null) throw ApiError.forbidden("the organizer cancels the event instead");
                    // The group goes on with who has been in it longest; alone in it, it is over
                    chats.ownerLeaves(ctx, chat, viewer.id());
                } else if (event != null) {
                    events.leave(ctx, event, viewer.id(), null, now);
                } else {
                    chats.leaveGroup(ctx, chat, viewer.id(), null);
                }
                return;
            }
            Chats.requireAbove(ctx, chat, viewer.id(), target, now);
            limits.check(viewer.id(), Limits.Action.CHAT_EDIT);
            if (event != null) events.leave(ctx, event, target, viewer.id(), now);
            else chats.leaveGroup(ctx, chat, target, viewer.id());
        });
        return ResponseEntity.noContent().build();
    }

    @PutMapping("/chats/{chatId}/members/{memberId}/role")
    public Map<String, Object> role(Viewer viewer, @PathVariable String chatId, @PathVariable String memberId,
                                    @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, true);
            Chats.requireRank(ctx, chat, viewer.id(), "owner", now);
            limits.check(viewer.id(), Limits.Action.CHAT_EDIT);
            String role = body.string("role");
            if (!"admin".equals(role) && !"member".equals(role)) throw ApiError.badRequest("role: admin or member");
            UUID target = Ids.parse("usr", memberId).orElseThrow(() -> ApiError.notFound("member not found"));
            ChatMembersRecord member = Chats.member(ctx, chat.getId(), target);
            if (member == null || Relations.blockedEither(ctx, viewer.id(), target)) throw ApiError.notFound("member not found");
            if (target.equals(viewer.id())) throw ApiError.forbidden("not on yourself");
            if ("admin".equals(member.getRole()) != "admin".equals(role)) {
                member.setRole(role);
                if ("admin".equals(role)) {
                    member.setMutedUntil(null);
                    member.setMutedForever(false);
                }
                member.update();
                String name = Chats.nameOf(ctx, target);
                chats.post(ctx, chat, viewer.id(), "admin".equals(role) ? name + " is now an admin" : name + " is no longer an admin", null, true, null);
            }
            chats.push(ctx, chat.getId(), chats.members(ctx, chat.getId()));
            return chats.detail(ctx, chat, viewer.id());
        });
    }

    @PutMapping("/chats/{chatId}/members/{memberId}/mute")
    public Map<String, Object> mute(Viewer viewer, @PathVariable String chatId, @PathVariable String memberId,
                                    @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        Instant now = clock.instant();
        Integer minutes = body.isNull("minutes") || !body.has("minutes") ? null : body.integer("minutes");
        if (minutes != null && !MUTE_MINUTES.contains(minutes)) throw ApiError.badRequest("minutes: one of [60, 480, 10080], or null (until unmuted)");
        return muting(viewer, chatId, memberId, now, member -> {
            member.setMutedForever(minutes == null);
            member.setMutedUntil(minutes == null ? null : now.plus(Duration.ofMinutes(minutes)));
        });
    }

    @DeleteMapping("/chats/{chatId}/members/{memberId}/mute")
    public Map<String, Object> unmute(Viewer viewer, @PathVariable String chatId, @PathVariable String memberId) {
        Instant now = clock.instant();
        return muting(viewer, chatId, memberId, now, member -> {
            member.setMutedForever(false);
            member.setMutedUntil(null);
        });
    }

    private Map<String, Object> muting(Viewer viewer, String chatId, String memberId, Instant now,
                                       java.util.function.Consumer<ChatMembersRecord> change) {
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, false);
            UUID target = Ids.parse("usr", memberId).orElseThrow(() -> ApiError.notFound("member not found"));
            ChatMembersRecord member = Chats.requireAbove(ctx, chat, viewer.id(), target, now);
            limits.check(viewer.id(), Limits.Action.CHAT_EDIT);
            change.accept(member);
            member.update();
            // The muted person, and who runs the chat (they see the mutes)
            Set<UUID> told = new LinkedHashSet<>();
            told.add(target);
            told.addAll(ctx.select(CHAT_MEMBERS.USER_ID).from(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId()))
                    .and(CHAT_MEMBERS.ROLE.ne("member")).fetch(CHAT_MEMBERS.USER_ID));
            chats.push(ctx, chat.getId(), told);
            return chats.detail(ctx, chat, viewer.id());
        });
    }

    @DeleteMapping("/chats/{chatId}")
    public ResponseEntity<Void> delete(Viewer viewer, @PathVariable String chatId) {
        Instant now = clock.instant();
        db.txRun(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, true);
            if (!"group".equals(chat.getKind()) || Chats.member(ctx, chat.getId(), viewer.id()) == null) throw ApiError.notFound("chat not found");
            Chats.requireRank(ctx, chat, viewer.id(), "owner", now);
            chats.endGroup(ctx, chat);
        });
        return ResponseEntity.noContent().build();
    }

    @DeleteMapping("/chats/{chatId}/picture")
    public Map<String, Object> deletePicture(Viewer viewer, @PathVariable String chatId) {
        Instant now = clock.instant();
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, true);
            if (!"group".equals(chat.getKind())) throw ApiError.notFound("chat not found");
            Chats.requireRank(ctx, chat, viewer.id(), "admin", now);
            if (chat.getPictureKey() != null) {
                uploads.discard(chat.getPictureKey());
                chat.setPictureKey(null);
                chat.update();
                chats.post(ctx, chat, viewer.id(), Chats.nameOf(ctx, viewer.id()) + " removed the group's photo", null, true, null);
                chats.push(ctx, chat.getId(), chats.members(ctx, chat.getId()));
            }
            return chats.detail(ctx, chat, viewer.id());
        });
    }

    // --- pins ---

    @PutMapping("/chats/{chatId}/pins/{messageId}")
    public Map<String, Object> pin(Viewer viewer, @PathVariable String chatId, @PathVariable String messageId) {
        Instant now = clock.instant();
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, true);
            Chats.requireRank(ctx, chat, viewer.id(), "admin", now);
            MessagesRecord message = message(ctx, chat, messageId);
            if (message.getSystem() || message.getDeletedAt() != null) throw ApiError.badRequest("system or removed messages cannot be pinned");
            limits.check(viewer.id(), Limits.Action.CHAT_EDIT);
            ctx.insertInto(CHAT_PINS).set(CHAT_PINS.CHAT_ID, chat.getId()).set(CHAT_PINS.MESSAGE_ID, message.getId()).set(CHAT_PINS.PINNED_AT, now)
                    .onConflictDoNothing().execute();
            // At most three: a new pin beyond them unpins the oldest
            ctx.deleteFrom(CHAT_PINS).where(CHAT_PINS.CHAT_ID.eq(chat.getId())).and(CHAT_PINS.MESSAGE_ID.in(
                    ctx.select(CHAT_PINS.MESSAGE_ID).from(CHAT_PINS).where(CHAT_PINS.CHAT_ID.eq(chat.getId()))
                            .orderBy(CHAT_PINS.PINNED_AT.desc()).offset(Chats.PIN_MAX))).execute();
            chats.push(ctx, chat.getId(), chats.members(ctx, chat.getId()));
            return chats.detail(ctx, chat, viewer.id());
        });
    }

    @DeleteMapping("/chats/{chatId}/pins/{messageId}")
    public Map<String, Object> unpin(Viewer viewer, @PathVariable String chatId, @PathVariable String messageId) {
        Instant now = clock.instant();
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, true);
            Chats.requireRank(ctx, chat, viewer.id(), "admin", now);
            limits.check(viewer.id(), Limits.Action.CHAT_EDIT);
            Ids.parse("msg", messageId).ifPresent(id ->
                    ctx.deleteFrom(CHAT_PINS).where(CHAT_PINS.CHAT_ID.eq(chat.getId())).and(CHAT_PINS.MESSAGE_ID.eq(id)).execute());
            chats.push(ctx, chat.getId(), chats.members(ctx, chat.getId()));
            return chats.detail(ctx, chat, viewer.id());
        });
    }

    // --- polls ---

    @PostMapping("/chats/{chatId}/polls")
    public ResponseEntity<Map<String, Object>> poll(Viewer viewer, @PathVariable String chatId, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        Instant now = clock.instant();
        Map<String, Object> made = db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, false);
            Chats.requireRank(ctx, chat, viewer.id(), "admin", now);
            if (!Boolean.TRUE.equals(chats.require(ctx, chat, viewer.id()).get("canWrite"))) throw ApiError.forbidden("you cannot write in this chat");
            Polls.Input input = Polls.input(body, viewer.id());
            limits.check(viewer.id(), Limits.Action.MESSAGE);
            MessagesRecord message = chats.post(ctx, chat, viewer.id(), input.question(), null, false, input.poll());
            return chats.message(message, chat, Map.of(), true);
        });
        return ResponseEntity.status(HttpStatus.CREATED).body(made);
    }

    @PostMapping("/chats/{chatId}/polls/{messageId}/votes")
    public Map<String, Object> vote(Viewer viewer, @PathVariable String chatId, @PathVariable String messageId,
                                    @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, false);
            chats.require(ctx, chat, viewer.id());
            MessagesRecord message = pollMessage(ctx, chat, messageId, true);
            ChatMembersRecord member = Chats.member(ctx, chat.getId(), viewer.id());
            // A poll from before they joined the group, or of someone blocked, is not there for them
            if (member == null || !Chats.sees(message, chat, member, Relations.blockedWith(ctx, viewer.id()))) throw ApiError.notFound("poll not found");
            if (Chats.muted(member, now) && Chats.moderated(chat, Chats.eventOf(ctx, chat), now)) throw ApiError.forbidden("you are muted in this chat");
            List<String> choices = Polls.choices(Polls.of(message), body);
            limits.check(viewer.id(), Limits.Action.VOTE);
            if (choices.isEmpty()) {
                ctx.deleteFrom(POLL_VOTES).where(POLL_VOTES.MESSAGE_ID.eq(message.getId())).and(POLL_VOTES.USER_ID.eq(viewer.id())).execute();
            } else {
                ctx.insertInto(POLL_VOTES).set(POLL_VOTES.CHAT_ID, chat.getId()).set(POLL_VOTES.MESSAGE_ID, message.getId())
                        .set(POLL_VOTES.USER_ID, viewer.id()).set(POLL_VOTES.OPTION_IDS, choices.toArray(String[]::new))
                        .onConflict(POLL_VOTES.MESSAGE_ID, POLL_VOTES.USER_ID).doUpdate().set(POLL_VOTES.OPTION_IDS, choices.toArray(String[]::new))
                        .execute();
            }
            chats.updated(ctx, chat, message);
            return mine(ctx, chat, message, viewer.id());
        });
    }

    @PostMapping("/chats/{chatId}/polls/{messageId}/close")
    public Map<String, Object> closePoll(Viewer viewer, @PathVariable String chatId, @PathVariable String messageId) {
        Instant now = clock.instant();
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, false);
            MessagesRecord message = pollMessage(ctx, chat, messageId, true);
            ObjectNode poll = Polls.of(message);
            if (!viewer.id().toString().equals(poll.get("creator").stringValue())) {
                Chats.requireRank(ctx, chat, viewer.id(), "admin", now);
            } else if (Chats.member(ctx, chat.getId(), viewer.id()) == null) {
                throw ApiError.notFound("chat not found");
            }
            // Closed once: asked again it tells nobody again
            if (!poll.get("closed").booleanValue()) {
                limits.check(viewer.id(), Limits.Action.CHAT_EDIT);
                poll.put("closed", true);
                message.setPoll(JSONB.valueOf(Json.text(poll)));
                message.update();
                chats.updated(ctx, chat, message);
            }
            return mine(ctx, chat, message, viewer.id());
        });
    }

    // --- messages ---

    @DeleteMapping("/chats/{chatId}/messages/{messageId}")
    public Map<String, Object> deleteMessage(Viewer viewer, @PathVariable String chatId, @PathVariable String messageId) {
        Instant now = clock.instant();
        return db.tx(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, false);
            chats.require(ctx, chat, viewer.id());
            MessagesRecord message = message(ctx, chat, messageId);
            if (message.getSystem()) throw ApiError.badRequest("system messages cannot be removed");
            UUID sender = message.getSender();
            if (!viewer.id().equals(sender)) {
                ChatMembersRecord acting = Chats.requireRank(ctx, chat, viewer.id(), "admin", now);
                ChatMembersRecord author = sender == null ? null : Chats.member(ctx, chat.getId(), sender);
                String role = author == null ? "member" : author.getRole();
                if (Chats.rank(role) >= Chats.rank(acting.getRole())) throw ApiError.forbidden("only a message of someone with a lower role");
                limits.check(viewer.id(), Limits.Action.CHAT_EDIT);
            }
            if (message.getDeletedAt() == null) {
                // The text goes for everyone at once and on the server; its place stays (§18)
                message.setDeletedAt(now);
                message.setText("");
                message.setPoll(null);
                message.update();
                ctx.deleteFrom(POLL_VOTES).where(POLL_VOTES.MESSAGE_ID.eq(message.getId())).execute();
                int unpinned = ctx.deleteFrom(CHAT_PINS).where(CHAT_PINS.CHAT_ID.eq(chat.getId())).and(CHAT_PINS.MESSAGE_ID.eq(message.getId())).execute();
                chats.updated(ctx, chat, message);
                if (unpinned > 0) chats.push(ctx, chat.getId(), chats.members(ctx, chat.getId()));
            }
            return chats.message(message, chat, null, true);
        });
    }

    @GetMapping("/chats/{chatId}/messages")
    public Map<String, Object> messages(Viewer viewer, @PathVariable String chatId, @RequestParam(required = false) @Nullable String before,
                                        @RequestParam(required = false) @Nullable String after, @RequestParam(required = false) @Nullable String limit) {
        if (before != null && after != null) throw ApiError.badRequest("before or after, not both");
        int size = limit == null ? 50 : limit.matches("[0-9]{1,4}") ? Math.max(1, Math.min(100, Integer.parseInt(limit))) : 50;
        return db.read(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, false);
            chats.require(ctx, chat, viewer.id());
            ChatMembersRecord member = Chats.member(ctx, chat.getId(), viewer.id());
            if (member == null) throw ApiError.notFound("chat not found");
            Set<UUID> blocked = Relations.blockedWith(ctx, viewer.id());
            var visible = MESSAGES.CHAT_ID.eq(chat.getId());
            if ("group".equals(chat.getKind())) visible = visible.and(MESSAGES.SEQ.ge(member.getJoinedSeq()));
            if (!blocked.isEmpty()) visible = visible.and(MESSAGES.SENDER.isNull().or(MESSAGES.SENDER.notIn(blocked)));
            List<MessagesRecord> page;
            String next = null;
            if (after != null) {
                // Newer than a message the app has: oldest first, and the cursor while there are more
                Long seq = seqOf(ctx, chat, after);
                if (seq == null) throw ApiError.notFound("message not found");
                page = ctx.selectFrom(MESSAGES).where(visible).and(MESSAGES.SEQ.gt(seq)).orderBy(MESSAGES.SEQ.asc()).limit(size + 1).fetch();
                if (page.size() > size) {
                    page = new ArrayList<>(page.subList(0, size));
                    next = Chats.messageId(page.getLast().getId());
                }
            } else {
                // An id the phone kept may be gone: then the most recent page
                Long seq = before == null ? null : seqOf(ctx, chat, before);
                var query = ctx.selectFrom(MESSAGES).where(visible);
                if (seq != null) query = query.and(MESSAGES.SEQ.lt(seq));
                List<MessagesRecord> newest = new ArrayList<>(query.orderBy(MESSAGES.SEQ.desc()).limit(size + 1).fetch());
                boolean more = newest.size() > size;
                if (more) newest = new ArrayList<>(newest.subList(0, size));
                Collections.reverse(newest);
                page = newest;
                if (more && !page.isEmpty()) next = Chats.messageId(page.getFirst().getId());
            }
            Map<UUID, Map<UUID, List<String>>> votes = Chats.votesOf(ctx, viewer.id(), page);
            List<Map<String, Object>> items = new ArrayList<>();
            for (MessagesRecord message : page) items.add(chats.message(message, chat, votes.get(message.getId()), true));
            Map<String, Object> answer = new LinkedHashMap<>();
            answer.put("items", items);
            answer.put("nextCursor", next);
            return answer;
        });
    }

    @PostMapping("/chats/{chatId}/messages")
    public ResponseEntity<Map<String, Object>> send(Viewer viewer, @PathVariable String chatId, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        String clientId = body.string("clientId");
        if (clientId != null && (clientId.isEmpty() || clientId.length() > 64)) throw ApiError.badRequest("clientId: a string of at most 64 characters");
        String raw2 = body.has("text") && body.raw("text") != null && body.raw("text").isString() ? body.string("text") : null;
        String text = raw2 == null ? "" : Text.strip(Text.plain(raw2));
        Map<String, Object> sent;
        try {
            sent = db.tx(ctx -> {
                ChatsRecord chat = Chats.find(ctx, chatId, false);
                Map<String, Object> summary = chats.require(ctx, chat, viewer.id());
                // Sent already, its answer lost on the way: the same message, whatever changed since (§18)
                Map<String, Object> again = clientId == null ? null : sentBefore(ctx, chat, viewer.id(), clientId);
                if (again != null) return again;
                if (!Boolean.TRUE.equals(summary.get("canWrite"))) throw ApiError.forbidden("you cannot write in this chat");
                if (Text.length(text) < 1 || Text.length(text) > MESSAGE_MAX) throw ApiError.badRequest("text: 1–" + MESSAGE_MAX + " characters");
                limits.check(viewer.id(), Limits.Action.MESSAGE);
                return chats.message(chats.post(ctx, chat, viewer.id(), text, clientId, false, null), chat, null, false);
            });
        } catch (Chats.Duplicate duplicate) {
            sent = db.read(ctx -> {
                Map<String, Object> again = clientId == null ? null : sentBefore(ctx, Chats.find(ctx, chatId, false), viewer.id(), clientId);
                if (again == null) throw ApiError.internal();
                return again;
            });
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(sent);
    }

    private @Nullable Map<String, Object> sentBefore(DSLContext ctx, ChatsRecord chat, UUID sender, String clientId) {
        UUID id = ctx.select(SENT_MESSAGES.MESSAGE_ID).from(SENT_MESSAGES).where(SENT_MESSAGES.CHAT_ID.eq(chat.getId()))
                .and(SENT_MESSAGES.SENDER.eq(sender)).and(SENT_MESSAGES.CLIENT_ID.eq(clientId)).fetchOne(SENT_MESSAGES.MESSAGE_ID);
        if (id == null) return null;
        MessagesRecord message = ctx.selectFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.getId())).and(MESSAGES.ID.eq(id)).fetchOne();
        return message == null ? null : chats.message(message, chat, null, false);
    }

    @PostMapping("/chats/{chatId}/read")
    public ResponseEntity<Void> read(Viewer viewer, @PathVariable String chatId, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        String messageId = body.string("messageId");
        db.txRun(ctx -> {
            ChatsRecord chat = Chats.find(ctx, chatId, false);
            chats.require(ctx, chat, viewer.id());
            MessagesRecord message = message(ctx, chat, messageId == null ? "" : messageId);
            // Never goes back
            int moved = ctx.update(CHAT_MEMBERS).set(CHAT_MEMBERS.READ_COUNTER, message.getCounter()).set(CHAT_MEMBERS.READ_AT, message.getAt())
                    .where(CHAT_MEMBERS.CHAT_ID.eq(chat.getId())).and(CHAT_MEMBERS.USER_ID.eq(viewer.id()))
                    .and(CHAT_MEMBERS.READ_AT.isNull().or(CHAT_MEMBERS.READ_AT.lt(message.getAt()))).execute();
            if (moved > 0) {
                Map<String, Object> summary = chats.require(ctx, chat, viewer.id());
                // Their other devices stop counting it as new
                outbox.send(viewer.id(), Map.of("type", "chat.read", "chatId", Chats.publicId(chat), "unread", summary.get("unread")));
            }
        });
        return ResponseEntity.noContent().build();
    }

    // --- small things ---

    private Map<String, Object> mine(DSLContext ctx, ChatsRecord chat, MessagesRecord message, UUID viewer) {
        MessagesRecord fresh = ctx.selectFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.getId())).and(MESSAGES.ID.eq(message.getId())).fetchOne();
        MessagesRecord shown = fresh == null ? message : fresh;
        return chats.message(shown, chat, Chats.votesOf(ctx, viewer, List.of(shown)).get(shown.getId()), true);
    }

    static MessagesRecord message(DSLContext ctx, ChatsRecord chat, String publicId) {
        UUID id = Ids.parse("msg", publicId).orElseThrow(() -> ApiError.notFound("message not found"));
        MessagesRecord message = ctx.selectFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.getId())).and(MESSAGES.ID.eq(id)).fetchOne();
        if (message == null) throw ApiError.notFound("message not found");
        return message;
    }

    static MessagesRecord pollMessage(DSLContext ctx, ChatsRecord chat, String publicId, boolean lock) {
        UUID id = Ids.parse("msg", publicId).orElseThrow(() -> ApiError.notFound("poll not found"));
        var query = ctx.selectFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.getId())).and(MESSAGES.ID.eq(id));
        MessagesRecord message = lock ? query.forUpdate().fetchOne() : query.fetchOne();
        if (message == null || message.getPoll() == null) throw ApiError.notFound("poll not found");
        return message;
    }

    static @Nullable Long seqOf(DSLContext ctx, ChatsRecord chat, String publicId) {
        UUID id = Ids.parse("msg", publicId).orElse(null);
        if (id == null) return null;
        return ctx.select(MESSAGES.SEQ).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.getId())).and(MESSAGES.ID.eq(id)).fetchOne(MESSAGES.SEQ);
    }

    static String title(@Nullable String value) {
        String title = value == null ? "" : Text.words(Text.plain(value));
        if (Text.length(title) < 1 || Text.length(title) > 50) throw ApiError.badRequest("title: 1–50 characters");
        return title;
    }

    static @Nullable String color(Body body) {
        if (!body.has("color") || body.isNull("color")) return null;
        String color = body.string("color");
        if (color == null || !TONES.contains(color)) throw ApiError.badRequest("color: one of the app's tones");
        return color;
    }

    /** A list of people's public ids; any that is not one: 403 like someone who is not a connection. */
    static List<UUID> people(Body body, String field, boolean required) {
        JsonNode list = body.raw(field);
        if (list == null || list.isNull()) {
            if (required) throw ApiError.forbidden("only your connections can be added");
            return List.of();
        }
        if (!list.isArray() || list.size() > Chats.GROUP_MEMBERS_MAX) throw ApiError.forbidden("only your connections can be added");
        LinkedHashSet<UUID> ids = new LinkedHashSet<>();
        for (JsonNode item : list) {
            UUID id = item.isString() ? Ids.parse("usr", item.stringValue()).orElse(null) : null;
            if (id == null) throw ApiError.forbidden("only your connections can be added");
            ids.add(id);
        }
        return new ArrayList<>(ids);
    }
}
