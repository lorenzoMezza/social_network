// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.jobs.push;

import java.util.Map;

/** One push service (APNs, FCM): one message to one device token, and what came of it. */
public interface PushSender {

    /** What a push says: short, never the text of a message (it passes through Apple's or Google's servers). */
    record Message(String title, String body, Map<String, String> data, String collapse) {
        public Message {
            data = Map.copyOf(data);
        }
    }

    enum Result {
        /** Delivered to the service. */
        SENT,
        /** The token is no longer a phone of this app: it goes. */
        GONE,
        /** The service could not take it now: the job tries again. */
        RETRY,
        /** Refused for good (a message the service will never take): logged, not tried again. */
        FAILED
    }

    Result send(String token, Message message) throws InterruptedException;
}
