// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import masterkey.core.Ids;
import masterkey.core.Point;
import org.junit.jupiter.api.Test;

/** The real thread: frames in, frames out on time, answers within the 200 ms of the callers. */
class PresenceServiceTest {

    @Test
    void framesGoInAndTheRoundSendsTheChanges() throws Exception {
        Harness.FakeDirectory directory = new Harness.FakeDirectory();
        Map<SocketId, List<String>> out = new ConcurrentHashMap<>();
        Delivery delivery = new Delivery() {
            @Override
            public void send(SocketId socket, String frame) {
                out.computeIfAbsent(socket, k -> new CopyOnWriteArrayList<>()).add(frame);
            }

            @Override
            public void close(SocketId socket, int code, String reason) {
            }
        };
        AtomicBoolean stalled = new AtomicBoolean();
        try (PresenceService presence = new PresenceService(PresenceConfig.of(Harness.KEY, 340), directory, delivery,
                PresenceClock.system(), () -> stalled.set(true))) {
            presence.start();
            UUID a = Ids.random(), b = Ids.random();
            SocketId sa = new SocketId(1, 1), sb = new SocketId(1, 2);
            presence.socketOpened(a, sa);
            presence.socketOpened(b, sb);
            presence.frame(a, sa, new ClientFrame.PresenceUpdate(null, Mode.VISIBLE,
                    new ClientFrame.Position(41.9, 12.5, null, null, null, null)));
            presence.frame(b, sb, new ClientFrame.PresenceUpdate(null, Mode.VISIBLE,
                    new ClientFrame.Position(41.9001, 12.5, null, null, null, null)));
            long until = System.nanoTime() + Duration.ofSeconds(3).toNanos();
            while (System.nanoTime() < until && out.getOrDefault(sa, List.of()).stream().noneMatch(f -> f.contains("presence.delta"))) {
                Thread.sleep(20);
            }
            assertThat(out.get(sa)).anyMatch(f -> f.contains("presence.delta") && f.contains(Ids.publicId("usr", b)));
            assertThat(presence.near(a, List.of(b)).get(200, TimeUnit.MILLISECONDS)).containsEntry(b, true);
            assertThat(presence.position(a).get(200, TimeUnit.MILLISECONDS)).isPresent();
            assertThat(presence.online(List.of(a, Ids.random())).get(200, TimeUnit.MILLISECONDS)).containsExactly(a);
            assertThat(presence.plausible(a, new Point(-33.86, 151.2)).get(200, TimeUnit.MILLISECONDS)).isFalse();
            presence.socketClosed(a, sa);
            assertThat(presence.online(List.of(a)).get(200, TimeUnit.MILLISECONDS)).isEmpty();
            assertThat(presence.failures()).isZero();
            assertThat(presence.droppedFrames()).isZero();
        }
        assertThat(stalled).isFalse();
    }
}
