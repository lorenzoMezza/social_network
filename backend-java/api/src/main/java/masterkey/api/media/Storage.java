// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import java.time.Instant;
import java.util.Collection;
import java.util.Map;

/**
 * Where files are: the originals in a private place, the files made again in a public one
 * served by the CDN (R2 in production, a folder in development). Never called with a database
 * connection in hand.
 */
public interface Storage {

    /** The signed address the phone sends the original to, and the headers the signature needs. */
    Ticket presign(String key, String mimeType, long size, Instant expires);

    /** Removes files that nothing shows any more (and asks the CDN to forget them). */
    void delete(Collection<String> keys);

    record Ticket(String url, Map<String, String> headers) {
        @Override
        public String toString() {
            return "Ticket[…]";
        }
    }
}
