// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static masterkey.store.db.Tables.BLOCKS;
import static masterkey.store.db.Tables.CONNECTIONS;
import static masterkey.store.db.Tables.USERS;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import masterkey.api.Urls;
import masterkey.api.people.Views;
import masterkey.core.ApiError;
import masterkey.core.Json;
import masterkey.presence.Directory;
import masterkey.store.Database;
import masterkey.store.db.tables.records.UsersRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * What the presence asks of the database, on virtual threads: never on the presence thread.
 * Its answers go back to it as messages (Engine).
 */
final class DbDirectory implements Directory, AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(DbDirectory.class);

    private final Database db;
    private final Urls urls;
    private final ExecutorService threads = Executors.newVirtualThreadPerTaskExecutor();
    private volatile Invited invited = (target, actor) -> { };

    /** "Connect" invitations kept among the notifications: set by the notifications once they run. */
    interface Invited {
        void invited(UUID target, UUID actor);
    }

    DbDirectory(Database db, Urls urls) {
        this.db = db;
        this.urls = urls;
    }

    void onInvited(Invited handler) {
        this.invited = handler;
    }

    @Override
    public CompletableFuture<Relations> relations(UUID user) {
        return CompletableFuture.supplyAsync(() -> db.read(ctx -> {
            Set<UUID> connections = new HashSet<>(ctx.select(CONNECTIONS.OTHER_ID).from(CONNECTIONS)
                    .where(CONNECTIONS.USER_ID.eq(user)).fetch(CONNECTIONS.OTHER_ID));
            Set<UUID> blocked = new HashSet<>(ctx.select(BLOCKS.BLOCKED).from(BLOCKS).where(BLOCKS.BLOCKER.eq(user)).fetch(BLOCKS.BLOCKED));
            blocked.addAll(ctx.select(BLOCKS.BLOCKER).from(BLOCKS).where(BLOCKS.BLOCKED.eq(user)).fetch(BLOCKS.BLOCKER));
            return new Relations(connections, blocked);
        }), threads);
    }

    @Override
    public CompletableFuture<Summary> summary(UUID user) {
        return CompletableFuture.supplyAsync(() -> db.read(ctx -> {
            UsersRecord row = ctx.selectFrom(USERS).where(USERS.ID.eq(user)).fetchOne();
            if (row == null) throw ApiError.notFound("no such person");
            return new Summary(Json.text(Views.summary(row, urls)), row.getAvatarVersion());
        }), threads);
    }

    @Override
    public void connectInvited(UUID target, UUID actor) {
        threads.execute(() -> {
            try {
                invited.invited(target, actor);
            } catch (RuntimeException error) {
                log.warn("directory: the invitation's notification failed: {}", error.getClass().getSimpleName());
            }
        });
    }

    @Override
    public void close() {
        threads.close();
    }
}
