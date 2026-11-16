// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.people;

import java.time.Instant;
import masterkey.api.Urls;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.store.db.tables.records.UsersRecord;
import org.jooq.JSONB;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/** The shapes of API.md for people: UserSummary everywhere, Me for oneself. */
public final class Views {

    private Views() {
    }

    /** A person anywhere in the API, never a bare username. */
    public record UserSummary(String id, String username, String name, @Nullable String pictureUrl, int avatarVersion,
                              @Nullable String backdrop) {
    }

    public record Stats(int organized, int connections) {
    }

    public record Me(String id, String username, String name, @Nullable String pictureUrl, int avatarVersion,
                     @Nullable String backdrop, @Nullable String email, String bio, JsonNode style, JsonNode settings, Stats stats,
                     Instant createdAt, JsonNode story, String storyAudience, int storyHidden, int unreadNotifications) {
    }

    public static UserSummary summary(UsersRecord user, Urls urls) {
        return new UserSummary(Ids.publicId("usr", user.getId()), user.getUsername(), user.getName(),
                urls.media(user.getPictureKey()), user.getAvatarVersion(), backdrop(user.getStyle()));
    }

    public static Me me(UsersRecord user, Urls urls, Stats stats, int storyHidden, int unread) {
        UserSummary summary = summary(user, urls);
        return new Me(summary.id(), summary.username(), summary.name(), summary.pictureUrl(), summary.avatarVersion(),
                summary.backdrop(), user.getEmail(), user.getBio(), json(user.getStyle()), json(user.getSettings()), stats,
                user.getCreatedAt(), json(user.getStory()), user.getStoryAudience(), storyHidden, unread);
    }

    /** The backdrop of their profile: its colour marks them on the map. */
    static @Nullable String backdrop(@Nullable JSONB style) {
        if (style == null) return null;
        JsonNode value = json(style).get("backdrop");
        return value != null && value.isString() ? value.stringValue() : null;
    }

    public static JsonNode json(@Nullable JSONB value) {
        return value == null ? Json.object() : Json.parse(value.data());
    }
}
