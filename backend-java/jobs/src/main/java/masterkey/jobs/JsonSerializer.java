// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.jobs;

import com.github.kagkarlsson.scheduler.serializer.Serializer;
import masterkey.core.Json;
import org.jspecify.annotations.Nullable;

/**
 * The data of the jobs in JSON, with the one mapper of the server (§16). db-scheduler's own
 * default is Java serialization, the classic way to run code from bytes: forbidden here. No
 * default typing either: a job's data is always read as the class its task names.
 */
final class JsonSerializer implements Serializer {

    @Override
    @SuppressWarnings("NullAway")
    public byte[] serialize(@Nullable Object data) {
        // A job without data keeps none (db-scheduler then stores NULL)
        if (data == null) return null;
        return Json.MAPPER.writeValueAsBytes(data);
    }

    @Override
    @SuppressWarnings("NullAway")
    public <T> T deserialize(Class<T> type, byte @Nullable [] data) {
        if (data == null || type == Void.class) return null;
        return Json.MAPPER.readValue(data, type);
    }
}
