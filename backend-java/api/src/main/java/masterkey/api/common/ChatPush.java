// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.common;

import java.util.Collection;
import java.util.UUID;
import org.jooq.DSLContext;

/**
 * A chat appeared or changed for these people: each gets the {@code chat} frame with the chat as
 * they see it ({@code domain.push_chat}). Made by the chats; events and people only ask for it.
 */
public interface ChatPush {

    void push(DSLContext ctx, UUID chat, Collection<UUID> users);

    /** The ids of the members of a chat, as push needs them. */
    Collection<UUID> members(DSLContext ctx, UUID chat);
}
