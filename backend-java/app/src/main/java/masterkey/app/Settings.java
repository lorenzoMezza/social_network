// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * The configuration, from the environment (JAVA-BACKEND.md §9, Configurazione). With
 * {@code PRODUCTION=1} the server does not start unless every rule of {@link #problems} holds
 * ({@code config.production_problems}, plus the area key and the database). Its
 * {@code toString} says nothing: secrets never reach a log.
 */
public record Settings(
        int port,
        Set<Role> roles,
        String databaseUrl,
        @Nullable String databaseUser,
        @Nullable String databasePassword,
        int databasePool,
        String logtoIssuer,
        @Nullable String logtoJwks,
        @Nullable String logtoUserinfo,
        String logtoAppId,
        @Nullable String logtoM2mAppId,
        @Nullable String logtoM2mAppSecret,
        @Nullable String logtoManagementResource,
        @Nullable String apiResource,
        @Nullable String minAppVersion,
        boolean trustUnverifiedTokens,
        @Nullable String publicUrl,
        @Nullable String mediaUrl,
        @Nullable String assetsUrl,
        String areaKeyBase64,
        boolean areaKeySet,
        double maxTravelSpeed,
        int maxShown,
        String dataDir,
        String avatarLibrary,
        @Nullable String avatarBakerUrl,
        @Nullable String avatarBakeSecret,
        int avatarBakeTimeoutSeconds,
        @Nullable String imagedUrl,
        @Nullable String imagedSecret,
        Purchases purchases,
        R2 r2,
        Push push,
        int jobThreads,
        boolean devTools,
        boolean production) {

    /**
     * Push straight to Apple and Google (§14, D5): APNs with the team's .p8 key, its id, the team
     * and the app's bundle id (topic), sandbox for development builds; FCM with the Firebase
     * project's service account.
     */
    public record Push(
            @Nullable String apnsKeyFile,
            @Nullable String apnsKeyId,
            @Nullable String apnsTeamId,
            @Nullable String apnsTopic,
            boolean apnsSandbox,
            @Nullable String fcmServiceAccountFile) {

        @Override
        public String toString() {
            return "Push[apns=" + (apnsKeyFile != null) + ", fcm=" + (fcmServiceAccountFile != null) + "]";
        }
    }

    /**
     * The storage of production (§19): R2's endpoint and keys, the private bucket of originals,
     * the public one behind the CDN, and the CDN's purge (Cloudflare zone and token).
     */
    public record R2(
            @Nullable String endpoint,
            @Nullable String accessKeyId,
            @Nullable String secretAccessKey,
            @Nullable String originalsBucket,
            @Nullable String publicBucket,
            @Nullable String purgeZone,
            @Nullable String purgeToken) {

        public boolean set() {
            return endpoint != null && accessKeyId != null && secretAccessKey != null && originalsBucket != null && publicBucket != null;
        }

        @Override
        public String toString() {
            return "R2[" + (set() ? "set" : "not set") + "]";
        }
    }

    /**
     * The stores purchases are checked with ({@code config.py}, stores). Unset, the purchases of
     * that store answer 503. Apple: the bundle id, the app's Apple id (Production needs it) and
     * Apple's roots (DER files, from apple.com/certificateauthority, comma separated).
     */
    public record Purchases(
            @Nullable String appleBundleId,
            @Nullable Long appleAppId,
            @Nullable String appleRootCa,
            boolean appleAllowSandbox,
            boolean appleOnlineChecks,
            @Nullable String googlePackageName,
            @Nullable String googleServiceAccountFile,
            @Nullable String googleRtdnSecret,
            boolean googleAllowTestPurchases) {

        @Override
        public String toString() {
            return "Purchases[apple=" + (appleBundleId != null) + ", google=" + (googlePackageName != null) + "]";
        }
    }

    public enum Role { GATEWAY, PRESENCE, API, WORKER }

    /** Not a secret: only for development, where nobody's real place is shown. */
    static final byte[] DEVELOPMENT_AREA_KEY = "development-area-key-not-a-secret!".getBytes(StandardCharsets.UTF_8);

    public static Settings from(Map<String, String> env, String[] args) {
        String roles = env.getOrDefault("ROLES", "gateway,presence,api,worker");
        for (String arg : args) if (arg.startsWith("--roles=")) roles = arg.substring("--roles=".length());
        String key = blank(env.get("AREA_HMAC_KEY"));
        String issuer = env.getOrDefault("LOGTO_ISSUER", "https://bl5ooc.logto.app/oidc");
        return new Settings(
                integer(env, "PORT", 7777),
                roles(roles),
                env.getOrDefault("DATABASE_URL", "jdbc:postgresql://127.0.0.1:5433/masterkey"),
                env.getOrDefault("DATABASE_USER", "masterkey"),
                env.getOrDefault("DATABASE_PASSWORD", "masterkey"),
                integer(env, "DATABASE_POOL", 20),
                issuer,
                blank(env.get("LOGTO_JWKS_URL")),
                blank(env.get("LOGTO_USERINFO_URL")),
                env.getOrDefault("LOGTO_APP_ID", "n5b35te70myyr7cafk5ed"),
                blank(env.get("LOGTO_M2M_APP_ID")),
                blank(env.get("LOGTO_M2M_APP_SECRET")),
                blank(env.get("LOGTO_MANAGEMENT_RESOURCE")),
                blank(env.get("API_RESOURCE")),
                blank(env.get("MIN_APP_VERSION")),
                "1".equals(env.get("TRUST_UNVERIFIED_TOKENS")),
                blank(env.get("PUBLIC_URL")),
                blank(env.get("MEDIA_URL")),
                blank(env.get("ASSETS_URL")),
                Base64.getEncoder().encodeToString(key == null ? DEVELOPMENT_AREA_KEY : decode(key)),
                key != null,
                number(env, "MAX_TRAVEL_SPEED_MPS", 340),
                integer(env, "MAX_SHOWN", 25),
                env.getOrDefault("DATA_DIR", "data"),
                env.getOrDefault("AVATAR_LIBRARY", "../avatar-server/library"),
                env.containsKey("AVATAR_BAKER_URL") ? blank(env.get("AVATAR_BAKER_URL")) : "http://127.0.0.1:8092",
                blank(env.get("AVATAR_BAKE_SECRET")),
                integer(env, "AVATAR_BAKE_TIMEOUT_S", 30),
                blank(env.get("IMAGED_URL")),
                blank(env.get("IMAGED_SECRET")),
                new Purchases(
                        blank(env.get("APPLE_BUNDLE_ID")),
                        longInteger(env, "APPLE_APP_ID"),
                        blank(env.get("APPLE_ROOT_CA")),
                        "1".equals(env.get("APPLE_ALLOW_SANDBOX")),
                        !"0".equals(env.get("APPLE_ONLINE_CHECKS")),
                        blank(env.get("GOOGLE_PACKAGE_NAME")),
                        blank(env.get("GOOGLE_SERVICE_ACCOUNT_FILE")),
                        blank(env.get("GOOGLE_RTDN_SECRET")),
                        "1".equals(env.get("GOOGLE_ALLOW_TEST_PURCHASES"))),
                new R2(blank(env.get("R2_ENDPOINT")), blank(env.get("R2_ACCESS_KEY_ID")), blank(env.get("R2_SECRET_ACCESS_KEY")),
                        blank(env.get("R2_ORIGINALS_BUCKET")), blank(env.get("R2_PUBLIC_BUCKET")),
                        blank(env.get("CDN_PURGE_ZONE")), blank(env.get("CDN_PURGE_TOKEN"))),
                new Push(blank(env.get("APNS_KEY_FILE")), blank(env.get("APNS_KEY_ID")), blank(env.get("APNS_TEAM_ID")),
                        env.containsKey("APNS_TOPIC") ? blank(env.get("APNS_TOPIC")) : blank(env.get("APPLE_BUNDLE_ID")),
                        "1".equals(env.get("APNS_SANDBOX")), blank(env.get("FCM_SERVICE_ACCOUNT_FILE"))),
                integer(env, "JOB_THREADS", 4),
                "1".equals(env.get("DEV_TOOLS")),
                "1".equals(env.get("PRODUCTION")));
    }

    /** What makes this configuration unsafe for real users. */
    public List<String> problems() {
        List<String> problems = new ArrayList<>();
        if (apiResource == null) problems.add("API_RESOURCE is not set: tokens meant for other services would be accepted");
        if (trustUnverifiedTokens) problems.add("TRUST_UNVERIFIED_TOKENS is on: anyone could sign in as anyone");
        if (devTools) problems.add("DEV_TOOLS is on: free credits and development routes");
        if (purchases.appleAllowSandbox()) problems.add("APPLE_ALLOW_SANDBOX is on: free credits from sandbox purchases");
        if (purchases.googleAllowTestPurchases()) problems.add("GOOGLE_ALLOW_TEST_PURCHASES is on: free credits from test purchases");
        if (!purchases.appleOnlineChecks()) problems.add("APPLE_ONLINE_CHECKS is off: a revoked Apple certificate would still be trusted");
        if (purchases.appleBundleId() != null && (purchases.appleAppId() == null || purchases.appleRootCa() == null)) {
            problems.add("APPLE_BUNDLE_ID needs APPLE_APP_ID and APPLE_ROOT_CA: App Store purchases could not be checked");
        }
        if (purchases.googlePackageName() != null && purchases.googleServiceAccountFile() == null) {
            problems.add("GOOGLE_PACKAGE_NAME needs GOOGLE_SERVICE_ACCOUNT_FILE: Play purchases could not be checked");
        }
        if (publicUrl == null || !publicUrl.startsWith("https://")) problems.add("PUBLIC_URL is not https: addresses would be taken from the request's Host");
        if (mediaUrl == null || !mediaUrl.startsWith("https://")) problems.add("MEDIA_URL is not https: pictures would be served by the API");
        if (assetsUrl == null || !assetsUrl.startsWith("https://")) problems.add("ASSETS_URL is not https");
        if (!areaKeySet) problems.add("AREA_HMAC_KEY is not set: the area points would be known to anyone with the code");
        if (databaseUrl.contains("127.0.0.1") || databaseUrl.contains("localhost")) problems.add("DATABASE_URL is the development database");
        if ("masterkey".equals(databasePassword)) problems.add("DATABASE_PASSWORD is the development one");
        if (imagedUrl == null || imagedSecret == null) problems.add("IMAGED_URL and IMAGED_SECRET are not set: images would be opened inside the API (§5)");
        if (!r2.set()) problems.add("R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ORIGINALS_BUCKET, R2_PUBLIC_BUCKET are not set: files would be kept on this machine");
        if (r2.purgeZone() == null || r2.purgeToken() == null) problems.add("CDN_PURGE_ZONE and CDN_PURGE_TOKEN are not set: a deleted picture would stay in the CDN's cache for a year (GDPR art. 17)");
        if (push.apnsSandbox()) problems.add("APNS_SANDBOX is on: phones installed from the App Store would get no push");
        if (logtoM2mAppId == null || logtoM2mAppSecret == null) {
            problems.add("LOGTO_M2M_APP_ID and LOGTO_M2M_APP_SECRET are not set: a deleted account would stay at Logto (C14)");
        }
        if (avatarBakeSecret == null) problems.add("AVATAR_BAKE_SECRET is not set: the avatar server takes anyone behind a local proxy");
        if (!java.nio.file.Files.isRegularFile(java.nio.file.Path.of(avatarLibrary, "catalog.json"))) {
            problems.add("AVATAR_LIBRARY has no catalog.json: avatars could not be checked against it");
        }
        return problems;
    }

    /** The secret of the area points (§4.5), stable from one start to the next. */
    public byte[] areaKey() {
        return Base64.getDecoder().decode(areaKeyBase64);
    }

    public boolean has(Role role) {
        return roles.contains(role);
    }

    static Set<Role> roles(String text) {
        EnumSet<Role> roles = EnumSet.noneOf(Role.class);
        for (String part : text.split(",", -1)) {
            String name = part.strip().toUpperCase(Locale.ROOT);
            if (name.isEmpty()) continue;
            roles.add(Role.valueOf(name));
        }
        if (roles.isEmpty()) throw new IllegalArgumentException("ROLES names no role");
        return roles;
    }

    private static byte[] decode(String key) {
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(key);
        } catch (IllegalArgumentException error) {
            bytes = key.getBytes(StandardCharsets.UTF_8);
        }
        if (bytes.length < 32) throw new IllegalArgumentException("AREA_HMAC_KEY needs 32 bytes at least (base64)");
        return bytes;
    }

    private static @Nullable String blank(@Nullable String value) {
        return value == null || value.isBlank() ? null : value.strip();
    }

    private static int integer(Map<String, String> env, String name, int otherwise) {
        String value = blank(env.get(name));
        if (value == null) return otherwise;
        if (!value.matches("[0-9]{1,9}")) throw new IllegalArgumentException(name + " is not a number");
        return Integer.parseInt(value);
    }

    private static @Nullable Long longInteger(Map<String, String> env, String name) {
        String value = blank(env.get(name));
        if (value == null) return null;
        if (!value.matches("[0-9]{1,18}")) throw new IllegalArgumentException(name + " is not a number");
        return Long.parseLong(value);
    }

    private static double number(Map<String, String> env, String name, double otherwise) {
        String value = blank(env.get(name));
        if (value == null) return otherwise;
        if (!value.matches("[0-9]{1,12}(\\.[0-9]{1,6})?")) throw new IllegalArgumentException(name + " is not a number");
        return Double.parseDouble(value);
    }

    @Override
    public boolean equals(@Nullable Object other) {
        return this == other;
    }

    @Override
    public int hashCode() {
        return System.identityHashCode(this);
    }

    @Override
    public String toString() {
        return "Settings[port=" + port + ", roles=" + roles + ", production=" + production + "]";
    }
}
