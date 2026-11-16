// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static org.assertj.core.api.Assertions.assertThat;

import java.awt.Color;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** Uploads end to end (API.md, Uploads; JAVA-BACKEND.md §19) with the imaging of development. */
class MediaTest {

    static final TestServer server = new TestServer();
    static final String SECRET = "GPS 41.9028 12.4964 my secret comment";

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

    /** A JPEG with a comment segment inside (the kind of thing a phone leaves in a file). */
    static byte[] jpeg(int width, int height) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        g.setColor(Color.ORANGE);
        g.fillRect(0, 0, width, height);
        g.dispose();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "jpeg", out);
        byte[] plain = out.toByteArray();
        byte[] comment = SECRET.getBytes(StandardCharsets.US_ASCII);
        ByteArrayOutputStream with = new ByteArrayOutputStream();
        with.write(plain, 0, 2);
        with.write(0xFF);
        with.write(0xFE);
        with.write((comment.length + 2) >> 8);
        with.write((comment.length + 2) & 0xff);
        with.write(comment);
        with.write(plain, 2, plain.length - 2);
        return with.toByteArray();
    }

    /** A ticket and the file sent to its address: the upload's id. */
    static String upload(User user, String purpose, byte[] file, String extra) throws Exception {
        var ticket = server.json("POST", "/v1/uploads", user.token(),
                "{\"purpose\":\"" + purpose + "\",\"mimeType\":\"image/jpeg\",\"fileSize\":" + file.length + extra + "}");
        assertThat(ticket.status()).as(ticket.raw().body()).isEqualTo(200);
        String url = ticket.body().get("uploadUrl").stringValue();
        HttpResponse<String> sent = server.http.send(HttpRequest.newBuilder(URI.create(url)).header("Content-Type", "image/jpeg")
                .PUT(HttpRequest.BodyPublishers.ofByteArray(file)).build(), HttpResponse.BodyHandlers.ofString());
        assertThat(sent.statusCode()).as(sent.body()).isEqualTo(200);
        return ticket.body().get("uploadId").stringValue();
    }

    static byte[] fetch(String url) throws Exception {
        return server.http.send(HttpRequest.newBuilder(URI.create(url)).GET().build(), HttpResponse.BodyHandlers.ofByteArray()).body();
    }

    @Test
    void aProfilePictureIsMadeAgainWithNothingOfTheOriginalInside() throws Exception {
        User sara = user("md-sara");
        String upload = upload(sara, "profile-picture", jpeg(1200, 800), "");
        var me = server.json("PUT", "/v1/me/picture", sara.token(), "{\"uploadId\":\"" + upload + "\"}");
        assertThat(me.status()).as(me.raw().body()).isEqualTo(200);
        String url = me.body().get("pictureUrl").stringValue();
        byte[] made = fetch(url);
        BufferedImage picture = ImageIO.read(new ByteArrayInputStream(made));
        assertThat(picture.getWidth()).isEqualTo(512);
        assertThat(picture.getHeight()).isEqualTo(512);
        assertThat(new String(made, StandardCharsets.ISO_8859_1)).doesNotContain("my secret comment");
        // Used once: named again it is 410, as the app expects
        assertThat(server.json("PUT", "/v1/me/picture", sara.token(), "{\"uploadId\":\"" + upload + "\"}").status()).isEqualTo(410);
        assertThat(server.send(HttpRequest.newBuilder(server.uri("/v1/me/picture")).header("Authorization", "Bearer " + sara.token()).DELETE())
                .body().get("pictureUrl").isNull()).isTrue();
    }

    @Test
    void whatIsNotAnImageIsRefusedAndTheUploadUsedUp() throws Exception {
        User luca = user("md-luca");
        byte[] text = "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>".getBytes(StandardCharsets.UTF_8);
        String upload = upload(luca, "profile-picture", text, "");
        var refused = server.json("PUT", "/v1/me/picture", luca.token(), "{\"uploadId\":\"" + upload + "\"}");
        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.body().get("code").stringValue()).isEqualTo("moderated");
        assertThat(server.json("PUT", "/v1/me/picture", luca.token(), "{\"uploadId\":\"" + upload + "\"}").status()).isEqualTo(410);
        assertThat(server.json("POST", "/v1/uploads", luca.token(), "{\"purpose\":\"profile-picture\",\"mimeType\":\"image/gif\",\"fileSize\":10}").status())
                .isEqualTo(415);
        assertThat(server.json("POST", "/v1/uploads", luca.token(), "{\"purpose\":\"profile-picture\",\"mimeType\":\"image/jpeg\",\"fileSize\":30000000}").status())
                .isEqualTo(413);
        assertThat(server.json("POST", "/v1/uploads", luca.token(), "{\"purpose\":\"selfie\",\"mimeType\":\"image/jpeg\",\"fileSize\":10}").status())
                .isEqualTo(400);
    }

    @Test
    void anAlbumTakesTheSamePhotoOnceAndAnEventItsCover() throws Exception {
        User host = user("md-host"), guest = user("md-guest");
        JsonNode event = server.json("POST", "/v1/events", host.token(), "{\"title\":\"Concerto\",\"description\":\"Live\",\"categories\":[\"music\"],"
                + "\"location\":{\"latitude\":41.6,\"longitude\":12.2},\"dates\":{\"startDate\":\"" + Instant.now().minus(1, ChronoUnit.MINUTES)
                + "\",\"endDate\":\"" + Instant.now().plus(2, ChronoUnit.HOURS) + "\"}}").body();
        String id = event.get("id").stringValue();
        // Not going: no ticket for its album
        assertThat(server.json("POST", "/v1/uploads", guest.token(), "{\"purpose\":\"event-photo\",\"mimeType\":\"image/jpeg\",\"fileSize\":100,\"eventId\":\""
                + id + "\"}").status()).isEqualTo(403);
        server.json("PUT", "/v1/events/" + id + "/followers/me", guest.token(), "");
        String upload = upload(guest, "event-photo", jpeg(3000, 2000), ",\"eventId\":\"" + id + "\"");
        HttpRequest.Builder add = HttpRequest.newBuilder(server.uri("/v1/events/" + id + "/photos")).header("Authorization", "Bearer " + guest.token())
                .header("Content-Type", "application/json").header("Idempotency-Key", "photo-1")
                .POST(HttpRequest.BodyPublishers.ofString("{\"uploadId\":\"" + upload + "\"}"));
        var added = server.send(add);
        assertThat(added.status()).as(added.raw().body()).isEqualTo(201);
        assertThat(added.body().get("width").intValue()).isEqualTo(2048);
        assertThat(added.body().get("author").get("id").stringValue()).isEqualTo(guest.id());
        var again = server.send(add);
        assertThat(again.status()).isEqualTo(201);
        assertThat(again.body().get("id").stringValue()).isEqualTo(added.body().get("id").stringValue());
        BufferedImage thumb = ImageIO.read(new ByteArrayInputStream(fetch(added.body().get("thumbUrl").stringValue())));
        assertThat(thumb.getWidth()).isEqualTo(400);
        JsonNode album = server.get("/v1/events/" + id + "/photos", host.token()).body();
        assertThat(album.get("total").intValue()).isEqualTo(1);
        assertThat(album.get("room").intValue()).isEqualTo(200);
        assertThat(server.get("/v1/me/notifications", host.token()).body().get("items").findValuesAsString("kind")).contains("album.photos");
        // The cover, made by the organizer
        String cover = upload(host, "event-cover", jpeg(800, 600), ",\"eventId\":\"" + id + "\"");
        var changed = server.json("PATCH", "/v1/events/" + id, host.token(), "{\"images\":[{\"uploadId\":\"" + cover + "\"}]}");
        assertThat(changed.status()).as(changed.raw().body()).isEqualTo(200);
        String coverUrl = changed.body().get("imageUrls").get(0).stringValue();
        var kept = server.json("PATCH", "/v1/events/" + id, host.token(), "{\"images\":[{\"url\":\"" + coverUrl + "\"}]}");
        assertThat(kept.body().get("imageUrls").get(0).stringValue()).isEqualTo(coverUrl);
        assertThat(server.json("PATCH", "/v1/events/" + id, host.token(), "{\"images\":[{\"url\":\"https://elsewhere/x.jpg\"}]}").status()).isEqualTo(400);
        assertThat(server.send(HttpRequest.newBuilder(server.uri("/v1/events/" + id + "/photos/" + added.body().get("id").stringValue()))
                .header("Authorization", "Bearer " + host.token()).DELETE()).status()).isEqualTo(204);
        assertThat(server.get("/v1/events/" + id + "/photos", host.token()).body().get("total").intValue()).isZero();
    }
}
