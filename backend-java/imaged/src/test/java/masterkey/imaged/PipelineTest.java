// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.imaged;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The checks before vips, always; the whole way through vips only where it is installed
 * (the Docker image of imaged; on a computer without libvips that part is skipped).
 */
class PipelineTest {

    @TempDir
    Path root;

    @TempDir
    Path work;

    @Test
    void theFirstBytesDecideTheFormat() {
        assertThat(Pipeline.format(new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, 0})).isEqualTo("jpeg");
        assertThat(Pipeline.format(new byte[] {(byte) 0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})).isEqualTo("png");
        assertThat(Pipeline.format("RIFF0000WEBPVP8 ".getBytes(StandardCharsets.US_ASCII))).isEqualTo("webp");
        assertThat(Pipeline.format("0000ftypheic0000".getBytes(StandardCharsets.US_ASCII))).isEqualTo("heic");
        assertThat(Pipeline.format("GIF89a..........".getBytes(StandardCharsets.US_ASCII))).isNull();
        assertThat(Pipeline.format("II*.............".getBytes(StandardCharsets.US_ASCII))).isNull();
        assertThat(Pipeline.format("<svg xmlns=\"x\">".getBytes(StandardCharsets.US_ASCII))).isNull();
    }

    @Test
    void namesAreImagedsNeverTheUsers() throws Exception {
        Pipeline pipeline = new Pipeline(new Store.Folder(root), work, "vips", "vipsheader");
        assertThatThrownBy(() -> pipeline.make("uploads/../../etc/passwd", 10, Pipeline.Kind.SQUARE, List.of("pictures/a.jpg")))
                .isInstanceOf(Pipeline.Refused.class);
        assertThatThrownBy(() -> pipeline.make("uploads/abc", 10, Pipeline.Kind.SQUARE, List.of("pictures/a.jpg[x]")))
                .isInstanceOf(Pipeline.Refused.class);
        assertThatThrownBy(() -> pipeline.make("uploads/abc", 10, Pipeline.Kind.PHOTO, List.of("photos/a.jpg")))
                .isInstanceOf(Pipeline.Refused.class);
    }

    @Test
    void aFileBiggerThanAnnouncedIsRefusedAndDeleted() throws Exception {
        Files.createDirectories(root.resolve("uploads"));
        Path original = root.resolve("uploads/big");
        Files.write(original, new byte[5000]);
        Pipeline pipeline = new Pipeline(new Store.Folder(root), work, "vips", "vipsheader");
        assertThatThrownBy(() -> pipeline.make("uploads/big", 1000, Pipeline.Kind.SQUARE, List.of("pictures/a.jpg")))
                .isInstanceOf(Pipeline.Refused.class).satisfies(error -> assertThat(((Pipeline.Refused) error).status).isEqualTo(413));
        assertThat(original).doesNotExist();
    }

    @Test
    void withVipsAPictureIsMadeAgain() throws Exception {
        assumeTrue(installed(), "libvips is not installed here");
        BufferedImage image = new BufferedImage(900, 600, BufferedImage.TYPE_INT_RGB);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "jpeg", out);
        Files.createDirectories(root.resolve("uploads"));
        Files.write(root.resolve("uploads/pic"), out.toByteArray());
        Pipeline pipeline = new Pipeline(new Store.Folder(root), work, "vips", "vipsheader");
        List<Pipeline.Made> made = pipeline.make("uploads/pic", out.size(), Pipeline.Kind.SQUARE, List.of("pictures/a.jpg"));
        assertThat(made.getFirst().width()).isEqualTo(512);
        assertThat(root.resolve("media/pictures/a.jpg")).exists();
        assertThat(root.resolve("uploads/pic")).doesNotExist();
    }

    private static boolean installed() {
        try {
            return new ProcessBuilder("vips", "--version").start().waitFor() == 0;
        } catch (Exception error) {
            return false;
        }
    }
}
