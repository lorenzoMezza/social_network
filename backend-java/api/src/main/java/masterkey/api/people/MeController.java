// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.people;

import static masterkey.store.db.Tables.CONNECTIONS;
import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.NOTIFICATIONS;
import static masterkey.store.db.Tables.STORY_HIDDEN;
import static masterkey.store.db.Tables.USERS;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.api.Limits;
import masterkey.api.Urls;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.core.Json;
import masterkey.core.Text;
import masterkey.presence.Presence;
import masterkey.store.Database;
import masterkey.store.db.tables.records.UsersRecord;
import org.jooq.DSLContext;
import org.jooq.JSONB;
import org.jspecify.annotations.Nullable;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** {@code GET /me} and {@code PATCH /me} (API.md, Me; {@code routes/people.py}). */
@RestController
@RequestMapping("/v1")
public class MeController {

    private final Database db;
    private final Urls urls;
    private final Limits limits;
    private final Presence presence;

    public MeController(Database db, Urls urls, Limits limits, Presence presence) {
        this.db = db;
        this.urls = urls;
        this.limits = limits;
        this.presence = presence;
    }

    @GetMapping("/me")
    public Views.Me get(Viewer viewer) {
        return db.read(ctx -> me(ctx, viewer.id()));
    }

    @PatchMapping("/me")
    public Views.Me patch(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        if (!body.fieldNames().hasNext()) throw ApiError.badRequest("nothing to change");
        List<String> errors = new ArrayList<>();
        String name = body.string("name");
        if (name != null) {
            name = Text.words(Text.plain(name));
            if (Text.length(name) < 1 || Text.length(name) > 30) errors.add("name: 1–30 characters");
        }
        String username = body.string("username");
        if (username != null) {
            username = username.toLowerCase(Locale.ROOT);
            while (username.startsWith("@")) username = username.substring(1);
            String problem = Text.usernameProblem(username);
            if (!problem.isEmpty()) errors.add("username: " + problem);
        }
        String bio = body.string("bio");
        if (bio != null) {
            bio = Text.strip(Text.plain(bio));
            if (Text.length(bio) > 200) errors.add("bio: at most 200 characters");
        }
        ObjectNode style = choices(body, "style", Profiles.STYLE_VALUES, errors, "style: unknown key or value");
        ObjectNode settings = booleans(body, "settings", Profiles.SETTINGS, errors, "settings: unknown key or not a boolean");
        ObjectNode story = booleans(body, "story", Set.copyOf(Profiles.STORY_KINDS), errors,
                "story: " + String.join(", ", Profiles.STORY_KINDS) + " as booleans");
        String audience = null;
        if (body.has("storyAudience") && !body.isNull("storyAudience")) {
            JsonNode value = java.util.Objects.requireNonNull(body.raw("storyAudience"));
            audience = value.isString() ? value.stringValue() : null;
            if (audience == null || !Profiles.STORY_AUDIENCES.contains(audience)) {
                errors.add("storyAudience: " + String.join(" or ", Profiles.STORY_AUDIENCES));
            }
        }
        if (!errors.isEmpty()) throw ApiError.badRequest("invalid profile", errors);
        limits.check(viewer.id(), Limits.Action.PROFILE);
        String newName = name, newUsername = username, newBio = bio, newAudience = audience;
        boolean[] seen = {false};
        Views.Me me = db.tx(ctx -> {
            UsersRecord user = ctx.selectFrom(USERS).where(USERS.ID.eq(viewer.id())).forUpdate().fetchOne();
            if (user == null) throw ApiError.unauthorized("this account was deleted");
            if (newUsername != null && !newUsername.equals(user.getUsername())) {
                if (Profiles.RESERVED_USERNAMES.contains(newUsername) || ctx.fetchExists(USERS, USERS.USERNAME.eq(newUsername))) {
                    throw ApiError.conflict("username_taken", "this username is taken");
                }
                limits.check(viewer.id(), Limits.Action.USERNAME);
                user.setUsername(newUsername);
            }
            if (newName != null) user.setName(newName);
            if (newBio != null) user.setBio(newBio);
            if (style != null) user.setStyle(merge(user.getStyle(), style));
            if (settings != null) user.setSettings(merge(user.getSettings(), settings));
            if (story != null) user.setStory(merge(user.getStory(), story));
            if (newAudience != null && !newAudience.equals(user.getStoryAudience())) {
                user.setStoryAudience(newAudience);
                // "Who's in" for strangers reads a copy of the choice on each row (§7.2)
                ctx.update(EVENT_ATTENDEES).set(EVENT_ATTENDEES.PUBLIC, "everyone".equals(newAudience))
                        .where(EVENT_ATTENDEES.USER_ID.eq(viewer.id())).execute();
            }
            // A new name, picture or backdrop: whoever has them on the map gets the summary again
            seen[0] = user.touched(USERS.USERNAME) || user.touched(USERS.NAME) || user.touched(USERS.STYLE);
            try {
                user.update();
            } catch (RuntimeException error) {
                if ("users_username_key".equals(Database.violated(error))) {
                    throw ApiError.conflict("username_taken", "this username is taken");
                }
                throw error;
            }
            return me(ctx, viewer.id());
        });
        if (seen[0]) presence.userChanged(viewer.id());
        return me;
    }

