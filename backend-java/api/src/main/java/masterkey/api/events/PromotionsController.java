// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.events;

import static masterkey.store.db.Tables.EVENTS;
import static masterkey.store.db.Tables.PROMOTIONS;

import java.time.Instant;
import java.time.InstantSource;
import java.util.Map;
import java.util.UUID;
import masterkey.api.money.Promotions;
import masterkey.api.money.Stores;
import masterkey.api.web.Viewer;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.store.Database;
import masterkey.store.db.tables.records.EventsRecord;
import org.jspecify.annotations.Nullable;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/**
 * Promotions of events (API.md, Promotions; {@code routes/promotions.py}): the price list, a
 * quote, starting or changing one, stopping it. Only the organizer, never a flash event.
 */
@RestController
@RequestMapping("/v1")
public class PromotionsController {

    private final Database db;
    private final EventViews views;
    private final EventNotifier notifier;
    private final Stores stores;
    private final InstantSource clock;

    public PromotionsController(Database db, EventViews views, EventNotifier notifier, Stores stores, InstantSource clock) {
        this.db = db;
        this.views = views;
        this.notifier = notifier;
        this.stores = stores;
        this.clock = clock;
    }

    @GetMapping("/promotions/prices")
    public Map<String, Object> prices(Viewer viewer) {
        return Promotions.priceList(stores.devPurchases());
    }

    @GetMapping("/events/{eventId}/promotion/quote")
    public Map<String, Object> quote(Viewer viewer, @PathVariable String eventId, @RequestParam(required = false) @Nullable String radius) {
        UUID id = EventsController.id(eventId);
        int metres = metres(radius);
        Instant now = clock.instant();
        return db.read(ctx -> {
            EventsRecord event = EventsController.own(ctx, id, viewer.id());
            Promotions.promotable(event, now);
            return Promotions.quote(event, ctx.selectFrom(PROMOTIONS).where(PROMOTIONS.EVENT_ID.eq(id)).fetchOne(), metres, now).view();
        });
    }

    private static int metres(@Nullable String radius) {
        if (radius == null || !radius.matches("[0-9]{1,6}")) throw ApiError.badRequest("radius: metres");
        return Integer.parseInt(radius);
    }

    @PutMapping("/events/{eventId}/promotion")
    public Map<String, Object> promote(Viewer viewer, @PathVariable String eventId, @RequestBody(required = false) @Nullable JsonNode raw) {
        UUID id = EventsController.id(eventId);
        Body body = Body.of(raw);
        Integer radius;
        Integer daily;
        try {
            radius = body.integer("radius");
            daily = body.integer("daily");
        } catch (ApiError wrong) {
            radius = null;
            daily = null;
        }
        if (radius == null || (body.has("daily") && !body.isNull("daily") && daily == null)) {
            throw ApiError.badRequest("radius: metres; daily: the price shown, in credits");
        }
        int metres = radius;
        Integer shown = daily;
        Instant now = clock.instant();
        return db.tx(ctx -> {
            // The order of money's locks: the person, the event, the promotion, the wallet
            Database.lockPerson(ctx, viewer.id());
            EventsController.own(ctx, id, viewer.id());
            EventsRecord event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).forUpdate().fetchOne();
            if (event == null) throw ApiError.notFound("event not found");
            int reachBefore = Promotions.reachNow(event, Promotions.locked(ctx, id), now);
            Promotions.promote(ctx, event, metres, shown, now);
            // On the lists and maps of everyone now within its radius
            notifier.changed(id, reachBefore);
            return views.detail(ctx, viewer.id(), event, now);
        });
    }

    @DeleteMapping("/events/{eventId}/promotion")
    public Map<String, Object> stop(Viewer viewer, @PathVariable String eventId) {
        UUID id = EventsController.id(eventId);
        Instant now = clock.instant();
        return db.tx(ctx -> {
            Database.lockPerson(ctx, viewer.id());
            EventsController.own(ctx, id, viewer.id());
            EventsRecord event = ctx.selectFrom(EVENTS).where(EVENTS.ID.eq(id)).forUpdate().fetchOne();
            if (event == null) throw ApiError.notFound("event not found");
            Promotions.stop(ctx, event);
            return views.detail(ctx, viewer.id(), event, now);
        });
    }
}
