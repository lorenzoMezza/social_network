// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.common;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import masterkey.bus.Bus;
import masterkey.core.Json;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Frames for the users' sockets (API.md, Server → client), sent only once what they tell is
 * saved (JAVA-BACKEND.md §8, Effetti a catena): inside a transaction they wait for its commit,
 * and a rollback drops them; outside one they go at once. Each frame is made for its
 * receiver: what goes to many is the same object written once per receiver.
 */
public final class Outbox {

    private final Bus bus;

    public Outbox(Bus bus) {
        this.bus = bus;
    }

    public void send(UUID user, Object frame) {
        byte[] bytes = Json.bytes(frame);
        later(() -> bus.publish(Bus.user(user), bytes));
    }

    public void send(Iterable<UUID> users, Object frame) {
        byte[] bytes = Json.bytes(frame);
        List<UUID> all = new ArrayList<>();
        users.forEach(all::add);
        later(() -> {
            for (UUID user : all) bus.publish(Bus.user(user), bytes);
        });
    }

    /** Anything else that must happen after the commit (news to the presence, a job). */
    public void afterCommit(Runnable work) {
        later(work);
    }

    private static void later(Runnable work) {
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    work.run();
                }
            });
        } else {
            work.run();
        }
    }
}
