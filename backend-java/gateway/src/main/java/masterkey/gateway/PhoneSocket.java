// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.gateway;

import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import masterkey.core.ApiError;
import masterkey.presence.SocketId;
import org.eclipse.jetty.websocket.api.Callback;
import org.eclipse.jetty.websocket.api.Session;
import org.eclipse.jetty.websocket.api.StatusCode;
import org.jspecify.annotations.Nullable;

/**
 * One phone's socket (API.md, WebSocket). Its first frame is {@code auth} within 5 s, else
 * 4001; the token is checked on a virtual thread; then {@code ready}, and the frames go to
 * the presence. Jetty calls these methods one at a time and none of them blocks.
 *
 * <p>Public, or Jetty answers 500 to the upgrade (JAVA-BACKEND.md §5).
 */
public final class PhoneSocket extends Session.Listener.AbstractAutoDemanding {

    static final int UNAUTHORIZED = 4001;
    private static final int MAX_EARLY_FRAMES = 32;
    private static final String PONG = "{\"type\":\"pong\"}";
    private static final String INVALID = "{\"type\":\"error\",\"ref\":null,\"code\":\"bad_request\",\"message\":\"invalid frame\"}";

    private enum State { WAITING, AUTHENTICATING, READY, CLOSED }

    private final Gateway gateway;
    private final SocketId id;
    private State state = State.WAITING;
    private @Nullable UUID user;
    private List<String> early = new ArrayList<>();
    private double budget;
    private long budgetAt;
    private @Nullable ScheduledFuture<?> authTimer;
    private @Nullable ScheduledFuture<?> expiry;
    private @Nullable ScheduledFuture<?> pinger;
    private final AtomicBoolean writeFailed = new AtomicBoolean();

    PhoneSocket(Gateway gateway, SocketId id) {
        this.gateway = gateway;
        this.id = id;
        this.budget = gateway.config.frameBurst();
        this.budgetAt = System.nanoTime();
    }

    SocketId id() {
        return id;
    }

    @Override
    public void onWebSocketOpen(Session session) {
        super.onWebSocketOpen(session);
        authTimer = gateway.timers.schedule(() -> {
            synchronized (this) {
                if (state != State.WAITING && state != State.AUTHENTICATING) return;
            }
            closeNow(UNAUTHORIZED, "unauthorized");
        }, gateway.config.authTimeout().toMillis(), TimeUnit.MILLISECONDS);
    }

    @Override
    public void onWebSocketText(String text) {
        synchronized (this) {
            switch (state) {
                case WAITING -> {
                    Frames.Auth auth = Frames.auth(text);
                    if (auth == null) {
                        closeNow(UNAUTHORIZED, "unauthorized");
                        return;
                    }
                    state = State.AUTHENTICATING;
                    gateway.authenticate(this, auth.token());
                }
                case AUTHENTICATING -> {
                    // The app waits for ready, but a frame or two may come before it
                    if (early.size() >= MAX_EARLY_FRAMES) closeNow(StatusCode.POLICY_VIOLATION, "too many frames");
                    else early.add(text);
                }
                case READY -> handle(text);
                case CLOSED -> {
                }
            }
        }
    }

    @Override
    public void onWebSocketBinary(ByteBuffer payload, Callback callback) {
        callback.succeed();
        synchronized (this) {
            switch (state) {
                // Text frames only: React Native hands binary frames over as blobs
                case WAITING, AUTHENTICATING -> closeNow(UNAUTHORIZED, "unauthorized");
                case READY -> {
                    if (allow()) gateway.sockets.queue(this, INVALID);
                }
                case CLOSED -> {
                }
            }
        }
    }

    @Override
    public void onWebSocketClose(int statusCode, String reason, Callback callback) {
        ended();
        callback.succeed();
    }

    @Override
    public void onWebSocketError(Throwable cause) {
        ended();
    }

    // --- after the token ---

