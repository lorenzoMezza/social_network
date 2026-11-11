// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.events;

import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.EVENT_ATTENDEES;
import static masterkey.store.db.Tables.EVENT_SAVED;
import static masterkey.store.db.Tables.PROMOTIONS;

import java.time.InstantSource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import masterkey.api.common.Outbox;
import masterkey.api.common.Relations;
import masterkey.core.Point;
import masterkey.presence.Presence;
import masterkey.store.Database;
import masterkey.store.db.tables.records.EventsRecord;
import masterkey.api.money.Promotions;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * An event appeared or changed ({@code domain.notify_event}): its organizer, who joined or saved
 * it, and everyone online whose events include its place (their last search, else 2 km around
 * them on the map: the presence knows), within its reach (the larger of now and before, so a
 * smaller reach takes it off the farther maps), unless blocked either way. Each gets the event
 * made for them. After the commit, off the request's thread: the network first, then the reads.
 */
public final class EventNotifier implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(EventNotifier.class);
    private static final int MAX_RECIPIENTS = 20_000;

    private final Database db;
    private final Presence presence;
    private final EventViews views;
    private final Outbox outbox;
    private final InstantSource clock;
    private final ExecutorService threads = Executors.newVirtualThreadPerTaskExecutor();

    public EventNotifier(Database db, Presence presence, EventViews views, Outbox outbox, InstantSource clock) {
        this.db = db;
        this.presence = presence;
        this.views = views;
        this.outbox = outbox;
        this.clock = clock;
    }

    /** Once the transaction that changed the event commits. */
    public void changed(UUID event, int alsoWithin) {
        outbox.afterCommit(() -> threads.execute(() -> {
            try {
                send(event, alsoWithin);
            } catch (RuntimeException error) {
                log.warn("events: telling an event failed: {}", error.getClass().getSimpleName());
            }
        }));
    }

    /**
     * An event erased with its organizer's account: who has it on their lists or map (within the
     * reach it had) asks for them again, once the transaction commits. {@code involved}: read
     * before the rows went (its organizer, who joined or saved it).
     */
    public void gone(EventsRecord event, int reach, Set<UUID> involved) {
        Point place = new Point(event.getLatitude(), event.getLongitude());
        Set<UUID> known = Set.copyOf(involved);
        outbox.afterCommit(() -> threads.execute(() -> {
            try {
                Set<UUID> recipients = new LinkedHashSet<>(ask(() -> presence.online(new ArrayList<>(known)).get(500, TimeUnit.MILLISECONDS)));
                recipients.addAll(ask(() -> presence.eventAudience(place, reach).get(500, TimeUnit.MILLISECONDS)));
                outbox.send(recipients, Map.of("type", "events.stale"));
            } catch (RuntimeException error) {
                log.warn("events: telling an event gone failed: {}", error.getClass().getSimpleName());
            }
        }));
    }

    /** What these people see changed (a block, an organizer gone): their phones ask for their lists again. */
    public void stale(Set<UUID> users) {
        outbox.send(users, Map.of("type", "events.stale"));
    }

    private void send(UUID id, int alsoWithin) {
        EventsRecord event = db.read(ctx -> ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).fetchOne());
        if (event == null) return;
        int reach = Math.max(db.read(ctx -> Promotions.reachNow(event,
                ctx.selectFrom(PROMOTIONS).where(PROMOTIONS.EVENT_ID.eq(id)).fetchOne(), clock.instant())), alsoWithin);
        Set<UUID> involved = new LinkedHashSet<>();
        involved.add(event.getCreatorId());
        db.read(ctx -> {
            involved.addAll(ctx.select(EVENT_ATTENDEES.USER_ID).from(EVENT_ATTENDEES).where(EVENT_ATTENDEES.EVENT_ID.eq(id)).fetch(EVENT_ATTENDEES.USER_ID));
            involved.addAll(ctx.select(EVENT_SAVED.USER_ID).from(EVENT_SAVED).where(EVENT_SAVED.EVENT_ID.eq(id)).fetch(EVENT_SAVED.USER_ID));
            return null;
        });
        // Without an answer from the presence in time: no frames (the phones reload their lists)
        List<UUID> online = ask(() -> presence.online(new ArrayList<>(involved)).get(500, TimeUnit.MILLISECONDS));
        List<UUID> around = ask(() -> presence.eventAudience(new Point(event.getLatitude(), event.getLongitude()), reach)
                .get(500, TimeUnit.MILLISECONDS));
        Set<UUID> recipients = new LinkedHashSet<>(online);
        recipients.addAll(around);
        if (recipients.size() > MAX_RECIPIENTS) {
            log.warn("events: an event reaches {} people online, the first {} are told", recipients.size(), MAX_RECIPIENTS);
        }
        db.read(ctx -> {
            Set<UUID> blocked = Relations.blockedWith(ctx, event.getCreatorId());
            int sent = 0;
            for (UUID user : recipients) {
                if (sent++ >= MAX_RECIPIENTS) break;
                if (blocked.contains(user)) continue;
                Map<String, Object> frame = new LinkedHashMap<>();
                frame.put("type", "event");
                frame.put("event", views.summary(ctx, user, event, clock.instant()));
                outbox.send(user, frame);
            }
            return null;
        });
    }

    private interface Question<T> {
        T get() throws Exception;
    }

    private static <T> List<T> ask(Question<List<T>> question) {
        try {
            return question.get();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return List.of();
        } catch (Exception error) {
            return List.of();
        }
    }

    @Override
    public void close() {
        threads.close();
    }
}