    /** The Me of a user, read in one place: GET, PATCH, the picture. */
    public Views.Me me(DSLContext ctx, UUID id) {
        UsersRecord user = ctx.selectFrom(USERS).where(USERS.ID.eq(id)).fetchOne();
        if (user == null) throw ApiError.unauthorized("this account was deleted");
        int organized = ctx.fetchCount(EVENTS, EVENTS.CREATOR_ID.eq(id).and(EVENTS.CANCELLED_AT.isNull()));
        int connections = ctx.fetchCount(CONNECTIONS, CONNECTIONS.USER_ID.eq(id));
        int hidden = ctx.fetchCount(STORY_HIDDEN, STORY_HIDDEN.USER_ID.eq(id));
        int unread = ctx.fetchCount(NOTIFICATIONS, NOTIFICATIONS.USER_ID.eq(id).and(NOTIFICATIONS.READ.isFalse()));
        return Views.me(user, urls, new Views.Stats(organized, connections), hidden, unread);
    }

    private static @Nullable ObjectNode choices(Body body, String field, Map<String, Set<String>> allowed, List<String> errors, String error) {
        if (!body.has(field) || body.isNull(field)) return null;
        JsonNode value = java.util.Objects.requireNonNull(body.raw(field));
        if (!value.isObject()) {
            errors.add(error);
            return null;
        }
        ObjectNode out = Json.object();
        for (Iterator<Map.Entry<String, JsonNode>> it = value.properties().iterator(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> entry = it.next();
            Set<String> values = allowed.get(entry.getKey());
            if (values == null || !entry.getValue().isString() || !values.contains(entry.getValue().stringValue())) {
                errors.add(error);
                return null;
            }
            out.put(entry.getKey(), entry.getValue().stringValue());
        }
        return out;
    }

    private static @Nullable ObjectNode booleans(Body body, String field, Set<String> allowed, List<String> errors, String error) {
        if (!body.has(field) || body.isNull(field)) return null;
        JsonNode value = java.util.Objects.requireNonNull(body.raw(field));
        if (!value.isObject()) {
            errors.add(error);
            return null;
        }
        ObjectNode out = Json.object();
        for (Iterator<Map.Entry<String, JsonNode>> it = value.properties().iterator(); it.hasNext(); ) {
            Map.Entry<String, JsonNode> entry = it.next();
            if (!allowed.contains(entry.getKey()) || !entry.getValue().isBoolean()) {
                errors.add(error);
                return null;
            }
            out.put(entry.getKey(), entry.getValue().booleanValue());
        }
        return out;
    }

    /** {@code {**old, **new}}: the keys sent replace, the others stay. */
    private static JSONB merge(@Nullable JSONB old, ObjectNode changes) {
        ObjectNode merged = Views.json(old).deepCopy() instanceof ObjectNode node ? node : Json.object();
        merged.setAll(changes);
        return JSONB.valueOf(Json.text(merged));
    }
}
