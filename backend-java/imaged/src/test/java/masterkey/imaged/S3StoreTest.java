// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.imaged;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.wait.strategy.Wait;
import org.testcontainers.images.builder.Transferable;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.HeadObjectResponse;
import software.amazon.awssdk.services.s3.model.S3Exception;

/** imaged's side of R2 against a real S3 server (SeaweedFS in Docker): originals read within a limit, files made published, originals gone. */
class S3StoreTest {

    static final String KEY = "imaged-access", SECRET = "imaged-secret-key-0123456789";
    static final String CONFIG = "{\"identities\":[{\"name\":\"imaged\",\"credentials\":[{\"accessKey\":\"" + KEY + "\",\"secretKey\":\""
            + SECRET + "\"}],\"actions\":[\"Admin\",\"Read\",\"Write\",\"List\",\"Tagging\"]}]}";

    static final GenericContainer<?> s3 = new GenericContainer<>(DockerImageName.parse("chrislusf/seaweedfs:4.45"))
            .withCopyToContainer(Transferable.of(CONFIG), "/etc/seaweedfs/s3.json")
            .withCommand("server", "-s3", "-s3.config=/etc/seaweedfs/s3.json", "-dir=/data", "-volume.max=200", "-master.volumeSizeLimitMB=8")
            .withExposedPorts(8333)
            .waitingFor(Wait.forHttp("/").forPort(8333).forStatusCodeMatching(code -> code > 0).withStartupTimeout(Duration.ofMinutes(2)));

    static S3Client client;
    static S3Store store;

    @BeforeAll
    static void start() throws Exception {
        s3.start();
        String endpoint = "http://" + s3.getHost() + ":" + s3.getMappedPort(8333);
        client = S3Client.builder().endpointOverride(URI.create(endpoint)).region(Region.of("auto"))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(KEY, SECRET)))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).chunkedEncodingEnabled(false).build())
                .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
                .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
                .httpClientBuilder(UrlConnectionHttpClient.builder()).build();
        for (int i = 0; ; i++) {
            try {
                if (!bucket("originals")) client.createBucket(request -> request.bucket("originals"));
                if (!bucket("public")) client.createBucket(request -> request.bucket("public"));
                client.putObject(request -> request.bucket("public").key("warm-up"), RequestBody.fromString("x"));
                client.putObject(request -> request.bucket("originals").key("warm-up"), RequestBody.fromString("x"));
                break;
            } catch (RuntimeException notYet) {
                if (i > 60) throw notYet;
                Thread.sleep(500);
            }
        }
        store = new S3Store(endpoint, KEY, SECRET, "originals", "public");
    }

    @AfterAll
    static void stop() {
        s3.stop();
    }

    @Test
    void anOriginalIsReadOnlyWithinItsLimit(@TempDir Path dir) throws Exception {
        byte[] bytes = new byte[300];
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) i;
        client.putObject(request -> request.bucket("originals").key("uploads/small"), RequestBody.fromBytes(bytes));
        Path in = dir.resolve("in");
        assertThat(store.fetch("uploads/small", in, 1000)).isEqualTo(300);
        assertThat(Files.readAllBytes(in)).isEqualTo(bytes);
        // Over the limit: its size, nothing read
        Path big = dir.resolve("big");
        assertThat(store.fetch("uploads/small", big, 299)).isEqualTo(300);
        assertThat(big).doesNotExist();
        assertThat(store.fetch("uploads/never", dir.resolve("never"), 1000)).isEqualTo(-1);
        store.deleteOriginal("uploads/small");
        assertThat(exists("originals", "uploads/small")).isFalse();
    }

    @Test
    void whatIsMadeIsAnImmutableJpeg(@TempDir Path dir) throws Exception {
        Path made = Files.write(dir.resolve("out.jpg"), new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF, 1, 2});
        store.publish("covers/made.jpg", made);
        HeadObjectResponse head = client.headObject(request -> request.bucket("public").key("covers/made.jpg"));
        assertThat(head.contentType()).isEqualTo("image/jpeg");
        assertThat(head.cacheControl()).isEqualTo(S3Store.CACHE);
        assertThat(head.contentLength()).isEqualTo(5L);
    }

    static boolean bucket(String name) {
        try {
            client.headBucket(request -> request.bucket(name));
            return true;
        } catch (S3Exception missing) {
            return false;
        }
    }

    static boolean exists(String bucket, String key) {
        try {
            client.headObject(request -> request.bucket(bucket).key(key));
            return true;
        } catch (S3Exception missing) {
            return false;
        }
    }
}
