// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.jobs;

import com.github.kagkarlsson.scheduler.Scheduler;
import com.github.kagkarlsson.scheduler.SchedulerClient;
import com.github.kagkarlsson.scheduler.task.FailureHandler;
import com.github.kagkarlsson.scheduler.task.TaskDescriptor;
import com.github.kagkarlsson.scheduler.task.helper.OneTimeTask;
import com.github.kagkarlsson.scheduler.task.helper.RecurringTask;
import com.github.kagkarlsson.scheduler.task.helper.Tasks;
import com.github.kagkarlsson.scheduler.task.schedule.FixedDelay;
import com.github.kagkarlsson.scheduler.task.schedule.Schedules;
import java.time.Duration;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import javax.sql.DataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The tasks of db-scheduler and how they start (§8, Lavori asincroni). The machines with the
 * worker role run them; the others only write jobs ({@link #client}). The data source is the
 * transaction-aware one of {@code Database}: a job written inside a transaction is part of it.
 */
public final class Jobs {

    private static final Logger log = LoggerFactory.getLogger(Jobs.class);

    /** The data of files.delete. */
    public record Files(List<String> keys) {
        public Files {
            keys = List.copyOf(keys);
        }
    }

    /** The data of account.erase: the account gone, and the chats that went with it. */
    public record Erase(UUID user, List<UUID> chats) {
        public Erase {
            chats = List.copyOf(chats);
        }
    }

    /** The data of identity.delete: the account's subject at Logto. */
    public record Identity(String sub) {
        @Override
        public String toString() {
            return "Identity[…]";
        }
    }

    /** The data of push.notify and push.chat: the notification, the chat. */
    public record Target(UUID id) {
    }

    /** Alike notifications within it become one push; the phone may come online meanwhile. */
    static final Duration NOTIFICATION_DELAY = Duration.ofSeconds(5);

    static final TaskDescriptor<Target> PUSH_NOTIFICATION = TaskDescriptor.of("push.notify", Target.class);
    static final TaskDescriptor<Target> PUSH_CHAT = TaskDescriptor.of("push.chat", Target.class);
    static final TaskDescriptor<Files> FILES_DELETE = TaskDescriptor.of("files.delete", Files.class);
    static final TaskDescriptor<Erase> ACCOUNT_ERASE = TaskDescriptor.of("account.erase", Erase.class);
    static final TaskDescriptor<Identity> IDENTITY_DELETE = TaskDescriptor.of("identity.delete", Identity.class);

    private Jobs() {
    }

    /** What writes jobs: every machine. */
    public static SchedulerClient client(DataSource transactional) {
        return SchedulerClient.Builder.create(transactional).serializer(new JsonSerializer()).build();
    }

    static List<RecurringTask<Void>> recurring(Work work) {
        return List.of(
                Tasks.recurring("cleanup.sweep", FixedDelay.ofMinutes(1)).execute((instance, context) -> work.cleanup()),
                Tasks.recurring("promotion.charge", FixedDelay.ofMinutes(1)).execute((instance, context) -> work.charge()),
                Tasks.recurring("event.remind", FixedDelay.ofMinutes(1)).execute((instance, context) -> work.remind()),
                Tasks.recurring("chat.close", FixedDelay.ofMinutes(1)).execute((instance, context) -> work.closeChats()),
                // At night in Europe, when the database has least to do
                Tasks.recurring("retention.sweep", Schedules.daily(ZoneOffset.UTC, LocalTime.of(2, 30))).execute((instance, context) -> work.retention()));
    }

    static OneTimeTask<Files> filesDelete(Work work) {
        // A storage away for a while: tried again, waiting longer each time (1 minute, then up to 19 hours: about two days in all)
        return Tasks.oneTime(FILES_DELETE)
                .onFailure(FailureHandler.<Files>maxRetries(16).withBackoff(Duration.ofMinutes(1), 1.6)
                        .thenRemove(failed -> log.error("files.delete: files left in the storage after 16 tries")))
                .execute((instance, context) -> work.deleteFiles(instance.getData().keys()));
    }

    static OneTimeTask<Erase> accountErase(Work work) {
        return Tasks.oneTime(ACCOUNT_ERASE)
                .onFailure(FailureHandler.<Erase>maxRetries(30).withBackoff(Duration.ofMinutes(1), 1.5)
                        .thenRemove(failed -> log.error("account.erase: messages of a deleted account left after 30 tries")))
                .execute((instance, context) -> work.eraseMessages(instance.getData().user(), instance.getData().chats()));
    }

    static OneTimeTask<Identity> identityDelete(Work work) {
        // Logto away for a while: tried again for about three days
        return Tasks.oneTime(IDENTITY_DELETE)
                .onFailure(FailureHandler.<Identity>maxRetries(20).withBackoff(Duration.ofMinutes(1), 1.7)
                        .thenRemove(failed -> log.error("identity.delete: an identity left at Logto after 20 tries")))
                .execute((instance, context) -> work.deleteIdentity(instance.getData().sub()));
    }

    static OneTimeTask<Target> push(TaskDescriptor<Target> descriptor, java.util.function.Consumer<UUID> body) {
        // A push an hour late is no longer news: a few tries, then nothing
        return Tasks.oneTime(descriptor)
                .onFailure(FailureHandler.<Target>maxRetries(5).withBackoff(Duration.ofMinutes(1), 2.0).thenRemove())
                .execute((instance, context) -> body.accept(instance.getData().id()));
    }

    /** The worker: polls every second, so that a job just written starts at once. */
    public static Scheduler worker(DataSource transactional, Work work, masterkey.jobs.push.Pushes pushes, int threads) {
        Scheduler scheduler = Scheduler.create(transactional, List.of(filesDelete(work), accountErase(work), identityDelete(work),
                        push(PUSH_NOTIFICATION, pushes::notification), push(PUSH_CHAT, pushes::chat)))
                .startTasks(recurring(work))
                .serializer(new JsonSerializer())
                .pollingInterval(Duration.ofSeconds(1))
                .pollUsingLockAndFetch(0.5, 1.0)
                .threads(threads)
                .enableImmediateExecution()
                .shutdownMaxWait(Duration.ofSeconds(20))
                .build();
        log.info("jobs: worker with {} threads", threads);
        return scheduler;
    }
}
