// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

/**
 * One socket of one gateway. {@code gateway} names the machine (one on a single machine);
 * {@code sequence} is unique there.
 */
public record SocketId(int gateway, long sequence) {
}
