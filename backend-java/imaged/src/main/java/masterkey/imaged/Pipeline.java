// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.imaged;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.jspecify.annotations.Nullable;

/**
 * What imaged does with one image, in the order of JAVA-BACKEND.md §19 (Cosa fa imaged):
 * the first bytes decide the format; {@code vipsheader} says the loader and the pixels without
 * decompressing; {@code vips thumbnail} always makes the file again, rotation applied and every
 * metadata gone ({@code keep=none}); the result is read again; the original is deleted whatever
 * happened, and the folder of the job too. Commands are lists of arguments, never a shell, and
 * the names of the files are imaged's, never the user's: vips reads options in brackets.
 */
final class Pipeline {

    static final long MAX_BYTES = 20L * 1024 * 1024;
    static final long MAX_PIXELS = 60_000_000L;
    static final Duration TIMEOUT = Duration.ofSeconds(20);
    static final Set<String> LOADERS = Set.of("jpegload", "pngload", "webpload", "heifload");
    static final Pattern KEY = Pattern.compile("[a-z]{1,16}/[A-Za-z0-9_-]{1,64}\\.jpg");
    static final Pattern ORIGINAL = Pattern.compile("uploads/[A-Za-z0-9_-]{1,64}");

    enum Kind { SQUARE, COVER, PHOTO }

    record Made(String key, int width, int height) {
    }

    /** A refusal of the file (422, 413), or the request (400). */
    static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;
        final int status;

