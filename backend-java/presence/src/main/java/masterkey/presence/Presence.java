// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import masterkey.core.Point;

/**
 * What the rest of the server may ask of the presence (JAVA-BACKEND.md §5, Come parlano i
 * ruoli). Nobody reads inside it: on one machine each call is a message to its thread, with
 * more machines the same calls go over NATS. No position goes to a log or a lasting queue.
 *
 * <p>The calls with an answer are answered by the presence thread: callers wait with
 * {@code orTimeout(200 ms)} and follow the rule of the table "Se la presenza non risponde".
 */
public interface Presence {

    // From the gateway: they never block

    /** A socket of this user authenticated: its frames follow. */
    void socketOpened(UUID user, SocketId socket);

    void socketClosed(UUID user, SocketId socket);

    /** A frame of the socket, already read and checked by the gateway. */
    void frame(UUID user, SocketId socket, ClientFrame frame);

    // From api and worker, answered by the presence thread

    /** Whether each one is within the range of the viewer now (writing, waving, inviting). */
    CompletableFuture<Map<UUID, Boolean>> near(UUID viewer, List<UUID> others);

    /** Where the user's phone last put them on the map (a flash event, connecting in person). */
    CompletableFuture<Optional<Point>> position(UUID user);

    /** Whether the user could be at this point now (position guard); remembers it when so. */
    CompletableFuture<Boolean> plausible(UUID user, Point point);

    /**
     * A search for the events around ({@code GET /events}): the point is checked like a
     * position and kept, rounded, so new and changed events reach the user live.
     */
    CompletableFuture<Boolean> searchedEvents(UUID user, Point point, int rangeMetres);

    /** Who is online and has a place within {@code reachMetres} among the events they look at. */
    CompletableFuture<List<UUID>> eventAudience(Point place, int reachMetres);

    /** Which of these users have a socket open now. */
    CompletableFuture<List<UUID>> online(List<UUID> users);

    // News: repeated by the sender until it is sure they arrived (a block must not get lost)

    /** A block, an unblock, a connection made or ended between the two. */
    void relationChanged(UUID a, UUID b);

    /** A new name, picture or avatar: the {@code user} goes again to who has them on the map. */
    void userChanged(UUID user);

    /** The account is gone: off the map, out of the indexes and of the position guard. */
    void accountErased(UUID user);
}
