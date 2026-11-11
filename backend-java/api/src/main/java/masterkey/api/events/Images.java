// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.events;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.api.Urls;
import masterkey.api.media.Imaging;
import masterkey.api.media.Uploads;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.store.db.tables.records.EventsRecord;
import tools.jackson.databind.JsonNode;

/**
 * An event's pictures as they are going to be, in order, the first its cover ({@code
 * routes/events._new_images}): each one kept ({@code { url }}) or new ({@code { uploadId }},
 * purpose event-cover). Everything is checked before anything is used, and a picture that could
 * not be made leaves no other behind (§19: all claimed in step a; one refused, nothing changes).
 */
public class Images {

    static final int MAX = 6;

    private final Urls urls;
    private final Uploads uploads;

    public Images(Urls urls, Uploads uploads) {
        this.urls = urls;
        this.uploads = uploads;
    }

    /** The keys in order, and the new ones made (to be finished in the event's transaction). */
    public record Plan(List<String> keys, List<Uploads.Claimed> made) {
        List<String> newKeys() {
            List<String> keys = new ArrayList<>();
            for (Uploads.Claimed claimed : made) keys.addAll(claimed.keys());
            return keys;
        }
    }

    public Plan plan(Body body, EventsRecord event, UUID user) {
        JsonNode items = body.raw("images");
        if (items == null || !items.isArray() || items.size() > MAX) throw ApiError.badRequest("images: at most " + MAX);
        Map<String, String> current = new HashMap<>();
        for (String key : event.getImageKeys()) {
            String url = urls.media(key);
            if (url != null) current.put(url, key);
        }
        // Checked first, all of them: a bad item changes nothing
        List<Object> steps = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (JsonNode item : items) {
            if (!item.isObject() || item.size() != 1) throw ApiError.badRequest("images: each one { url } or { uploadId }");
            JsonNode url = item.get("url");
            JsonNode upload = item.get("uploadId");
            if (url != null && url.isString()) {
                String key = current.get(url.stringValue());
                if (key == null) throw ApiError.badRequest("images: a url that is not one of the event's pictures");
                if (!seen.add(key)) throw ApiError.badRequest("images: each picture once");
                steps.add(key);
            } else if (upload != null && upload.isString()) {
                if (!seen.add("upload:" + upload.stringValue())) throw ApiError.badRequest("images: each picture once");
                steps.add(new UploadStep(upload.stringValue()));
            } else {
                throw ApiError.badRequest("images: each one { url } or { uploadId }");
            }
        }
        List<String> keys = new ArrayList<>();
        List<Uploads.Claimed> made = new ArrayList<>();
        try {
            for (Object step : steps) {
                if (step instanceof String key) {
                    keys.add(key);
                } else if (step instanceof UploadStep upload) {
                    Uploads.Claimed claimed = uploads.claim(user, upload.id(), "event-cover", event.getId(), null, Imaging.Kind.COVER, ctx -> { });
                    made.add(claimed);
                    keys.add(claimed.keys().getFirst());
                }
            }
        } catch (RuntimeException error) {
            for (Uploads.Claimed claimed : made) uploads.abandon(claimed, false);
            throw error;
        }
        return new Plan(keys, made);
    }

    private record UploadStep(String id) {
    }
}
