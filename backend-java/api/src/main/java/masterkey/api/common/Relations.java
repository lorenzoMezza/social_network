// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.common;

import static masterkey.store.db.Tables.BLOCKS;
import static masterkey.store.db.Tables.CONNECTIONS;
import static masterkey.store.db.Tables.DISCONNECTED_PAIRS;
import static masterkey.store.db.Tables.USERS;

import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import masterkey.presence.Presence;
import org.jooq.DSLContext;
import org.jspecify.annotations.Nullable;

/**
 * Between two people: a block either way, a connection, a pair that was disconnected, whether
 * one may know what the other does ({@code sees_story}), whether they may write to each other.
 * Read from the database at every use (§7.5: a stale copy here is a security problem).
 */
public final class Relations {

    private final Presence presence;

    public Relations(Presence presence) {
        this.presence = presence;
    }

    public static boolean blockedEither(DSLContext ctx, UUID a, UUID b) {
        return ctx.fetchExists(BLOCKS, BLOCKS.BLOCKER.eq(a).and(BLOCKS.BLOCKED.eq(b)).or(BLOCKS.BLOCKER.eq(b).and(BLOCKS.BLOCKED.eq(a))));
    }

    /** Everyone with a block with the user, in either direction. */
    public static Set<UUID> blockedWith(DSLContext ctx, UUID user) {
        Set<UUID> found = new HashSet<>(ctx.select(BLOCKS.BLOCKED).from(BLOCKS).where(BLOCKS.BLOCKER.eq(user)).fetch(BLOCKS.BLOCKED));
        found.addAll(ctx.select(BLOCKS.BLOCKER).from(BLOCKS).where(BLOCKS.BLOCKED.eq(user)).fetch(BLOCKS.BLOCKER));
        return found;
    }

    public static boolean blocks(DSLContext ctx, UUID blocker, UUID blocked) {
        return ctx.fetchExists(BLOCKS, BLOCKS.BLOCKER.eq(blocker).and(BLOCKS.BLOCKED.eq(blocked)));
    }

    public static boolean connected(DSLContext ctx, UUID a, UUID b) {
        return ctx.fetchExists(CONNECTIONS, CONNECTIONS.USER_ID.eq(a).and(CONNECTIONS.OTHER_ID.eq(b)));
    }

    public static Set<UUID> connectionsOf(DSLContext ctx, UUID user) {
        return new HashSet<>(ctx.select(CONNECTIONS.OTHER_ID).from(CONNECTIONS).where(CONNECTIONS.USER_ID.eq(user)).fetch(CONNECTIONS.OTHER_ID));
    }

    public static boolean disconnected(DSLContext ctx, UUID a, UUID b) {
        UUID low = masterkey.core.Ids.low(a, b), high = masterkey.core.Ids.high(a, b);
        return ctx.fetchExists(DISCONNECTED_PAIRS, DISCONNECTED_PAIRS.A.eq(low).and(DISCONNECTED_PAIRS.B.eq(high)));
    }

    public static void markDisconnected(DSLContext ctx, UUID a, UUID b) {
        UUID low = masterkey.core.Ids.low(a, b), high = masterkey.core.Ids.high(a, b);
        ctx.insertInto(DISCONNECTED_PAIRS).set(DISCONNECTED_PAIRS.A, low).set(DISCONNECTED_PAIRS.B, high).onConflictDoNothing().execute();
    }

    /**
     * Whether the viewer may know what the owner does: their story, their lists, that they go
     * to an event. The one rule for every answer that says so ({@code Store.sees_story}).
     */
    public static boolean seesStory(DSLContext ctx, UUID viewer, UUID owner) {
        if (viewer.equals(owner) || connected(ctx, viewer, owner)) return true;
        return "everyone".equals(ctx.select(USERS.STORY_AUDIENCE).from(USERS).where(USERS.ID.eq(owner)).fetchOne(USERS.STORY_AUDIENCE));
    }

    /** {@code sees_story} for many owners at once: one query for the connections, one for the choices. */
    public static Set<UUID> seesStoryOf(DSLContext ctx, UUID viewer, Collection<UUID> owners) {
        Set<UUID> seen = new HashSet<>();
        if (owners.isEmpty()) return seen;
        Set<UUID> mine = connectionsOf(ctx, viewer);
        for (UUID owner : owners) if (owner.equals(viewer) || mine.contains(owner)) seen.add(owner);
        seen.addAll(ctx.select(USERS.ID).from(USERS).where(USERS.ID.in(owners)).and(USERS.STORY_AUDIENCE.eq("everyone")).fetch(USERS.ID));
        return seen;
    }

    /** Whether two people may write to each other, and why ({@code domain.can_message}). */
    public record CanMessage(boolean allowed, @Nullable String why) {
    }

    public CanMessage canMessage(DSLContext ctx, UUID a, UUID b) {
        if (a.equals(b) || blockedEither(ctx, a, b)) return new CanMessage(false, "blocked");
        if (connected(ctx, a, b)) return new CanMessage(true, null);
        if (disconnected(ctx, a, b)) return new CanMessage(false, "disconnected");
        return near(a, List.of(b)).getOrDefault(b, false) ? new CanMessage(true, "nearby") : new CanMessage(false, "away");
    }

    /**
     * Who is around the viewer now, from the presence, in one call; 200 ms at most, then nobody
     * (§5: better to refuse a message than to let it pass).
     */
    public Map<UUID, Boolean> near(UUID viewer, List<UUID> others) {
        if (others.isEmpty()) return Map.of();
        try {
            return presence.near(viewer, others).get(200, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Map.of();
        } catch (Exception error) {
            return Map.of();
        }
    }
}
