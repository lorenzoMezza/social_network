// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import masterkey.api.Urls;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
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

/**
 * R2Storage against a real S3 server that checks signatures (SeaweedFS in Docker; R2 itself
 * needs an account, §19): the signed PUT the phone makes, a body longer or of another type than
 * signed refused, deletion in both buckets and the purge of the CDN.
 */
class R2StorageTest {

    static final String KEY = "test-access", SECRET = "test-secret-key-0123456789";
    static final String CONFIG = "{\"identities\":[{\"name\":\"test\",\"credentials\":[{\"accessKey\":\"" + KEY + "\",\"secretKey\":\""
            + SECRET + "\"}],\"actions\":[\"Admin\",\"Read\",\"Write\",\"List\",\"Tagging\"]}]}";

    static final GenericContainer<?> s3 = new GenericContainer<>(DockerImageName.parse("chrislusf/seaweedfs:4.45"))
            .withCopyToContainer(Transferable.of(CONFIG), "/etc/seaweedfs/s3.json")
            .withCommand("server", "-s3", "-s3.config=/etc/seaweedfs/s3.json", "-dir=/data", "-volume.max=200", "-master.volumeSizeLimitMB=8")
            .withExposedPorts(8333)
            .waitingFor(Wait.forHttp("/").forPort(8333).forStatusCodeMatching(code -> code > 0).withStartupTimeout(Duration.ofMinutes(2)));

    static HttpServer cloudflare;
    static final List<String> purged = new CopyOnWriteArrayList<>();
    static S3Client client;
    static String endpoint;
    final HttpClient http = HttpClient.newHttpClient();

    @BeforeAll
    static void start() throws Exception {
        s3.start();
        endpoint = "http://" + s3.getHost() + ":" + s3.getMappedPort(8333);
        client = S3Client.builder().endpointOverride(URI.create(endpoint)).region(Region.of("auto"))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(KEY, SECRET)))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).chunkedEncodingEnabled(false).build())
                .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
                .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
                .httpClientBuilder(UrlConnectionHttpClient.builder()).build();
        // The volume server comes up a little after the S3 gateway
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
        cloudflare = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        cloudflare.createContext("/client/v4/zones/zone1/purge_cache", exchange -> {
            purged.add(exchange.getRequestHeaders().getFirst("Authorization") + " " + new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            exchange.sendResponseHeaders(200, -1);
            exchange.close();
        });
        cloudflare.start();
    }

    @AfterAll
    static void stop() {
        cloudflare.stop(0);
        s3.stop();
    }

    R2Storage storage() {
        CdnPurge purge = new CdnPurge(URI.create("http://127.0.0.1:" + cloudflare.getAddress().getPort() + "/client/v4/zones/zone1/purge_cache"), "purge-token");
        return new R2Storage(endpoint, KEY, SECRET, "originals", "public", new Urls(null, "https://media.test"), purge, InstantSource.system());
    }

    HttpResponse<String> put(Storage.Ticket ticket, byte[] body, String type) throws Exception {
        HttpRequest.Builder request = HttpRequest.newBuilder(URI.create(ticket.url())).PUT(HttpRequest.BodyPublishers.ofByteArray(body));
        // As the app does: Content-Type, then the signed headers
        request.header("Content-Type", type);
        ticket.headers().forEach((name, value) -> {
            if (!name.equalsIgnoreCase("Content-Type")) request.header(name, value);
        });
        return http.send(request.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void thePhonePutsExactlyWhatWasSigned() throws Exception {
        R2Storage storage = storage();
        byte[] photo = new byte[4096];
        Storage.Ticket ticket = storage.presign("uploads/exact", "image/jpeg", photo.length, Instant.now().plusSeconds(900));
        assertThat(ticket.headers().keySet()).noneMatch(name -> name.equalsIgnoreCase("host") || name.equalsIgnoreCase("content-length"));
        assertThat(put(ticket, photo, "image/jpeg").statusCode()).isEqualTo(200);
        HeadObjectResponse head = client.headObject(request -> request.bucket("originals").key("uploads/exact"));
        assertThat(head.contentLength()).isEqualTo(4096L);
        assertThat(head.contentType()).isEqualTo("image/jpeg");

        // A bigger body, or another type, than the signature says: refused by the storage
        Storage.Ticket small = storage.presign("uploads/bigger", "image/jpeg", 1000, Instant.now().plusSeconds(900));
        assertThat(put(small, new byte[50_000], "image/jpeg").statusCode()).isGreaterThanOrEqualTo(400);
        Storage.Ticket typed = storage.presign("uploads/typed", "image/jpeg", 10, Instant.now().plusSeconds(900));
        assertThat(put(typed, new byte[10], "text/html").statusCode()).isGreaterThanOrEqualTo(400);
        assertThat(exists("originals", "uploads/bigger")).isFalse();
        assertThat(exists("originals", "uploads/typed")).isFalse();
    }

    @Test
    void deletingTakesBothBucketsAndTheCdnsCopy() {
        client.putObject(request -> request.bucket("originals").key("uploads/gone"), RequestBody.fromString("o"));
        client.putObject(request -> request.bucket("public").key("covers/gone.jpg"), RequestBody.fromString("p"));
        storage().delete(List.of("uploads/gone", "covers/gone.jpg", "../not-a-key", "covers/never-there.jpg"));
        assertThat(exists("originals", "uploads/gone")).isFalse();
        assertThat(exists("public", "covers/gone.jpg")).isFalse();
        assertThat(purged).anyMatch(line -> line.startsWith("Bearer purge-token ")
                && line.contains("\"https://media.test/covers/gone.jpg\"") && line.contains("\"https://media.test/covers/never-there.jpg\""));
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
