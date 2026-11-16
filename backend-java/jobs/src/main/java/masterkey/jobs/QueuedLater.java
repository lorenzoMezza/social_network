// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.jobs;

import com.github.kagkarlsson.scheduler.SchedulerClient;
import java.time.InstantSource;
import java.util.List;
import java.util.UUID;
import masterkey.api.common.Later;
import masterkey.core.Ids;

/**
 * {@link Later} on db-scheduler: the job is a row of {@code scheduled_tasks} written through the
 * transaction-aware data source, so inside {@code Database.tx} it is part of the transaction,
 * and outside it is saved at once. Any machine with the worker role does it.
 */
public final class QueuedLater implements Later {

    /** At most this many files per job: a batch of the storage's delete. */
    static final int FILES_PER_JOB = 500;

    private final SchedulerClient client;
    private final InstantSource clock;

    public QueuedLater(SchedulerClient client, InstantSource clock) {
        this.client = client;
        this.clock = clock;
    }

    @Override
    public void deleteFiles(List<String> keys) {
        for (int from = 0; from < keys.size(); from += FILES_PER_JOB) {
            List<String> part = List.copyOf(keys.subList(from, Math.min(keys.size(), from + FILES_PER_JOB)));
            client.scheduleIfNotExists(Jobs.FILES_DELETE.instance(Ids.next().toString()).data(new Jobs.Files(part)).scheduledTo(clock.instant()));
        }
    }

    @Override
    public void eraseMessages(UUID user, List<UUID> chats) {
        // One per account: written twice (a DELETE /me sent again), it is the same job
        client.scheduleIfNotExists(Jobs.ACCOUNT_ERASE.instance(user.toString()).data(new Jobs.Erase(user, chats)).scheduledTo(clock.instant()));
    }

    @Override
    public void pushNotification(UUID notification) {
        client.scheduleIfNotExists(Jobs.PUSH_NOTIFICATION.instance(notification.toString()).data(new Jobs.Target(notification))
                .scheduledTo(clock.instant().plus(Jobs.NOTIFICATION_DELAY)));
    }

    @Override
    public void pushChat(UUID chat, java.time.Duration after) {
        client.scheduleIfNotExists(Jobs.PUSH_CHAT.instance(chat.toString()).data(new Jobs.Target(chat)).scheduledTo(clock.instant().plus(after)));
    }

    @Override
    public void deleteIdentity(String sub) {
        client.scheduleIfNotExists(Jobs.IDENTITY_DELETE.instance(Ids.next().toString()).data(new Jobs.Identity(sub)).scheduledTo(clock.instant()));
    }
}
