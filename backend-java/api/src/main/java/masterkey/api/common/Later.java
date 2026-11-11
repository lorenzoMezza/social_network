// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.common;

import java.util.List;
import java.util.UUID;

/**
 * Work that must happen even if the machine stops right after the change that asks for it
 * (§6): written in the caller's transaction, it exists only if the change is saved, and it is
 * done by a worker, again until it succeeds. db-scheduler in production.
 */
public interface Later {

    /** Files nothing shows any more: deleted from the storage once the transaction commits, whatever happens. */
    void deleteFiles(List<String> keys);

    /**
     * What remains of a deleted account in the chats that stay (DELETE /me), a batch at a time:
     * its messages emptied (text, poll, author), the votes and pins on them; and every message of
     * {@code chats}, chats that went with it (its events').
     */
    void eraseMessages(UUID user, List<UUID> chats);

    /** The account's identity at Logto (C14 of the retention), deleted through its Management API. */
    void deleteIdentity(String sub);

    /**
     * A push for a notification, a few seconds later (one more alike within them joins it), if
     * its person is not online then. Asked again for a notification already waiting: nothing more.
     */
    void pushNotification(UUID notification);

    /**
     * A push for the new messages of a chat to its members not online, after {@code after}: one
     * row a chat whatever the messages meanwhile (§18, Push), each member told once per message.
     */
    void pushChat(UUID chat, java.time.Duration after);
}