        Refused(int status, String message) {
            super(message, null, false, false);
            this.status = status;
        }
    }

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(Pipeline.class);

    private final Store store;
    private final Path work;
    private final String vips;
    private final String vipsheader;

    Pipeline(Store store, Path work, String vips, String vipsheader) {
        this.store = store;
        this.work = work.toAbsolutePath().normalize();
        this.vips = vips;
        this.vipsheader = vipsheader;
    }

    List<Made> make(String original, long declared, Kind kind, List<String> outputs) throws Refused, IOException, InterruptedException {
        if (!ORIGINAL.matcher(original).matches()) throw new Refused(400, "not an original of this storage");
        for (String key : outputs) if (!KEY.matcher(key).matches()) throw new Refused(400, "not a key of this storage");
        if (outputs.size() != (kind == Kind.PHOTO ? 2 : 1)) throw new Refused(400, "outputs do not match the kind");
        Path job = Files.createTempDirectory(work, "job-");
        try {
            // Into the job's folder under a name of ours (nothing of the user's in a name), only
            // up to 110% of what was announced (R2 may not stop a bigger body) and the limit
            Path input = job.resolve("in");
            long limit = Math.min(MAX_BYTES, declared + declared / 10);
            long size = store.fetch(original, input, limit);
            if (size < 0) throw new Refused(400, "the file was never sent");
            if (size > limit) throw new Refused(413, "bigger than announced");
            byte[] head = new byte[16];
            try (InputStream in = Files.newInputStream(input)) {
                if (in.readNBytes(head, 0, head.length) < 3) throw new Refused(422, "not an image this server can read");
            }
            if (format(head) == null) throw new Refused(422, "not an image this server can read");
            String loader = header(job, input, "vips-loader");
            if (loader == null || LOADERS.stream().noneMatch(loader::startsWith)) throw new Refused(422, "not an image this server can read");
            long width = number(header(job, input, "width")), height = number(header(job, input, "height"));
            if (width <= 0 || height <= 0) throw new Refused(422, "not an image this server can read");
            if (width * height > MAX_PIXELS) throw new Refused(422, "image too large");
            List<Made> made = new ArrayList<>();
            switch (kind) {
                case SQUARE -> made.add(thumbnail(job, input, outputs.getFirst(), 512, true));
                case COVER -> made.add(thumbnail(job, input, outputs.getFirst(), 2048, false));
                case PHOTO -> {
                    made.add(thumbnail(job, input, outputs.get(0), 2048, false));
                    made.add(thumbnail(job, input, outputs.get(1), 400, true));
                }
            }
            return made;
        } finally {
            // Nothing of the original stays: not in the storage, not in the job's folder
            try {
                store.deleteOriginal(original);
            } catch (IOException | RuntimeException error) {
                log.warn("imaged: an original could not be deleted now: {}", error.getClass().getSimpleName());
            }
            try (Stream<Path> files = Files.walk(job)) {
                for (Path path : files.sorted(Comparator.reverseOrder()).toList()) Files.deleteIfExists(path);
            }
        }
    }

    private Made thumbnail(Path job, Path input, String key, int side, boolean crop) throws Refused, IOException, InterruptedException {
        Path output = job.resolve("out-" + side + ".jpg");
        List<String> command = new ArrayList<>(List.of(vips, "thumbnail", input.toString(),
                output + "[Q=85,optimize_coding,keep=none]", Integer.toString(side), "--height", Integer.toString(side),
                "--size", "down", "--export-profile", "srgb", "--fail-on", "truncated"));
        if (crop) command.addAll(List.of("--crop", "centre"));
        if (run(job, command) == null) throw new Refused(422, "not an image this server can read");
        // Read again before it is kept: its size goes in the answer
        long width = number(header(job, output, "width")), height = number(header(job, output, "height"));
        if (width <= 0 || height <= 0) throw new Refused(422, "not an image this server can read");
        store.publish(key, output);
        return new Made(key, (int) width, (int) height);
    }

    private @Nullable String header(Path job, Path file, String field) throws IOException, InterruptedException {
        String out = run(job, List.of(vipsheader, "-f", field, file.toString()));
        return out == null ? null : out.strip();
    }

    /** One process, its own folder for temporary files, a time limit; null when it failed. */
    private @Nullable String run(Path job, List<String> command) throws IOException, InterruptedException {
        ProcessBuilder builder = new ProcessBuilder(command).directory(job.toFile()).redirectErrorStream(true);
        builder.environment().clear();
        builder.environment().put("PATH", System.getenv().getOrDefault("PATH", "/usr/bin:/bin"));
        builder.environment().put("VIPS_BLOCK_UNTRUSTED", "1");
        builder.environment().put("VIPS_CONCURRENCY", "1");
        builder.environment().put("TMPDIR", job.toString());
        Process process = builder.start();
        byte[] output;
        try (InputStream in = process.getInputStream()) {
            if (!process.waitFor(TIMEOUT.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                return null;
            }
            output = in.readNBytes(64 * 1024);
        }
        return process.exitValue() == 0 ? new String(output, StandardCharsets.UTF_8) : null;
    }

    private static long number(@Nullable String text) {
        return text != null && text.matches("[0-9]{1,9}") ? Long.parseLong(text) : -1;
    }

    /** JPEG, PNG, WebP or HEIC from the first bytes; anything else is refused (GIF and TIFF too). */
    static @Nullable String format(byte[] head) {
        if (head.length >= 3 && (head[0] & 0xff) == 0xFF && (head[1] & 0xff) == 0xD8 && (head[2] & 0xff) == 0xFF) return "jpeg";
        if (head.length >= 8 && (head[0] & 0xff) == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G'
                && head[4] == 0x0D && head[5] == 0x0A && head[6] == 0x1A && head[7] == 0x0A) return "png";
        if (head.length >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F'
                && head[8] == 'W' && head[9] == 'E' && head[10] == 'B' && head[11] == 'P') return "webp";
        if (head.length >= 12 && head[4] == 'f' && head[5] == 't' && head[6] == 'y' && head[7] == 'p') {
            String brand = new String(head, 8, 4, StandardCharsets.US_ASCII);
            if (Set.of("heic", "heix", "hevc", "mif1").contains(brand)) return "heic";
        }
        return null;
    }
}