    /** On the virtual thread that checked the token. */
    void authenticated(Authenticator.Identity identity) {
        synchronized (this) {
            if (state != State.AUTHENTICATING) return;
            state = State.READY;
            user = identity.user();
            cancel(authTimer);
            gateway.sockets.added(this, identity.user());
            gateway.presence.socketOpened(identity.user(), id);
            gateway.sockets.queue(this, "{\"type\":\"ready\",\"userId\":\"" + masterkey.core.Ids.publicId("usr", identity.user()) + "\"}");
            // The token runs out: the app reconnects at once with a fresh one
            long left = Math.max(1000, Duration.between(gateway.clock.instant(), identity.expires()).toMillis());
            expiry = gateway.timers.schedule(() -> closeNow(UNAUTHORIZED, "token expired"), left, TimeUnit.MILLISECONDS);
            long every = gateway.config.ping().toMillis();
            pinger = gateway.timers.scheduleAtFixedRate(this::ping, every, every, TimeUnit.MILLISECONDS);
            List<String> waiting = early;
            early = List.of();
            for (String text : waiting) handle(text);
        }
        gateway.opened.incrementAndGet();
    }

    void refused(int code, String reason) {
        synchronized (this) {
            if (state != State.AUTHENTICATING) return;
        }
        closeNow(code, reason);
    }

    /** Under the lock: a frame after {@code ready}. */
    private void handle(String text) {
        UUID me = user;
        if (me == null) return;
        if (!allow()) {
            // A client flooding the server: a well-behaved app never gets here
            gateway.floods.incrementAndGet();
            closeNow(StatusCode.POLICY_VIOLATION, "too many frames");
            return;
        }
        Frames.Read read;
        try {
            read = Frames.read(text);
        } catch (Frames.Invalid invalid) {
            gateway.sockets.queue(this, error(invalid.ref, invalid.error));
            return;
        }
        switch (read) {
            case Frames.Ping ignored -> gateway.sockets.queue(this, PONG);
            case Frames.ForPresence frame -> gateway.presence.frame(me, id, frame.frame());
            case Frames.Auth ignored -> gateway.sockets.queue(this, INVALID);
        }
    }

    /** 10 frames a second on average, bursts of 30 (an app sends about one a second). */
    private boolean allow() {
        long now = System.nanoTime();
        budget = Math.min(gateway.config.frameBurst(), budget + (now - budgetAt) / 1e9 * gateway.config.frameRate());
        budgetAt = now;
        if (budget < 1) return false;
        budget -= 1;
        return true;
    }

    private static String error(@Nullable String ref, ApiError error) {
        String message = error.getMessage();
        return "{\"type\":\"error\",\"ref\":" + (ref == null ? "null" : ref) + ",\"code\":" + masterkey.core.Json.text(error.code())
                + ",\"message\":" + masterkey.core.Json.text(message == null ? error.code() : message) + "}";
    }

    // --- writing: only the writer thread of this socket calls these ---

    void write(String text) {
        Session session = getSession();
        if (session == null || !session.isOpen()) return;
        session.sendText(text, Callback.from(() -> { }, this::writeFailed));
    }

    /**
     * A phone that does not read: past 500 frames waiting every write fails. Reacting to the
     * first is enough; the close may not get through a full connection, then it is cut.
     */
    private void writeFailed(Throwable cause) {
        if (!writeFailed.compareAndSet(false, true)) return;
        gateway.slowPhones.incrementAndGet();
        closeNow(StatusCode.TRY_AGAIN_LATER, "try again later");
    }

    void closeNow(int code, String reason) {
        Session session = getSession();
        if (session == null) return;
        if (!session.isOpen()) return;
        session.close(code, reason, Callback.from(() -> { }, failure -> session.disconnect()));
    }

    void disconnect() {
        Session session = getSession();
        if (session != null) session.disconnect();
    }

    private void ping() {
        Session session = getSession();
        if (session != null && session.isOpen()) session.sendPing(ByteBuffer.allocate(0), Callback.NOOP);
    }

    private void ended() {
        UUID me;
        synchronized (this) {
            if (state == State.CLOSED) return;
            me = state == State.READY ? user : null;
            state = State.CLOSED;
            early = List.of();
        }
        cancel(authTimer);
        cancel(expiry);
        cancel(pinger);
        if (me != null) {
            gateway.sockets.removed(this, me);
            gateway.presence.socketClosed(me, id);
            gateway.closed.incrementAndGet();
        }
    }

    private static void cancel(@Nullable ScheduledFuture<?> timer) {
        if (timer != null) timer.cancel(false);
    }

    @Override
    public String toString() {
        return "PhoneSocket[" + id + "]";
    }
}
