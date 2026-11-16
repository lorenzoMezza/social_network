// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.bus;

import java.util.concurrent.CopyOnWriteArrayList;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The bus on one machine: a publish calls the listeners at once, on the publisher's thread.
 * Listeners only hand the message on (the gateway queues it for its writers), so a publish
 * costs microseconds. A failing listener costs that message, never the publisher.
 */
public final class LocalBus implements Bus {

    private static final Logger log = LoggerFactory.getLogger(LocalBus.class);

    private record Entry(String prefix, Listener listener) {
    }

    private final CopyOnWriteArrayList<Entry> entries = new CopyOnWriteArrayList<>();

    @Override
    public void publish(String subject, byte[] payload) {
        for (Entry entry : entries) {
            if (!subject.startsWith(entry.prefix)) continue;
            try {
                entry.listener.message(subject, payload);
            } catch (RuntimeException error) {
                log.error("bus: a listener failed on {}", entry.prefix, error);
            }
        }
    }

    @Override
    public Subscription subscribe(String prefix, Listener listener) {
        Entry entry = new Entry(prefix, listener);
        entries.add(entry);
        return () -> entries.remove(entry);
    }
}
