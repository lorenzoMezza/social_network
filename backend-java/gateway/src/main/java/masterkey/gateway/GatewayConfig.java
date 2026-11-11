// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.gateway;

import java.time.Duration;

/**
 * The limits of a socket (API.md, WebSocket; JAVA-BACKEND.md §4.10). {@code gateway}: the
 * number of this machine among the gateways (one on a single machine).
 */
public record GatewayConfig(
        int gateway,
        Duration authTimeout,
        int maxFrameBytes,
        double frameRate,
        int frameBurst,
        int maxOutgoingFrames,
        Duration ping,
        Duration idleTimeout,
        int writers,
        Duration drain) {

    public static GatewayConfig defaults(int gateway) {
        return new GatewayConfig(gateway, Duration.ofSeconds(5), 64 * 1024, 10, 30, 500,
                Duration.ofSeconds(25), Duration.ofSeconds(90), Math.max(2, Runtime.getRuntime().availableProcessors() / 2),
                Duration.ofSeconds(45));
    }

    public GatewayConfig withDrain(Duration value) {
        return new GatewayConfig(gateway, authTimeout, maxFrameBytes, frameRate, frameBurst, maxOutgoingFrames, ping,
                idleTimeout, writers, value);
    }

    public GatewayConfig withAuthTimeout(Duration value) {
        return new GatewayConfig(gateway, value, maxFrameBytes, frameRate, frameBurst, maxOutgoingFrames, ping,
                idleTimeout, writers, drain);
    }
}
