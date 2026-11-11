// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.avatars;

import static masterkey.store.db.Tables.USERS;

import java.time.Duration;
import java.time.InstantSource;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import masterkey.api.Limits;
import masterkey.api.common.People;
import masterkey.api.common.Relations;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.presence.Presence;
import masterkey.store.Database;
import masterkey.store.db.tables.records.UsersRecord;
import org.jooq.JSONB;
import org.jspecify.annotations.Nullable;
import org.springframework.http.CacheControl;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** Avatars (API.md, Avatars; {@code routes/people.py}, avatars): {@code GET /users/{id}/avatar}, {@code PUT /me/avatar}. */
@RestController
@RequestMapping("/v1")
public class AvatarsController {

    static final Duration SAVE_WAIT = Duration.ofSeconds(5);

    private final Database db;
    private final AvatarLibrary library;
    private final MapAvatars maps;
    private final Presence presence;
    private final Limits limits;
    private final InstantSource clock;

    public AvatarsController(Database db, AvatarLibrary library, MapAvatars maps, Presence presence, Limits limits, InstantSource clock) {
        this.db = db;
        this.library = library;
        this.maps = maps;
        this.presence = presence;
        this.limits = limits;
        this.clock = clock;
    }

    /** An avatar read often (12 at a time while people are on the map): a cheap read, never waiting for the baker. */
    @GetMapping("/users/{userId}/avatar")
    public ResponseEntity<Map<String, Object>> get(Viewer viewer, @PathVariable String userId,
                                                   @RequestHeader(value = "If-None-Match", required = false) @Nullable String asked) {
        limits.check(viewer.id(), Limits.Action.PEOPLE);
        UUID id = People.id(userId);
        UsersRecord user = db.read(ctx -> {
            UsersRecord found = ctx.selectFrom(USERS).where(USERS.ID.eq(id)).fetchOne();
            if (found == null || Relations.blocks(ctx, id, viewer.id())) throw ApiError.notFound("user not found");
            return found;
        });
        Map<String, Object> entry = entry(user);
        // The map avatar is part of the answer: one made later changes the tag too
        Object map = entry.get("mapAvatar");
        String tag = "\"" + Ids.publicId("usr", id) + ":" + user.getAvatarVersion() + ":" + (map == null ? "-" : map) + "\"";
        if (tag.equals(asked)) return ResponseEntity.status(304).eTag(tag).build();
        return ResponseEntity.ok().eTag(tag).cacheControl(CacheControl.noCache()).body(entry);
    }

    @PutMapping("/me/avatar")
    public Map<String, Object> put(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        AvatarLibrary.Checked checked = library.validate(raw);
        ObjectNode clean = checked.clean();
        if (clean == null) throw new ApiError(400, "invalid_avatar", "invalid avatar", checked.errors(), Map.of());
        limits.check(viewer.id(), Limits.Action.AVATAR);
        clean.put("updatedAt", Json.time(clock.instant()));
        // The network first: the look made by the baker, waiting a few seconds at most
        String key = maps.waitFor(clean, SAVE_WAIT);
        UsersRecord user = db.tx(ctx -> {
            ctx.update(USERS).set(USERS.AVATAR, JSONB.valueOf(Json.text(clean))).set(USERS.AVATAR_VERSION, USERS.AVATAR_VERSION.plus(1))
                    .set(USERS.MAP_AVATAR_KEY, key).where(USERS.ID.eq(viewer.id())).execute();
            UsersRecord saved = ctx.selectFrom(USERS).where(USERS.ID.eq(viewer.id())).fetchOne();
            if (saved == null) throw ApiError.unauthorized("this account was deleted");
            return saved;
        });
        presence.userChanged(viewer.id());
        return entry(user);
    }

    private Map<String, Object> entry(UsersRecord user) {
        String publicId = Ids.publicId("usr", user.getId());
        JsonNode avatar = user.getAvatar() == null ? null : Json.parse(user.getAvatar().data());
        boolean saved = avatar != null;
        if (!saved) avatar = library.presetFor(publicId);
        String map = saved && user.getMapAvatarKey() != null ? user.getMapAvatarKey() : maps.now(avatar);
        if (saved && user.getMapAvatarKey() == null && map != null) {
            String made = map;
            int version = user.getAvatarVersion();
            // Kept with the account for the next reads, if the look did not change meanwhile
            db.txRun(ctx -> ctx.update(USERS).set(USERS.MAP_AVATAR_KEY, made).where(USERS.ID.eq(user.getId()))
                    .and(USERS.AVATAR_VERSION.eq(version)).execute());
        }
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("userId", publicId);
        entry.put("source", saved ? "saved" : "preset");
        entry.put("avatar", avatar);
        entry.put("avatarVersion", user.getAvatarVersion());
        entry.put("mapAvatar", map);
        return entry;
    }
}
