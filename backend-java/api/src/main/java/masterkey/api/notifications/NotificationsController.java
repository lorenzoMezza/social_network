// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.notifications;

import java.util.Map;
import masterkey.api.web.Viewer;
import masterkey.store.Database;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** {@code /me/notifications}: the newest 50 and the unread count; reading them is cheap (§8). */
@RestController
@RequestMapping("/v1")
public class NotificationsController {

    private final Database db;
    private final Notifications notifications;

    public NotificationsController(Database db, Notifications notifications) {
        this.db = db;
        this.notifications = notifications;
    }

    @GetMapping("/me/notifications")
    public Map<String, Object> list(Viewer viewer) {
        return db.read(ctx -> notifications.list(ctx, viewer.id()));
    }

    /** Sent several times in a row while the panel is open: one UPDATE, no limit of its own. */
    @PostMapping("/me/notifications/read")
    public Map<String, Object> read(Viewer viewer) {
        db.txRun(ctx -> notifications.markRead(ctx, viewer.id()));
        return Map.of("unread", 0);
    }
}
