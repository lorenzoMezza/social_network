// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import static masterkey.store.db.Tables.UPLOADS;

import java.time.Duration;
import java.time.Instant;
import java.time.InstantSource;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Consumer;
import masterkey.api.common.Later;
import masterkey.core.ApiError;
import masterkey.core.Ids;
import masterkey.store.Database;
import masterkey.store.db.tables.records.UploadsRecord;
import org.jooq.DSLContext;
import org.jspecify.annotations.Nullable;

/**
 * Uploads (API.md, Uploads; JAVA-BACKEND.md §19, Il passo 3): a ticket now, the file straight to
 * the storage, then used once by the request that names it. "Never the network with a database
 * connection in hand" and "an error of the server does not use up the upload" hold together in
 * three steps: (a) a short transaction claims it and names its outputs, (b) imaging outside any
 * transaction, (c) the caller's transaction marks it used with what it makes.
 */
public final class Uploads {

    public static final Set<String> PURPOSES = Set.of("profile-picture", "event-cover", "event-photo", "group-picture");
    static final Set<String> MIME_TYPES = Set.of("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif");
    static final long MAX_BYTES = 20L * 1024 * 1024;
    static final Duration TICKET = Duration.ofMinutes(15);
    /** A file sent and not used is kept this long after its ticket. */
    static final Duration KEPT = Duration.ofHours(1);
    /** More than imaged ever takes: a claim older than this is of a request that died. */
    static final Duration CLAIM = Duration.ofSeconds(60);
    static final int PENDING_MAX = 20;

    private final Database db;
    private final Storage storage;
    private final Imaging imaging;
    private final Later later;
    private final InstantSource clock;

    public Uploads(Database db, Storage storage, Imaging imaging, Later later, InstantSource clock) {
        this.db = db;
        this.storage = storage;
        this.imaging = imaging;
        this.later = later;
        this.clock = clock;
    }

    public static String publicId(UUID id) {
        return Ids.publicId("up", id);
    }

    /** A ticket, in the caller's transaction (its permissions and limits checked there). */
    public Map<String, Object> ticket(DSLContext ctx, UUID user, String purpose, @Nullable String mimeType, @Nullable Long fileSize,
                                      @Nullable UUID event, @Nullable UUID chat) {
        if (!PURPOSES.contains(purpose)) throw ApiError.badRequest("unknown purpose");
        if (mimeType == null || !MIME_TYPES.contains(mimeType)) throw new ApiError(415, "bad_request", "JPEG, PNG, HEIC or WebP only");
        if (fileSize == null || fileSize <= 0) throw ApiError.badRequest("fileSize must be a positive integer");
        if (fileSize > MAX_BYTES) throw ApiError.tooLarge("at most 20 MB");
        Instant now = clock.instant();
        Database.lockPerson(ctx, user);
        if (ctx.fetchCount(UPLOADS, UPLOADS.USER_ID.eq(user).and(UPLOADS.USED.isFalse()).and(UPLOADS.EXPIRES_AT.gt(now))) >= PENDING_MAX) {
            throw ApiError.rateLimited(60);
        }
        UUID id = Ids.next();
        String key = "uploads/" + Ids.secret(16);
        ctx.insertInto(UPLOADS).set(UPLOADS.ID, id).set(UPLOADS.USER_ID, user).set(UPLOADS.PURPOSE, purpose).set(UPLOADS.MIME, mimeType)
                .set(UPLOADS.SIZE, fileSize).set(UPLOADS.EVENT_ID, event).set(UPLOADS.CHAT_ID, chat).set(UPLOADS.STORAGE_KEY, key)
                .set(UPLOADS.CREATED_AT, now).set(UPLOADS.EXPIRES_AT, now.plus(KEPT)).execute();
        Instant expires = now.plus(TICKET);
        Storage.Ticket ticket = storage.presign(key, mimeType, fileSize, expires);
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("uploadId", publicId(id));
        answer.put("uploadUrl", ticket.url());
        answer.put("headers", ticket.headers());
        answer.put("expiresAt", expires);
        return answer;
    }

    /** An upload claimed and made: its files, and what to do once the caller saved them or failed. */
    public record Claimed(UUID upload, List<Imaging.Made> files) {
        public List<String> keys() {
            return files.stream().map(Imaging.Made::key).toList();
        }
    }

