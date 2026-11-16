// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import masterkey.api.Urls;
import org.jspecify.annotations.Nullable;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.core.checksums.RequestChecksumCalculation;
import software.amazon.awssdk.core.checksums.ResponseChecksumValidation;
import software.amazon.awssdk.http.urlconnection.UrlConnectionHttpClient;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.Delete;
import software.amazon.awssdk.services.s3.model.DeleteObjectsResponse;
import software.amazon.awssdk.services.s3.model.ObjectIdentifier;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.PresignedPutObjectRequest;

/**
 * R2 (§19, Lo storage), with the configuration Cloudflare gives for the Java SDK: region
 * {@code auto}, path-style, no chunked encoding, checksums only when required. Originals go to a
 * private bucket by a signed {@code PUT} that carries their exact type and length (the phone
 * declares the true size; another length breaks the signature); what imaged makes lives in the
 * public bucket behind the CDN. Deleting a public file also purges it from the CDN: with a year
 * of immutable cache it would stay reachable otherwise (GDPR art. 17). Never called with a
 * database connection in hand: deletions run in the files.delete job.
 */
public final class R2Storage implements Storage {

    static final int DELETE_BATCH = 1000;
    static final Pattern PUBLIC_KEY = Pattern.compile("[a-z]{1,16}/[A-Za-z0-9_-]{1,64}\\.jpg");
    static final Pattern ORIGINAL_KEY = Pattern.compile("uploads/[A-Za-z0-9_-]{1,64}");

    private final S3Client s3;
    private final S3Presigner presigner;
    private final String originals;
    private final String published;
    private final Urls urls;
    private final @Nullable CdnPurge purge;
    private final InstantSource clock;

    public R2Storage(String endpoint, String accessKey, String secretKey, String originals, String published, Urls urls,
                     @Nullable CdnPurge purge, InstantSource clock) {
        URI uri = URI.create(endpoint);
        StaticCredentialsProvider credentials = StaticCredentialsProvider.create(AwsBasicCredentials.create(accessKey, secretKey));
        S3Configuration config = S3Configuration.builder().pathStyleAccessEnabled(true).chunkedEncodingEnabled(false).build();
        this.s3 = S3Client.builder().endpointOverride(uri).region(Region.of("auto")).credentialsProvider(credentials)
                .serviceConfiguration(config)
                .requestChecksumCalculation(RequestChecksumCalculation.WHEN_REQUIRED)
                .responseChecksumValidation(ResponseChecksumValidation.WHEN_REQUIRED)
                .httpClientBuilder(UrlConnectionHttpClient.builder().connectionTimeout(Duration.ofSeconds(5)).socketTimeout(Duration.ofSeconds(20)))
                .overrideConfiguration(override -> override.apiCallTimeout(Duration.ofSeconds(30)))
                .build();
        this.presigner = S3Presigner.builder().endpointOverride(uri).region(Region.of("auto")).credentialsProvider(credentials)
                .serviceConfiguration(config).build();
        this.originals = originals;
        this.published = published;
        this.urls = urls;
        this.purge = purge;
        this.clock = clock;
    }

    @Override
    public Ticket presign(String key, String mimeType, long size, Instant expires) {
        Duration valid = Duration.between(clock.instant(), expires);
        PresignedPutObjectRequest signed = presigner.presignPutObject(request -> request.signatureDuration(valid)
                .putObjectRequest(put -> put.bucket(originals).key(key).contentType(mimeType).contentLength(size)));
        // What the phone must send as signed; its HTTP client adds Host and Content-Length by itself
        Map<String, String> headers = new LinkedHashMap<>();
        signed.signedHeaders().forEach((name, values) -> {
            String lower = name.toLowerCase(Locale.ROOT);
            if (!lower.equals("host") && !lower.equals("content-length") && !values.isEmpty()) headers.put(name, values.getFirst());
        });
        return new Ticket(signed.url().toString(), headers);
    }

    @Override
    public void delete(Collection<String> keys) {
        List<String> private_ = new ArrayList<>();
        List<String> public_ = new ArrayList<>();
        for (String key : keys) {
            if (ORIGINAL_KEY.matcher(key).matches()) private_.add(key);
            else if (PUBLIC_KEY.matcher(key).matches()) public_.add(key);
        }
        deleteAll(originals, private_);
        deleteAll(published, public_);
        CdnPurge cdn = purge;
        if (cdn != null && !public_.isEmpty()) {
            List<String> addresses = new ArrayList<>();
            for (String key : public_) {
                String url = urls.media(key);
                if (url != null) addresses.add(url);
            }
            cdn.purge(addresses);
        }
    }

    /** In batches of the API's maximum; a key already gone is no error. An error throws: the job tries again. */
    private void deleteAll(String bucket, List<String> keys) {
        for (int from = 0; from < keys.size(); from += DELETE_BATCH) {
            List<ObjectIdentifier> part = keys.subList(from, Math.min(keys.size(), from + DELETE_BATCH)).stream()
                    .map(key -> ObjectIdentifier.builder().key(key).build()).toList();
            DeleteObjectsResponse answer = s3.deleteObjects(request -> request.bucket(bucket)
                    .delete(Delete.builder().objects(part).quiet(true).build()));
            if (answer.hasErrors() && !answer.errors().isEmpty()) {
                throw new IllegalStateException("R2: " + answer.errors().size() + " files could not be deleted");
            }
        }
    }
}
