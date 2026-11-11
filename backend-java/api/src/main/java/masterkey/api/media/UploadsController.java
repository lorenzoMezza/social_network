// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.media;

import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.InstantSource;
import java.util.Map;
import java.util.UUID;
import masterkey.api.Limits;
import masterkey.api.chats.Chats;
import masterkey.api.events.AlbumsController;
import masterkey.api.events.EventsController;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.store.Database;
import masterkey.store.db.tables.records.ChatsRecord;
import masterkey.store.db.tables.records.EventsRecord;
import org.jspecify.annotations.Nullable;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.CacheControl;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/**
 * {@code POST /uploads}: refused here, before a byte is sent, when the purpose is not allowed or
 * a limit is reached; checked again when used. In development also the storage's side
 * ({@code /storage/…}) and the CDN's ({@code /media/…}).
 */
@RestController
@RequestMapping("/v1")
public class UploadsController {

    private final Database db;
    private final Uploads uploads;
    private final Storage storage;
    private final Limits limits;
    private final InstantSource clock;

    public UploadsController(Database db, Uploads uploads, Storage storage, Limits limits, InstantSource clock) {
        this.db = db;
        this.uploads = uploads;
        this.storage = storage;
        this.limits = limits;
        this.clock = clock;
    }

    @PostMapping("/uploads")
    public Map<String, Object> ticket(Viewer viewer, @RequestBody(required = false) @Nullable JsonNode raw) {
        Body body = Body.of(raw);
        String purpose = body.string("purpose");
        String eventText = body.string("eventId");
        String chatText = body.string("chatId");
        Long size;
        try {
            size = body.longInteger("fileSize");
        } catch (ApiError error) {
            throw ApiError.badRequest("fileSize must be a positive integer");
        }
        String mime = body.string("mimeType");
        Instant now = clock.instant();
        Long fileSize = size;
        return db.tx(ctx -> {
            UUID event = null, chat = null;
            if ("event-cover".equals(purpose) || "event-photo".equals(purpose)) {
                event = EventsController.id(eventText == null ? "" : eventText);
                EventsRecord found = EventsController.visible(ctx, event, viewer.id(), false);
                if ("event-cover".equals(purpose) && !found.getCreatorId().equals(viewer.id())) throw ApiError.forbidden("only the organizer sets the cover");
                if ("event-photo".equals(purpose)) {
                    // Refused here, before the file is sent at all
                    if (!AlbumsController.canPost(ctx, found, viewer.id(), now)) throw ApiError.forbidden("you can't add photos to this event");
                    Database.lockPerson(ctx, viewer.id());
                    AlbumsController.checkRoom(ctx, found, viewer.id(), now);
                }
            } else if (eventText != null) {
                throw ApiError.badRequest("eventId only for event uploads");
            }
            if ("group-picture".equals(purpose)) {
                ChatsRecord group = Chats.find(ctx, chatText == null ? "" : chatText, false);
                if (!"group".equals(group.getKind())) throw ApiError.notFound("chat not found");
                Chats.requireRankOf(ctx, group, viewer.id(), "admin", now);
                chat = group.getId();
            } else if (chatText != null) {
                throw ApiError.badRequest("chatId only for a group's picture");
            }
            limits.check(viewer.id(), Limits.Action.UPLOAD);
            return uploads.ticket(ctx, viewer.id(), purpose == null ? "" : purpose, mime, fileSize, event, chat);
        });
    }

    /** The storage's side in development: the file sent to its signed address. */
    @PutMapping("/storage/{name}")
    public Map<String, Object> receive(@PathVariable String name, @RequestParam String size, @RequestParam String expires,
                                       @RequestParam String signature, HttpServletRequest request) throws IOException {
        if (!(storage instanceof LocalStorage local)) throw ApiError.notFound("not found");
        if (!size.matches("[0-9]{1,12}") || !expires.matches("[0-9]{1,15}")) throw ApiError.forbidden("invalid or expired upload address");
        String announced = request.getHeader("Content-Length");
        long allowed = Long.parseLong(size);
        if (announced != null && announced.matches("[0-9]{1,15}") && Long.parseLong(announced) > Math.min(LocalStorage.MAX_BYTES, allowed + allowed / 10 + 1024)) {
            throw ApiError.tooLarge("bigger than announced");
        }
        local.receive(name, allowed, Long.parseLong(expires), signature, request.getInputStream());
        return Map.of("ok", true, "receivedAt", clock.instant());
    }

    /** The CDN's side in development: what was made, never an original. */
    @GetMapping("/media/{folder}/{file}")
    public ResponseEntity<Resource> media(@PathVariable String folder, @PathVariable String file) throws IOException {
        if (!(storage instanceof LocalStorage local)) throw ApiError.notFound("not found");
        Path path = local.served(folder + "/" + file);
        if (path == null) throw ApiError.notFound("no such file");
        // A file made never changes (a new picture gets a new name): kept for ever
        return ResponseEntity.ok().contentType(MediaType.IMAGE_JPEG).contentLength(Files.size(path))
                .cacheControl(CacheControl.maxAge(java.time.Duration.ofDays(365)).cachePublic().immutable())
                .header("X-Content-Type-Options", "nosniff").body(new FileSystemResource(path));
    }
}
