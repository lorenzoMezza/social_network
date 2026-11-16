// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

/**
 * How frames leave the presence: handed to the gateway, which writes them on its own threads
 * (JAVA-BACKEND.md §5: the presence never calls {@code sendText}: even without blocking it
 * writes on the caller's thread, and thousands of sockets would stop the round). Neither
 * method may block.
 */
public interface Delivery {

    void send(SocketId socket, String frame);

    void close(SocketId socket, int code, String reason);
}
