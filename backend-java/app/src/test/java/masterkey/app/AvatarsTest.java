// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.app;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.http.HttpRequest;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/** Avatars against the real catalog of avatar-server/library. */
class AvatarsTest {

    static final TestServer server = new TestServer();

    @AfterAll
    static void stop() {
        server.close();
    }

    @Test
    void aPresetUntilOneIsSavedAndOnlyWhatTheCatalogHas() {
        String token = server.token("av-sara");
        String id = server.get("/v1/me", token).body().get("id").stringValue();
        var first = server.get("/v1/users/" + id + "/avatar", token);
        assertThat(first.status()).isEqualTo(200);
        assertThat(first.body().get("source").stringValue()).isEqualTo("preset");
        assertThat(first.body().get("avatar").get("format").stringValue()).isEqualTo("masterkey.avatar");
        assertThat(first.body().get("mapAvatar").isNull()).isTrue();
        String tag = first.header("ETag");
        assertThat(tag).isNotNull();
        var same = server.send(HttpRequest.newBuilder(server.uri("/v1/users/" + id + "/avatar")).header("Authorization", "Bearer " + token)
                .header("If-None-Match", tag).GET());
        assertThat(same.status()).isEqualTo(304);
        // The preset itself is a valid avatar: saved, it is theirs
        JsonNode preset = first.body().get("avatar");
        var saved = server.json("PUT", "/v1/me/avatar", token, preset.toString());
        assertThat(saved.status()).as(saved.raw().body()).isEqualTo(200);
        assertThat(saved.body().get("source").stringValue()).isEqualTo("saved");
        assertThat(saved.body().get("avatarVersion").intValue()).isEqualTo(1);
        assertThat(server.get("/v1/me", token).body().get("avatarVersion").intValue()).isEqualTo(1);
        // An item that is not in the catalog, a colour that is not one
        ObjectNode bad = (ObjectNode) preset.deepCopy();
        ((ObjectNode) bad.get("wearables")).put("hat", "nowhere:nothing");
        ((ObjectNode) bad.get("colors")).put("skin", "pink");
        var refused = server.json("PUT", "/v1/me/avatar", token, bad.toString());
        assertThat(refused.status()).isEqualTo(400);
        assertThat(refused.body().get("code").stringValue()).isEqualTo("invalid_avatar");
        assertThat(refused.body().get("details").size()).isEqualTo(2);
    }
}
