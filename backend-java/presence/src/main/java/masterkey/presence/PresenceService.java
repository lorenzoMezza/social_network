// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.LockSupport;
import java.util.function.LongSupplier;
import java.util.function.Supplier;
import masterkey.core.Point;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The presence on this machine: one platform thread owns the {@link Engine}, and nobody
 * else touches it (JAVA-BACKEND.md §5, Come scrivere presence). Others only write to it:
 *
 * <ul>
 *   <li>{@code frames}, bounded (about 2 s of traffic), with {@code offer}: when full the
 *       frame is lost and counted, the phone sends another;
 *   <li>{@code control} (sockets, relations, questions), never lost, emptied first.
 * </ul>
 *
 * <p>The thread never blocks: no database, network or file. An exception on one message
 * does not stop the round. A watchdog checks that the round moves on: stopped for 5 s, the
 * process must go and the standby takes over ({@code onStall}).
 */
public final class PresenceService implements Presence, AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(PresenceService.class);
    private static final long SLICE_NANOS = 100_000_000L;
    private static final long STALL_NANOS = 5_000_000_000L;
    private static final int FRAMES_PER_TURN = 4096;
    private static final int REMATCH_CHUNK = 64;

    private final PresenceConfig config;
    private final PresenceClock clock;
    private final Engine engine;
    private final ArrayBlockingQueue<Runnable> frames;
    private final ConcurrentLinkedQueue<Runnable> control = new ConcurrentLinkedQueue<>();
    /** Answers are completed off the presence thread: a caller's stages must never run on it. */
    private final ExecutorService answers = Executors.newVirtualThreadPerTaskExecutor();
    private final Runnable onStall;
    private final Thread thread;
    private final Thread watchdog;
    private volatile boolean running = true;
    private volatile long heartbeat;

    private final AtomicLong droppedFrames = new AtomicLong();
    private final AtomicLong failures = new AtomicLong();
    private volatile int onMap;
    private volatile int people;
    private final AtomicLong lateRounds = new AtomicLong();

    public PresenceService(PresenceConfig config, Directory directory, Delivery delivery, PresenceClock clock, Runnable onStall) {
        this.config = config;
        this.clock = clock;
        this.frames = new ArrayBlockingQueue<>(config.frameQueue);
        this.onStall = onStall;
        this.engine = new Engine(config, directory, delivery, clock, this::control);
        this.thread = Thread.ofPlatform().name("presence").unstarted(this::loop);
        this.watchdog = Thread.ofPlatform().name("presence-watchdog").daemon().unstarted(this::watch);
    }

    public void start() {
        heartbeat = clock.nanos();
        thread.start();
        watchdog.start();
    }

    @Override
    public void close() {
        running = false;
        LockSupport.unpark(thread);
        try {
            thread.join(2000);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        answers.close();
    }

    // --- from the gateway ---

    @Override
    public void socketOpened(UUID user, SocketId socket) {
        control(() -> engine.socketOpened(user, socket));
    }

    @Override
    public void socketClosed(UUID user, SocketId socket) {
        control(() -> engine.socketClosed(user, socket));
    }

    @Override
    public void frame(UUID user, SocketId socket, ClientFrame frame) {
        if (!frames.offer(() -> engine.frame(user, socket, frame))) droppedFrames.incrementAndGet();
    }

    // --- questions ---

    @Override
    public CompletableFuture<Map<UUID, Boolean>> near(UUID viewer, List<UUID> others) {
        List<UUID> copy = List.copyOf(others);
        return ask(() -> engine.near(viewer, copy));
    }

    @Override
    public CompletableFuture<Optional<Point>> position(UUID user) {
        return ask(() -> engine.position(user));
    }

    @Override
    public CompletableFuture<Boolean> plausible(UUID user, Point point) {
        return ask(() -> engine.plausible(user, point));
    }

    @Override
    public CompletableFuture<Boolean> searchedEvents(UUID user, Point point, int rangeMetres) {
        return ask(() -> engine.searchedEvents(user, point, rangeMetres));
    }

    @Override
    public CompletableFuture<List<UUID>> eventAudience(Point place, int reachMetres) {
        return ask(() -> engine.eventAudience(place, reachMetres));
    }

    @Override
    public CompletableFuture<List<UUID>> online(List<UUID> users) {
        List<UUID> copy = List.copyOf(users);
        return ask(() -> engine.online(copy));
    }

    // --- news ---

    @Override
    public void relationChanged(UUID a, UUID b) {
        control(() -> engine.relationChanged(a, b));
    }

    @Override
    public void userChanged(UUID user) {
        control(() -> engine.userChanged(user));
    }

    @Override
    public void accountErased(UUID user) {
        control(() -> engine.accountErased(user));
    }

    // --- metrics ---

    public long droppedFrames() {
        return droppedFrames.get();
    }

    public long failures() {
        return failures.get();
    }

    public int onMap() {
        return onMap;
    }

    public int people() {
        return people;
    }

    public long lateRounds() {
        return lateRounds.get();
    }

    public int queuedFrames() {
        return frames.size();
    }

    // --- the thread ---

    private <T> CompletableFuture<T> ask(Supplier<T> question) {
        CompletableFuture<T> answer = new CompletableFuture<>();
        control(() -> {
            T value;
            try {
                value = question.get();
            } catch (RuntimeException error) {
                answers.execute(() -> answer.completeExceptionally(error));
                throw error;
            }
            answers.execute(() -> answer.complete(value));
        });
        return answer;
    }

    private void control(Runnable message) {
        control.add(message);
        LockSupport.unpark(thread);
    }

    private void loop() {
        long now = clock.nanos();
        long nextRound = now + config.roundNanos;
        long nextSlice = now + SLICE_NANOS;
        long nextSecond = now + Engine.SECOND;
        long nextSweep = now + 10 * Engine.SECOND;
        long debt = 0;
        List<Runnable> batch = new ArrayList<>(FRAMES_PER_TURN);
        while (running) {
            heartbeat = clock.nanos();
            boolean busy = false;
            Runnable message;
            while ((message = control.poll()) != null) {
                run(message);
                busy = true;
            }
            batch.clear();
            if (frames.drainTo(batch, FRAMES_PER_TURN) > 0) {
                for (Runnable frame : batch) run(frame);
                busy = true;
            }
            long nextTimer = guarded(engine::runTimers, Long.MAX_VALUE);
            now = clock.nanos();
            if (now >= nextRound) {
                run(engine::tick);
                if (now - nextRound > config.roundNanos) {
                    lateRounds.incrementAndGet();
                    nextRound = now;
                }
                nextRound += config.roundNanos;
                onMap = engine.onMapCount();
                people = engine.peopleCount();
                continue;
            }
            if (now >= nextSlice) {
                // Everyone's matching every 5 s: a fiftieth of them every 100 ms
                debt += Math.max(1, (engine.onMapCount() * SLICE_NANOS + config.rematchEveryNanos - 1) / config.rematchEveryNanos);
                nextSlice += SLICE_NANOS;
                if (now - nextSlice > SLICE_NANOS) nextSlice = now + SLICE_NANOS;
            }
            if (now >= nextSecond) {
                run(engine::expire);
                nextSecond = now + Engine.SECOND;
            }
            if (now >= nextSweep) {
                run(engine::sweep);
                nextSweep = now + 10 * Engine.SECOND;
            }
            if (debt > 0) {
                // In small pieces, so that frames do not wait
                int chunk = (int) Math.min(debt, REMATCH_CHUNK);
                long done = guarded(() -> engine.rematchSome(chunk), 0);
                debt = done == 0 ? 0 : debt - chunk;
                continue;
            }
            if (!busy) {
                long wait = Math.min(Math.min(nextRound, nextSlice), nextTimer) - clock.nanos();
                if (wait > 0) LockSupport.parkNanos(Math.min(wait, 1_000_000L));
            }
        }
    }

    private void run(Runnable message) {
        try {
            message.run();
        } catch (RuntimeException error) {
            // Counted and logged without what it was about: never a position in a log
            failures.incrementAndGet();
            log.error("presence: a message failed", error);
        }
    }

    /** {@code work}, or {@code otherwise} when it failed (counted and logged). */
    private long guarded(LongSupplier work, long otherwise) {
        try {
            return work.getAsLong();
        } catch (RuntimeException error) {
            failures.incrementAndGet();
            log.error("presence: the round failed", error);
            return otherwise;
        }
    }

    private void watch() {
        while (running) {
            LockSupport.parkNanos(1_000_000_000L);
            if (running && clock.nanos() - heartbeat > STALL_NANOS) {
                log.error("presence: the round stopped for 5 s, giving up");
                onStall.run();
                return;
            }
        }
    }
}
