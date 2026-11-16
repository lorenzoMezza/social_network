// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.gateway;

import java.time.InstantSource;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import masterkey.bus.Bus;
import masterkey.core.ApiError;
import masterkey.presence.Presence;
import org.eclipse.jetty.server.Handler;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.websocket.api.StatusCode;
import org.eclipse.jetty.websocket.server.WebSocketUpgradeHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The gateway of this machine: {@code /v1/ws} on the same port as the REST (in front of
 * Spring when the api role runs here, on a bare Jetty when not), the sockets' timers, the
 * check of the tokens, and the frames from the bus for the users connected here.
 */
public final class Gateway implements AutoCloseable {

    private static final Logger log = LoggerFactory.getLogger(Gateway.class);
    public static final String PATH = "/v1/ws";

    final GatewayConfig config;
    final Sockets sockets;
    final Presence presence;
    final InstantSource clock;
    private final Authenticator authenticator;
    final ScheduledExecutorService timers;
    private final ExecutorService verifier = Executors.newVirtualThreadPerTaskExecutor();
    private final AtomicLong sequence = new AtomicLong();
    private final Bus.Subscription subscription;

    // Counters for the metrics
    final AtomicLong opened = new AtomicLong();
    final AtomicLong closed = new AtomicLong();
    final AtomicLong refused = new AtomicLong();
    final AtomicLong floods = new AtomicLong();
    final AtomicLong slowPhones = new AtomicLong();

    public Gateway(GatewayConfig config, Sockets sockets, Presence presence, Authenticator authenticator, Bus bus, InstantSource clock) {
        this.config = config;
        this.sockets = sockets;
        this.presence = presence;
        this.authenticator = authenticator;
        this.clock = clock;
        ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(1,
                Thread.ofPlatform().name("gateway-timers").daemon().factory());
        // Thousands of sockets come and go: a cancelled timer must not stay in the queue
        scheduler.setRemoveOnCancelPolicy(true);
        this.timers = scheduler;
        this.subscription = bus.subscribe("u.", sockets::fromBus);
    }

    /**
     * The handler to put in front of {@code rest}: upgrades {@code /v1/ws} and hands
     * everything else on. No permessage-deflate (§4.10): Jetty would accept it whenever a
     * phone offers it, and every compressed socket holds more native memory.
     */
    public Handler wrap(Server server, Handler rest) {
        WebSocketUpgradeHandler upgrade = WebSocketUpgradeHandler.from(server, container -> {
            container.setMaxTextMessageSize(config.maxFrameBytes());
            container.setMaxBinaryMessageSize(config.maxFrameBytes());
            container.setIdleTimeout(config.idleTimeout());
            container.setMaxOutgoingFrames(config.maxOutgoingFrames());
            container.addMapping(PATH, (request, response, callback) -> {
                response.setExtensions(List.of());
                return newSocket();
            });
        });
        upgrade.setHandler(rest);
        return upgrade;
    }

    PhoneSocket newSocket() {
        return new PhoneSocket(this, new masterkey.presence.SocketId(config.gateway(), sequence.incrementAndGet()));
    }

    void authenticate(PhoneSocket socket, String token) {
        verifier.execute(() -> {
            Authenticator.Identity identity;
            try {
                identity = authenticator.authenticate(token);
            } catch (ApiError error) {
                refused.incrementAndGet();
                socket.refused(PhoneSocket.UNAUTHORIZED, "unauthorized");
                return;
            } catch (RuntimeException error) {
                // The database or Logto down: not the token's fault, the app retries after a pause
                log.error("gateway: checking a token failed", error);
                socket.refused(StatusCode.SERVER_ERROR, "try again later");
                return;
            }
            socket.authenticated(identity);
        });
    }

    public int sockets() {
        return sockets.count();
    }

    public long opened() {
        return opened.get();
    }

    public long refused() {
        return refused.get();
    }

    public long floods() {
        return floods.get();
    }

    public long slowPhones() {
        return slowPhones.get();
    }

    /**
     * Stops taking frames from the bus and closes the sockets a few at a time over
     * {@code config.drain()}: all together they would all come back together.
     */
    @Override
    public void close() {
        subscription.close();
        List<PhoneSocket> open = sockets.all();
        long spread = config.drain().toMillis();
        for (int i = 0; i < open.size(); i++) {
            PhoneSocket socket = open.get(i);
            long at = open.size() <= 1 ? 0 : spread * i / (open.size() - 1);
            ScheduledFuture<?> _ = timers.schedule(
                    () -> sockets.queueClose(socket, StatusCode.SHUTDOWN, "server restarting"), at, TimeUnit.MILLISECONDS);
        }
        timers.shutdown();
        try {
            if (!timers.awaitTermination(spread + 2000, TimeUnit.MILLISECONDS)) timers.shutdownNow();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
        verifier.close();
    }
}
