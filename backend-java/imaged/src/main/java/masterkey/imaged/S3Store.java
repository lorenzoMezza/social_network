// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.imaged;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;
import software.amazon.awssdk.core.exception.SdkException;
import software.amazon.awssdk.core.sync.RequestBody;
import software.amazon.awssdk.core.sync.ResponseTransformer;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;
import software.amazon.awssdk.services.s3.model.S3Exception;

/**
 * R2 (§19, Lo storage), with the configuration Cloudflare gives for the Java SDK: region
 * {@code auto}, path-style, no chunked encoding, checksums only when required. Originals come
 * from the private bucket (size asked first, then at most that many bytes read); what is made
 * goes to the public one as an immutable JPEG.
 */
final class S3Store implements Store {

    static final String CACHE = "public, max-age=31536000, immutable";

    private final S3Client s3;
    private final String originals;
    private final String published;

    S3Store(String endpoint, String accessKey, String secretKey, String originals, String published) {
        this.s3 = S3Client.builder()
                .endpointOverride(URI.create(endpoint))
                .region(Region.of("auto"))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKey, secretKey)))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).chunkedEncodingEnabled(false).build())
                .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
                .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
                .httpClientBuilder(UrlConnectionHttpClient.builder().connectionTimeout(Duration.ofSeconds(5)).socketTimeout(Duration.ofSeconds(20)))
                .overrideConfiguration(config -> config.apiCallTimeout(Duration.ofSeconds(30)))
                .build();
        this.originals = originals;
        this.published = published;
    }

    @Override
    public long fetch(String original, Path target, long limit) throws IOException {
        long size;
        try {
            size = s3.headObject(request -> request.bucket(originals).key(original)).contentLength();
        } catch (NoSuchKeyException missing) {
            return -1;
        } catch (S3Exception error) {
            if (error.statusCode() == 404) return -1;
            throw new IOException("R2: the original could not be read", error);
        } catch (SdkException error) {
            throw new IOException("R2: the original could not be read", error);
        }
        if (size > limit) return size;
        if (size == 0) {
            Files.write(target, new byte[0]);
            return 0;
        }
        try {
            Files.deleteIfExists(target);
            // At most the size just read: a body sent again meanwhile cannot be bigger here
            s3.getObject(request -> request.bucket(originals).key(original).range("bytes=0-" + Math.max(0, size - 1)),
                    ResponseTransformer.toFile(target));
        } catch (NoSuchKeyException missing) {
            return -1;
        } catch (SdkException error) {
            throw new IOException("R2: the original could not be read", error);
        }
        return Files.size(target);
    }

    @Override
    public void publish(String key, Path file) throws IOException {
        try {
            s3.putObject(request -> request.bucket(published).key(key).contentType("image/jpeg").cacheControl(CACHE), RequestBody.fromFile(file));
        } catch (SdkException error) {
            throw new IOException("R2: a file could not be written", error);
        }
    }

    @Override
    public void deleteOriginal(String original) throws IOException {
        try {
            s3.deleteObject(request -> request.bucket(originals).key(original));
        } catch (SdkException error) {
            // The private bucket's rule takes it within a day (§19)
            throw new IOException("R2: an original could not be deleted", error);
        }
    }
}