    /**
     * Steps (a) and (b): {@code checks} runs in the claiming transaction (permissions and limits
     * of now); then imaging, outside it. A refused file uses the upload up and answers its refusal;
     * imaging busy gives the upload back and answers 503.
     */
    public Claimed claim(UUID user, @Nullable String publicId, String purpose, @Nullable UUID event, @Nullable UUID chat,
                         Imaging.Kind kind, Consumer<DSLContext> checks) {
        UUID id = publicId == null ? null : Ids.parse("up", publicId).orElse(null);
        if (id == null) throw ApiError.badRequest("unknown upload");
        List<String> outputs = outputs(purpose, kind);
        Instant now = clock.instant();
        UploadsRecord row = db.tx(ctx -> {
            checks.accept(ctx);
            UploadsRecord claimed = ctx.update(UPLOADS).set(UPLOADS.CLAIMED_AT, now).set(UPLOADS.OUTPUT_KEYS, outputs.toArray(String[]::new))
                    .where(UPLOADS.ID.eq(id)).and(UPLOADS.USER_ID.eq(user)).and(UPLOADS.PURPOSE.eq(purpose))
                    .and(event == null ? UPLOADS.EVENT_ID.isNull() : UPLOADS.EVENT_ID.eq(event))
                    .and(chat == null ? UPLOADS.CHAT_ID.isNull() : UPLOADS.CHAT_ID.eq(chat))
                    .and(UPLOADS.USED.isFalse()).and(UPLOADS.EXPIRES_AT.gt(now))
                    .and(UPLOADS.CLAIMED_AT.isNull().or(UPLOADS.CLAIMED_AT.lt(now.minus(CLAIM))))
                    .returning().fetchOne();
            if (claimed == null) throw why(ctx, id, user, purpose, event, chat, now);
            return claimed;
        });
        Imaging.Result result = imaging.make(row.getStorageKey(), row.getSize(), kind, outputs);
        return switch (result) {
            case Imaging.Done done -> new Claimed(id, done.files());
            case Imaging.Refused refused -> {
                db.txRun(ctx -> ctx.update(UPLOADS).set(UPLOADS.USED, true).where(UPLOADS.ID.eq(id)).execute());
                throw refused.error();
            }
            case Imaging.Busy busy -> {
                db.txRun(ctx -> ctx.update(UPLOADS).setNull(UPLOADS.CLAIMED_AT).where(UPLOADS.ID.eq(id)).execute());
                throw ApiError.unavailable("the image service is busy", 5);
            }
        };
    }

    private static ApiError why(DSLContext ctx, UUID id, UUID user, String purpose, @Nullable UUID event, @Nullable UUID chat, Instant now) {
        UploadsRecord row = ctx.selectFrom(UPLOADS).where(UPLOADS.ID.eq(id)).fetchOne();
        if (row == null || !row.getUserId().equals(user) || !row.getPurpose().equals(purpose)) return ApiError.badRequest("unknown upload");
        if (!java.util.Objects.equals(row.getEventId(), event) || !java.util.Objects.equals(row.getChatId(), chat)) {
            return ApiError.forbidden("the upload was made for something else");
        }
        if (row.getUsed() || !row.getExpiresAt().isAfter(now)) return ApiError.gone("expired", "upload expired or already used");
        return ApiError.conflict("conflict", "this upload is being used");
    }

    /** Step (c), in the caller's transaction: used, once. */
    public static void finish(DSLContext ctx, UUID upload) {
        ctx.update(UPLOADS).set(UPLOADS.USED, true).where(UPLOADS.ID.eq(upload)).execute();
    }

    /**
     * Step (c) did not happen (a limit reached meanwhile, the change refused): the files made go.
     * {@code usedUp}: the upload is used too (a refusal of it), else it can be named again.
     */
    public void abandon(Claimed claimed, boolean usedUp) {
        db.txRun(ctx -> {
            later.deleteFiles(claimed.keys());
            if (usedUp) ctx.update(UPLOADS).set(UPLOADS.USED, true).where(UPLOADS.ID.eq(claimed.upload())).execute();
            else ctx.update(UPLOADS).setNull(UPLOADS.CLAIMED_AT).set(UPLOADS.OUTPUT_KEYS, new String[0]).where(UPLOADS.ID.eq(claimed.upload())).execute();
        });
    }

    /**
     * Files nothing shows any more: deleted once the transaction that let them go commits, by a
     * job written in it (a machine stopping right after cannot leave them, C11 of the retention).
     */
    public void discard(@Nullable String... keys) {
        List<String> gone = new ArrayList<>();
        for (String key : keys) if (key != null) gone.add(key);
        if (!gone.isEmpty()) later.deleteFiles(gone);
    }

    public void discardAll(List<String> keys) {
        if (!keys.isEmpty()) later.deleteFiles(List.copyOf(keys));
    }

    /** The names of the files made, chosen before imaging: 128 random bits each. */
    static List<String> outputs(String purpose, Imaging.Kind kind) {
        String folder = switch (purpose) {
            case "profile-picture" -> "pictures";
            case "group-picture" -> "groups";
            case "event-cover" -> "covers";
            default -> "photos";
        };
        List<String> keys = new ArrayList<>();
        keys.add(folder + "/" + Ids.secret(16) + ".jpg");
        if (kind == Imaging.Kind.PHOTO) keys.add("thumbs/" + Ids.secret(16) + ".jpg");
        return keys;
    }

    /**
     * The cleaning (§8, cleanup.sweep): uploads never used past their hour, with their original
     * and the files named for them (a request that died between imaging and saving).
     */
    public int sweep() {
        Instant now = clock.instant();
        List<UploadsRecord> old = db.read(ctx -> ctx.selectFrom(UPLOADS).where(UPLOADS.USED.isFalse()).and(UPLOADS.EXPIRES_AT.lt(now))
                .orderBy(UPLOADS.EXPIRES_AT).limit(500).fetch());
        for (UploadsRecord upload : old) {
            List<String> keys = new ArrayList<>(List.of(upload.getOutputKeys()));
            keys.add(upload.getStorageKey());
            storage.delete(keys);
        }
        // Used ones are kept a day, for the 410 of a photo sent again; then they go too
        db.txRun(ctx -> {
            if (!old.isEmpty()) ctx.deleteFrom(UPLOADS).where(UPLOADS.ID.in(old.stream().map(UploadsRecord::getId).toList())).execute();
            ctx.deleteFrom(UPLOADS).where(UPLOADS.USED.isTrue()).and(UPLOADS.EXPIRES_AT.lt(now.minus(Duration.ofDays(1)))).execute();
        });
        return old.size();
    }
}
