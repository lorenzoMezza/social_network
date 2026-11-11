// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpRequest;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** Promotions, the wallet and purchases against the whole server (routes/promotions.py), with test top-ups. */
class MoneyTest {

    static final TestServer server = new TestServer(Map.of("DEV_TOOLS", "1"));

    @AfterAll
    static void stop() {
        server.close();
    }

    record User(String token, String id) {
    }

    static User user(String sub) {
        String token = server.token(sub);
        return new User(token, server.get("/v1/me", token).body().get("id").stringValue());
    }

    static String create(User owner, masterkey.core.Point at, java.time.Instant start, java.time.Instant end) {
        var answer = server.json("POST", "/v1/events", owner.token(), event(at, start, end));
        assertThat(answer.status()).as(answer.raw().body()).isEqualTo(201);
        return answer.body().get("id").stringValue();
    }

    // Not EventsAndChatsTest's: touching that class would start its own server
    static String event(masterkey.core.Point at, java.time.Instant start, java.time.Instant end) {
        return "{\"title\":\"Mercato\",\"description\":\"Bancarelle\",\"categories\":[\"sales\"],"
                + "\"location\":{\"latitude\":" + at.latitude() + ",\"longitude\":" + at.longitude() + ",\"address\":\"Piazza\"},"
                + "\"dates\":{\"startDate\":\"" + start + "\",\"endDate\":\"" + end + "\"}}";
    }

