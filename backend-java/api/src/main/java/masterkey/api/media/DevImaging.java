// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageInputStream;
import javax.imageio.stream.ImageOutputStream;
import masterkey.core.ApiError;

/**
 * Imaging for development, in this process with the JDK's ImageIO: JPEG and PNG only, no
 * rotation from EXIF. It exists so the app works on a computer without Docker; the rule of §5
 * (C code on hostile images never inside the main JVM) is why {@code PRODUCTION=1} refuses it and
 * uses {@code imaged}. What it writes carries no metadata: a new image, encoded from pixels.
 */
public final class DevImaging implements Imaging {

    static final long MAX_PIXELS = 60_000_000L;

    private final LocalStorage storage;

    public DevImaging(LocalStorage storage) {
        this.storage = storage;
    }

    @Override
    public Result make(String original, long declaredSize, Kind kind, List<String> outputs) {
        Path file = storage.original(original);
        if (file == null) return new Refused(ApiError.badRequest("the file was never sent"));
        try {
            long size = Files.size(file);
            if (size > LocalStorage.MAX_BYTES || size > declaredSize + declaredSize / 10) return new Refused(ApiError.tooLarge("bigger than announced"));
            byte[] head = new byte[16];
            try (InputStream in = Files.newInputStream(file)) {
                int read = in.readNBytes(head, 0, head.length);
                if (read < 3) return new Refused(ApiError.moderated("not an image this server can read"));
            }
            String format = Sniff.format(head);
            if (!"jpeg".equals(format) && !"png".equals(format)) {
                return new Refused(ApiError.moderated(format == null ? "not an image this server can read"
                        : "this development server reads JPEG and PNG only"));
            }
            BufferedImage image = read(file);
            List<Made> made = new ArrayList<>();
            switch (kind) {
                case SQUARE -> made.add(write(square(image, 512), outputs.getFirst()));
                case COVER -> made.add(write(fit(image, 2048), outputs.getFirst()));
                case PHOTO -> {
                    BufferedImage photo = fit(image, 2048);
                    made.add(write(photo, outputs.get(0)));
                    made.add(write(square(photo, 400), outputs.get(1)));
                }
            }
            return new Done(made);
        } catch (ApiError error) {
            return new Refused(error);
        } catch (IOException | RuntimeException error) {
            return new Refused(ApiError.moderated("not an image this server can read"));
        } finally {
            // The original goes at once, read or not: with its metadata it stays nowhere
            storage.delete(List.of(original));
        }
    }

    private static BufferedImage read(Path file) throws IOException {
        try (ImageInputStream in = ImageIO.createImageInputStream(file.toFile())) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(in);
            if (!readers.hasNext()) throw ApiError.moderated("not an image this server can read");
            ImageReader reader = readers.next();
            try {
                reader.setInput(in, true, true);
                // The pixels are counted before anything is decompressed
                if ((long) reader.getWidth(0) * reader.getHeight(0) > MAX_PIXELS) throw ApiError.moderated("image too large");
                BufferedImage decoded = reader.read(0);
                BufferedImage rgb = new BufferedImage(decoded.getWidth(), decoded.getHeight(), BufferedImage.TYPE_INT_RGB);
                Graphics2D g = rgb.createGraphics();
                g.drawImage(decoded, 0, 0, java.awt.Color.WHITE, null);
                g.dispose();
                return rgb;
            } finally {
                reader.dispose();
            }
        }
    }

    /** At most {@code side} on the longer side, never made bigger. */
    static BufferedImage fit(BufferedImage image, int side) {
        int width = image.getWidth(), height = image.getHeight();
        double scale = Math.min(1.0, (double) side / Math.max(width, height));
        return scaled(image, 0, 0, width, height, Math.max(1, (int) Math.round(width * scale)), Math.max(1, (int) Math.round(height * scale)));
    }

    /** The centre square, {@code side} on each side. */
    static BufferedImage square(BufferedImage image, int side) {
        int edge = Math.min(image.getWidth(), image.getHeight());
        int x = (image.getWidth() - edge) / 2, y = (image.getHeight() - edge) / 2;
        int out = Math.min(side, edge);
        return scaled(image, x, y, edge, edge, out, out);
    }

    private static BufferedImage scaled(BufferedImage image, int x, int y, int w, int h, int width, int height) {
        BufferedImage out = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = out.createGraphics();
        g.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BICUBIC);
        g.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
        g.drawImage(image, 0, 0, width, height, x, y, x + w, y + h, null);
        g.dispose();
        return out;
    }

    private Made write(BufferedImage image, String key) throws IOException {
        Path target = storage.published(key);
        Files.createDirectories(target.getParent());
        ImageWriter writer = ImageIO.getImageWritersByFormatName("jpeg").next();
        try (ImageOutputStream out = ImageIO.createImageOutputStream(target.toFile())) {
            writer.setOutput(out);
            ImageWriteParam param = writer.getDefaultWriteParam();
            param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            param.setCompressionQuality(0.85f);
            writer.write(null, new IIOImage(image, null, null), param);
        } finally {
            writer.dispose();
        }
        return new Made(key, image.getWidth(), image.getHeight());
    }
}
