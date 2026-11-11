// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.InstantSource;
import java.util.Collection;
import java.util.HexFormat;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import masterkey.api.Urls;
import masterkey.core.ApiError;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The storage of development: a folder, with the routes the Python has ({@code /v1/storage/…}
 * receives an original at its signed address, {@code /v1/media/…} serves what was made). Never in
 * production: R2 there, with the CDN on another domain (§19).
 */
public final class LocalStorage implements Storage {

    private static final Logger log = LoggerFactory.getLogger(LocalStorage.class);
    public static final long MAX_BYTES = 20L * 1024 * 1024;

    private final Path originals;
    private final Path published;
    private final Urls urls;
    private final InstantSource clock;
    private final byte[] secret = new byte[32];

    public LocalStorage(Path root, Urls urls, InstantSource clock) {
        this.originals = root.resolve("uploads").toAbsolutePath().normalize();
        this.published = root.resolve("media").toAbsolutePath().normalize();
        this.urls = urls;
        this.clock = clock;
        new SecureRandom().nextBytes(secret);
        try {
            Files.createDirectories(originals);
            Files.createDirectories(published);
        } catch (IOException error) {
            throw new IllegalStateException("cannot make the storage folders", error);
        }
    }

    @Override
    public Ticket presign(String key, String mimeType, long size, Instant expires) {
        String name = key.substring(key.lastIndexOf('/') + 1);
        long until = expires.toEpochMilli();
        String url = urls.api() + "/v1/storage/" + name + "?size=" + size + "&expires=" + until + "&signature=" + sign(name, size, until);
        return new Ticket(url, Map.of());
    }

    /** The storage's side of a signed address: the original arrives, never more than announced (and a little). */
    public void receive(String name, long size, long expires, String signature, InputStream body) {
        if (!name.matches("[A-Za-z0-9_-]{1,64}") || !MessageDigest.isEqual(signature.getBytes(StandardCharsets.UTF_8),
                sign(name, size, expires).getBytes(StandardCharsets.UTF_8)) || expires < clock.instant().toEpochMilli()) {
            throw ApiError.forbidden("invalid or expired upload address");
        }
        long limit = Math.min(MAX_BYTES, size + size / 10 + 1024);
        Path target = originals.resolve(name);
        Path partial = originals.resolve(name + ".part");
        long total = 0;
        try (InputStream in = body; OutputStream out = Files.newOutputStream(partial)) {
            byte[] buffer = new byte[64 * 1024];
            for (int read; (read = in.read(buffer)) >= 0; ) {
                total += read;
                if (total > limit) throw ApiError.tooLarge("bigger than announced");
                out.write(buffer, 0, read);
            }
        } catch (IOException error) {
            delete(partial);
            throw ApiError.badRequest("the file did not arrive whole");
        } catch (ApiError error) {
            delete(partial);
            throw error;
        }
        try {
            Files.move(partial, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException error) {
            delete(partial);
            throw new IllegalStateException("cannot keep the file", error);
        }
    }

    /** The file of an original, or null when it never arrived. */
    public @Nullable Path original(String key) {
        Path path = originals.resolve(key.substring(key.lastIndexOf('/') + 1)).normalize();
        return path.startsWith(originals) && Files.isRegularFile(path) ? path : null;
    }

    /** Where a file that was made goes, inside the public folder only. */
    public Path published(String key) {
        Path path = published.resolve(key).normalize();
        if (!path.startsWith(published)) throw new IllegalArgumentException("not a key of this storage");
        return path;
    }

    /** A published file to serve, or null. */
    public @Nullable Path served(String key) {
        if (!key.matches("[a-z]{1,16}/[A-Za-z0-9_-]{1,64}\\.jpg")) return null;
        Path path = published(key);
        return Files.isRegularFile(path) ? path : null;
    }

    @Override
    public void delete(Collection<String> keys) {
        for (String key : keys) {
            if (key.startsWith("uploads/")) {
                Path path = original(key);
                if (path != null) delete(path);
            } else if (key.matches("[a-z]{1,16}/[A-Za-z0-9_-]{1,64}\\.jpg")) {
                delete(published(key));
            }
        }
    }

    /** A file that cannot be deleted fails the job that asked: it is tried again (files.delete). */
    private static void delete(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException error) {
            log.warn("storage: a file could not be deleted");
            throw new java.io.UncheckedIOException(error);
        }
    }

    private String sign(String name, long size, long expires) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            return HexFormat.of().formatHex(mac.doFinal((name + ":" + size + ":" + expires).getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException error) {
            throw new IllegalStateException(error);
        }
    }
}