    static java.time.Instant inHours(long hours) {
        return java.time.Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).plus(hours, java.time.temporal.ChronoUnit.HOURS);
    }

    static String purchase(String product, String token) {
        return "{\"platform\":\"dev\",\"productId\":\"" + product + "\",\"purchaseToken\":\"" + token + "\"}";
    }

    @Test
    void aPromotionIsPaidStoppedAndGivenBackWhenCancelled() {
        var host = user("money-host");
        String id = create(host, masterkey.core.Geo.offset(45.46, 9.19, 0, 0), inHours(72), inHours(74));
        JsonNode prices = server.get("/v1/promotions/prices", host.token()).body();
        assertThat(prices.get("devPurchases").booleanValue()).isTrue();
        assertThat(prices.get("packs").size()).isEqualTo(7);
        assertThat(prices.get("tiers").get(0).get("daily").intValue()).isEqualTo(99);

        JsonNode quote = server.get("/v1/events/" + id + "/promotion/quote?radius=1000", host.token()).body();
        int daily = quote.get("daily").intValue();
        int first = quote.get("firstCharge").intValue();
        // About 3 days to the end: 4 days, 20% off
        assertThat(daily).isEqualTo(79);
        assertThat(first).isEqualTo(79);
        assertThat(server.get("/v1/events/" + id + "/promotion/quote?radius=1234", host.token()).status()).isEqualTo(400);
        var other = user("money-other");
        assertThat(server.get("/v1/events/" + id + "/promotion/quote?radius=1000", other.token()).status()).isEqualTo(403);

        // Nothing in the wallet: 402 with what is due
        var poor = server.json("PUT", "/v1/events/" + id + "/promotion", host.token(), "{\"radius\":1000,\"daily\":" + daily + "}");
        assertThat(poor.status()).isEqualTo(402);
        assertThat(poor.body().get("code").stringValue()).isEqualTo("insufficient_balance");
        assertThat(poor.body().get("details").get(0).stringValue()).isEqualTo(Integer.toString(first));

        // A top-up, once per transaction of the store
        var bought = server.json("POST", "/v1/me/wallet/purchases", host.token(), purchase("promo.credits.099", "dev-1"));
        assertThat(bought.status()).as(bought.raw().body()).isEqualTo(200);
        assertThat(bought.body().get("credited").booleanValue()).isTrue();
        assertThat(bought.body().get("balance").intValue()).isEqualTo(99);
        var again = server.json("POST", "/v1/me/wallet/purchases", host.token(), purchase("promo.credits.099", "dev-1"));
        assertThat(again.body().get("credited").booleanValue()).isFalse();
        assertThat(again.body().get("balance").intValue()).isEqualTo(99);
        assertThat(server.json("POST", "/v1/me/wallet/purchases", other.token(), purchase("promo.credits.099", "dev-1")).body()
                .get("code").stringValue()).isEqualTo("already");
        assertThat(server.json("POST", "/v1/me/wallet/purchases", host.token(), purchase("promo.credits.098", "dev-2")).status()).isEqualTo(400);
        assertThat(server.json("POST", "/v1/me/wallet/purchases", host.token(),
                "{\"platform\":\"ios\",\"productId\":\"promo.credits.099\",\"purchaseToken\":\"x\"}").status()).isEqualTo(503);

        // The app showed another price: nothing charged, the new one in details
        var changed = server.json("PUT", "/v1/events/" + id + "/promotion", host.token(), "{\"radius\":1000,\"daily\":50}");
        assertThat(changed.status()).isEqualTo(409);
        assertThat(changed.body().get("details").get(0).stringValue()).isEqualTo(Integer.toString(daily));

        var promoted = server.json("PUT", "/v1/events/" + id + "/promotion", host.token(), "{\"radius\":1000,\"daily\":" + daily + "}");
        assertThat(promoted.status()).as(promoted.raw().body()).isEqualTo(200);
        assertThat(promoted.body().get("promotion").get("status").stringValue()).isEqualTo("live");
        assertThat(promoted.body().get("promotion").get("charged").intValue()).isEqualTo(first);
        assertThat(promoted.body().get("sponsored").booleanValue()).isTrue();
        assertThat(promoted.body().get("reach").intValue()).isEqualTo(1000);
        // Others never see the organizer's promotion
        assertThat(server.get("/v1/events/" + id, other.token()).body().has("promotion")).isFalse();

        JsonNode wallet = server.get("/v1/me/wallet", host.token()).body();
        assertThat(wallet.get("balance").intValue()).isEqualTo(99 - first);
        assertThat(wallet.get("entries").findValuesAsString("kind")).containsExactly("day", "purchase");
        assertThat(wallet.get("entries").get(0).get("event").get("id").stringValue()).isEqualTo(id);
        assertThat(wallet.get("accountToken").stringValue()).hasSize(36);

        var stopped = server.send(HttpRequest.newBuilder(server.uri("/v1/events/" + id + "/promotion"))
                .header("Authorization", "Bearer " + host.token()).DELETE());
        assertThat(stopped.body().get("promotion").get("status").stringValue()).isEqualTo("stopped");
        // Paid time goes on being shown
        assertThat(stopped.body().get("sponsored").booleanValue()).isTrue();

        // Cancelled: the time paid and not used comes back, never the first 6 hours (18 h of 79 a day)
        server.send(HttpRequest.newBuilder(server.uri("/v1/events/" + id)).header("Authorization", "Bearer " + host.token()).DELETE());
        JsonNode after = server.get("/v1/me/wallet", host.token()).body();
        assertThat(after.get("entries").findValuesAsString("kind")).containsExactly("refund", "day", "purchase");
        assertThat(after.get("entries").get(0).get("amount").intValue()).isEqualTo(59);
        assertThat(after.get("balance").intValue()).isEqualTo(99 - first + 59);
        assertThat(server.json("PUT", "/v1/events/" + id + "/promotion", host.token(), "{\"radius\":1000}").status()).isEqualTo(410);
    }

    @Test
    void theStoresNoticesNeedTheStores() {
        // Apple's notices need Apple's configuration; Google's the secret
        assertThat(server.send(HttpRequest.newBuilder(server.uri("/v1/store/apple/notifications")).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{\"signedPayload\":\"a.b.c\"}"))).status()).isEqualTo(503);
        assertThat(server.send(HttpRequest.newBuilder(server.uri("/v1/store/google/notifications?secret=x")).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString("{}"))).status()).isEqualTo(403);
    }
}
