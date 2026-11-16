// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.gateway;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import masterkey.bus.Bus;
import masterkey.presence.Delivery;
import masterkey.presence.SocketId;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The open sockets of this gateway and the small group of threads that writes to them
 * (JAVA-BACKEND.md §5): the presence and the bus only queue a frame, one writer thread per
 * group of sockets calls {@code sendText}, so the order of each socket's frames holds and
 * nobody else ever writes on a socket. A writer that cannot keep up closes the socket
 * (1013): the phone reconnects and gets a new snapshot, which beats a map gone wrong.
 */
public final class Sockets implements Delivery, AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(Sockets.class);
    private static final int QUEUE = 100_000;

    private final ConcurrentHashMap<SocketId, PhoneSocket> byId = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<UUID, Set<PhoneSocket>> byUser = new ConcurrentHashMap<>();
    private final Writer[] writers;
    final AtomicLong overflows = new AtomicLong();

    private record Job(PhoneSocket socket, @Nullable String text, int code, String reason) {
        @Override
        public String toString() {
            return "Job[" + socket + "]";
        }
    }

    private static final class Writer implements Runnable {
        final ArrayBlockingQueue<Job> queue = new ArrayBlockingQueue<>(QUEUE);
        final Thread thread;
        volatile boolean running = true;

        Writer(int number) {
            thread = Thread.ofPlatform().name("gateway-writer-" + number).daemon().unstarted(this);
        }

        @Override
        public void run() {
            while (running || !queue.isEmpty()) {
                Job job;
                try {
                    job = queue.take();
                } catch (InterruptedException interrupted) {
                    if (!running) return;
                    continue;
                }
                try {
                    if (job.text != null) job.socket.write(job.text);
                    else job.socket.closeNow(job.code, job.reason);
                } catch (RuntimeException error) {
                    log.error("gateway: a write failed", error);
                }
            }
        }
    }

    public Sockets(int writers) {
        this.writers = new Writer[writers];
        for (int i = 0; i < writers; i++) {
            this.writers[i] = new Writer(i);
            this.writers[i].thread.start();
        }
    }

    // --- Delivery, for the presence ---

    @Override
    public void send(SocketId socket, String frame) {
        PhoneSocket phone = byId.get(socket);
        if (phone != null) queue(phone, frame);
    }

    @Override
    public void close(SocketId socket, int code, String reason) {
        PhoneSocket phone = byId.get(socket);
        if (phone != null) queueClose(phone, code, reason);
    }

    // --- the bus: frames from api and worker for a user ---

    /** {@code u.<user>}: to each socket of the user on this gateway. */
    void fromBus(String subject, byte[] payload) {
        UUID user;
        try {
            user = Bus.userOf(subject);
        } catch (IllegalArgumentException error) {
            return;
        }
        Set<PhoneSocket> mine = byUser.get(user);
        if (mine == null) return;
        String frame = new String(payload, StandardCharsets.UTF_8);
        for (PhoneSocket phone : mine) queue(phone, frame);
    }

    // --- the sockets ---

    void added(PhoneSocket socket, UUID user) {
        byId.put(socket.id(), socket);
        byUser.computeIfAbsent(user, key -> ConcurrentHashMap.newKeySet()).add(socket);
    }

    void removed(PhoneSocket socket, UUID user) {
        byId.remove(socket.id(), socket);
        byUser.computeIfPresent(user, (key, set) -> {
            set.remove(socket);
            return set.isEmpty() ? null : set;
        });
    }

    void queue(PhoneSocket socket, String text) {
        if (!writerOf(socket).queue.offer(new Job(socket, text, 0, ""))) {
            overflows.incrementAndGet();
            socket.disconnect();
        }
    }

    void queueClose(PhoneSocket socket, int code, String reason) {
        if (!writerOf(socket).queue.offer(new Job(socket, null, code, reason))) socket.disconnect();
    }

    private Writer writerOf(PhoneSocket socket) {
        return writers[(int) Math.floorMod(socket.id().sequence(), (long) writers.length)];
    }

    public int count() {
        return byId.size();
    }

    public int users() {
        return byUser.size();
    }

    List<PhoneSocket> all() {
        return List.copyOf(byId.values());
    }

    @Override
    public void close() {
        for (Writer writer : writers) {
            writer.running = false;
            writer.thread.interrupt();
        }
    }
}
