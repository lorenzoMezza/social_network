// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.common;

import static masterkey.store.db.Tables.USERS;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import masterkey.api.Urls;
import masterkey.api.people.Views;
import masterkey.core.ApiError;
import masterkey.core.Ids;
import masterkey.store.db.tables.records.UsersRecord;
import org.jooq.DSLContext;
import org.jspecify.annotations.Nullable;

/** UserSummary everywhere (API.md, Conventions, People), read in one query for a whole list. */
public final class People {

    private final Urls urls;

    public People(Urls urls) {
        this.urls = urls;
    }

    public Map<UUID, Views.UserSummary> summaries(DSLContext ctx, Collection<UUID> ids) {
        Map<UUID, Views.UserSummary> found = new HashMap<>();
        if (ids.isEmpty()) return found;
        for (UsersRecord user : ctx.selectFrom(USERS).where(USERS.ID.in(ids)).fetch()) {
            found.put(user.getId(), Views.summary(user, urls));
        }
        return found;
    }

    public Views.@Nullable UserSummary summary(DSLContext ctx, @Nullable UUID id) {
        if (id == null) return null;
        UsersRecord user = ctx.selectFrom(USERS).where(USERS.ID.eq(id)).fetchOne();
        return user == null ? null : Views.summary(user, urls);
    }

    /** The UUID of a public user id, or 404 like anything that does not exist (§20). */
    public static UUID id(String publicId) {
        return Ids.require("usr", publicId, "user");
    }

    public static boolean exists(DSLContext ctx, UUID id) {
        return ctx.fetchExists(USERS, USERS.ID.eq(id));
    }

    public static void requireExists(DSLContext ctx, UUID id) {
        if (!exists(ctx, id)) throw ApiError.notFound("user not found");
    }
}
