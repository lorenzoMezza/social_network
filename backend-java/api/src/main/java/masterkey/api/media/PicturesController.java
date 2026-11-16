// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import static masterkey.store.db.Tables.CHATS;
import static masterkey.store.db.Tables.USERS;

import java.time.Instant;
import java.time.InstantSource;
import java.util.Map;
import masterkey.api.Limits;
import masterkey.api.chats.Chats;
import masterkey.api.people.MeController;
import masterkey.api.people.Views;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.presence.Presence;
import masterkey.store.Database;
import masterkey.store.db.tables.records.ChatsRecord;
import org.jspecify.annotations.Nullable;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/** The profile picture and a group's picture: 512 px squares made from an upload (§19). */
@RestController
@RequestMapping("/v1")
public class PicturesController {

    private final Database db;
    private final Uploads uploads;
    private final MeController me;
    private final Chats chats;
    private final Presence presence;
    private final Limits limits;
    private final InstantSource clock;

    public PicturesController(Database db, Uploads uploads, MeController me, Chats chats, Presence presence, Limits limits, InstantSource clock) {
        this.db = db;
        this.uploads = uploads;
        this.me = me;
        this.chats = chats;
        this.presence = presence;
        this.limits = limits;
        this.clock = clock;
    }

    @PutMapping("/me/picture")
    public Views.Me putPicture(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        limits.check(viewer.id(), Limits.Action.PICTURE);
        Uploads.Claimed claimed = uploads.claim(viewer.id(), body.string("uploadId"), "profile-picture", null, null, Imaging.Kind.SQUARE, ctx -> { });
        try {
            Views.Me answer = db.tx(ctx -> {
                String previous = ctx.select(USERS.PICTURE_KEY).from(USERS).where(USERS.ID.eq(viewer.id())).forUpdate().fetchOne(USERS.PICTURE_KEY);
                ctx.update(USERS).set(USERS.PICTURE_KEY, claimed.keys().getFirst()).where(USERS.ID.eq(viewer.id())).execute();
                Uploads.finish(ctx, claimed.upload());
                uploads.discard(previous);
                return me.me(ctx, viewer.id());
            });
            presence.userChanged(viewer.id());
            return answer;
        } catch (RuntimeException error) {
            uploads.abandon(claimed, false);
            throw error;
        }
    }

    @DeleteMapping("/me/picture")
    public Views.Me deletePicture(Viewer viewer) {
        Views.Me answer = db.tx(ctx -> {
            String previous = ctx.select(USERS.PICTURE_KEY).from(USERS).where(USERS.ID.eq(viewer.id())).forUpdate().fetchOne(USERS.PICTURE_KEY);
            ctx.update(USERS).setNull(USERS.PICTURE_KEY).where(USERS.ID.eq(viewer.id())).execute();
            uploads.discard(previous);
            return me.me(ctx, viewer.id());
        });
        presence.userChanged(viewer.id());
        return answer;
    }

    /** A group's picture, chosen by its owner or an admin; said in the chat, as a new name would be. */
    @PutMapping("/chats/{chatId}/picture")
    public Map<String, Object> putGroupPicture(Viewer viewer, @PathVariable String chatId, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        Instant now = clock.instant();
        ChatsRecord group = db.read(ctx -> {
            ChatsRecord found = Chats.find(ctx, chatId, false);
            if (!"group".equals(found.getKind())) throw ApiError.notFound("chat not found");
            Chats.requireRankOf(ctx, found, viewer.id(), "admin", now);
            return found;
        });
        limits.check(viewer.id(), Limits.Action.PICTURE);
        Uploads.Claimed claimed = uploads.claim(viewer.id(), body.string("uploadId"), "group-picture", null, group.getId(), Imaging.Kind.SQUARE,
                ctx -> Chats.requireRankOf(ctx, group, viewer.id(), "admin", now));
        try {
            return db.tx(ctx -> {
                ChatsRecord chat = ctx.selectFrom(CHATS).where(CHATS.ID.eq(group.getId())).forUpdate().fetchOne();
                if (chat == null) throw ApiError.notFound("chat not found");
                Chats.requireRankOf(ctx, chat, viewer.id(), "admin", now);
                String previous = chat.getPictureKey();
                chat.setPictureKey(claimed.keys().getFirst());
                chat.update();
                Uploads.finish(ctx, claimed.upload());
                uploads.discard(previous);
                chats.post(ctx, chat, viewer.id(), Chats.nameOfUser(ctx, viewer.id()) + " changed the group's photo", null, true, null);
                chats.push(ctx, chat.getId(), chats.members(ctx, chat.getId()));
                return chats.detail(ctx, chat, viewer.id());
            });
        } catch (RuntimeException error) {
            uploads.abandon(claimed, false);
            throw error;
        }
    }
}
