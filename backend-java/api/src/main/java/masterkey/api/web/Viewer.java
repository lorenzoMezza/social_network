// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.web;

import java.util.UUID;
import masterkey.core.Ids;

/**
 * Who is asking: the account of the access token, made on its first request. A parameter of
 * this type in a controller means the route needs a signed-in user (401 otherwise).
 */
public record Viewer(UUID id, String sub) {

    public String publicId() {
        return Ids.publicId("usr", id);
    }

    @Override
    public String toString() {
        return "Viewer[" + publicId() + "]";
    }
}
