// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.imaged;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * Where originals are read and the files made are written (§19, Lo storage): the folder the
 * API shares in development, R2 in production ({@link S3Store}). Keys are checked by the
 * pipeline before they reach here.
 */
interface Store {

    /**
     * The original into {@code target}, only when it is at most {@code limit} bytes. Answers its
     * size (more than {@code limit}: not fetched), or -1 when it was never sent.
     */
    long fetch(String original, Path target, long limit) throws IOException;

    /** A file made, kept for good under its key (public, immutable). */
    void publish(String key, Path file) throws IOException;

    /** The original goes, whatever happened. */
    void deleteOriginal(String original) throws IOException;

    /** The folder of development: {@code uploads/} for originals, {@code media/} for what is made. */
    final class Folder implements Store {

        private final Path originals;
        private final Path published;

        Folder(Path root) {
            this.originals = root.resolve("uploads").toAbsolutePath().normalize();
            this.published = root.resolve("media").toAbsolutePath().normalize();
        }

        private Path original(String key) {
            Path path = originals.resolve(key.substring("uploads/".length())).normalize();
            if (!path.startsWith(originals)) throw new IllegalArgumentException("not an original of this storage");
            return path;
        }

        @Override
        public long fetch(String original, Path target, long limit) throws IOException {
            Path source = original(original);
            if (!Files.isRegularFile(source)) return -1;
            long size = Files.size(source);
            if (size <= limit) Files.move(source, target, StandardCopyOption.REPLACE_EXISTING);
            return size;
        }

        @Override
        public void publish(String key, Path file) throws IOException {
            Path target = published.resolve(key).normalize();
            if (!target.startsWith(published)) throw new IllegalArgumentException("not a key of this storage");
            Files.createDirectories(target.getParent());
            Files.move(file, target, StandardCopyOption.REPLACE_EXISTING);
        }

        @Override
        public void deleteOriginal(String original) throws IOException {
            Files.deleteIfExists(original(original));
        }
    }
}
