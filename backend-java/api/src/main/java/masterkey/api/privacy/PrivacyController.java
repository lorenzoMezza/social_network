// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.privacy;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.InstantSource;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import jakarta.servlet.http.HttpServletResponse;
import masterkey.api.Limits;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * The user's rights (API.md, Me; {@code routes/people.py}): deleting the account (GDPR art. 17)
 * and a copy of their data (art. 15, 20).
 */
@RestController
@RequestMapping("/v1")
public class PrivacyController {

    private final Erasure erasure;
    private final Export export;
    private final Limits limits;
    private final InstantSource clock;

    public PrivacyController(Erasure erasure, Export export, Limits limits, InstantSource clock) {
        this.erasure = erasure;
        this.export = export;
        this.limits = limits;
        this.clock = clock;
    }

    @DeleteMapping("/me")
    public ResponseEntity<Void> delete(Viewer viewer) {
        erasure.erase(viewer.id(), viewer.sub());
        return ResponseEntity.noContent().build();
    }

    /** A one-time link to the copy, opened in the browser: 10 minutes, once. No body (the app sends none). */
    @PostMapping("/me/export")
    public Map<String, Object> link(Viewer viewer) {
        limits.check(viewer.id(), Limits.Action.EXPORT);
        Export.Ticket ticket = export.ticket(viewer.id());
        Map<String, Object> answer = new LinkedHashMap<>();
        answer.put("url", ticket.url());
        answer.put("expiresAt", ticket.expiresAt());
        return answer;
    }

    /** The copy itself: no sign-in (the link is the key), once, as a JSON file. */
    @GetMapping("/exports/{token}")
    public void file(@PathVariable String token, HttpServletResponse response) throws IOException {
        UUID user = export.redeem(token);
        if (user == null) throw ApiError.gone("expired", "this link has expired: ask for a new copy in the app");
        Path file = Files.createTempFile("export-", ".json");
        try {
            if (!export.write(user, file)) throw ApiError.gone("expired", "this link has expired: ask for a new copy in the app");
            // The database is done with: now the network, as slowly as the phone wants
            response.setStatus(200);
            response.setContentType("application/json");
            response.setHeader("Content-Disposition", "attachment; filename=\"my-data-" + clock.instant().getEpochSecond() + ".json\"");
            response.setHeader("Cache-Control", "no-store");
            response.setHeader("Referrer-Policy", "no-referrer");
            response.setContentLengthLong(Files.size(file));
            try (InputStream in = Files.newInputStream(file); OutputStream out = response.getOutputStream()) {
                in.transferTo(out);
            }
        } finally {
            Files.deleteIfExists(file);
        }
    }
}
