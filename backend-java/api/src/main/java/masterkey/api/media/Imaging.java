// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import java.util.List;
import masterkey.core.ApiError;

/**
 * Makes an upload's original into the files that are kept (§19, Cosa fa imaged): checks what
 * it really is, applies the rotation, strips every metadata, resizes, writes the outputs under
 * the names given, and deletes the original whatever happens. Blocking: never with a database
 * connection in hand.
 */
public interface Imaging {

    /** What to make: 512 px squares (profile, group), a 2048 px cover, a photo and its 400 px thumbnail. */
    enum Kind {
        SQUARE(1), COVER(1), PHOTO(2);

        public final int outputs;

        Kind(int outputs) {
            this.outputs = outputs;
        }
    }

    record Made(String key, int width, int height) {
    }

    sealed interface Result {
    }

    /** The files made, in the order of the output keys. */
    record Done(List<Made> files) implements Result {
    }

    /** The file was refused (422 moderated, 413 too_large): the upload is used up. */
    record Refused(ApiError error) implements Result {
    }

    /** The service does not answer or is full: the upload stays as it was, and so does its original. */
    record Busy() implements Result {
    }

    Result make(String original, long declaredSize, Kind kind, List<String> outputs);
}
