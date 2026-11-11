// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

/**
 * The gateway (JAVA-BACKEND.md §4.10, §5 Come scrivere gateway): the phones' sockets, their
 * authentication, their limits, and the way frames reach them. Jetty calls the callbacks of
 * a socket; they never block: they read the frame, check it, hand it on and return.
 */
@NullMarked
package masterkey.gateway;

import org.jspecify.annotations.NullMarked;
