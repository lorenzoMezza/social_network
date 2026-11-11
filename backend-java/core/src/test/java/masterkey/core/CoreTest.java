// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.core;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Test;

class CoreTest {

    @Test
    void bodyIsStrictAboutTypes() {
        Body body = Body.of(Json.parse("{\"a\":8.0,\"b\":\"8\",\"c\":true,\"d\":99999999999,\"e\":8,\"f\":\"x\\u0000y\"}"));
        assertThatThrownBy(() -> body.integer("a")).isInstanceOf(ApiError.class);
        assertThatThrownBy(() -> body.integer("b")).isInstanceOf(ApiError.class);
        assertThatThrownBy(() -> body.integer("c")).isInstanceOf(ApiError.class);
        assertThatThrownBy(() -> body.integer("d")).isInstanceOf(ApiError.class);
        assertThat(body.integer("e")).isEqualTo(8);
        assertThat(body.string("f")).isEqualTo("xy");
        assertThat(body.string("missing")).isNull();
        assertThatThrownBy(() -> Body.of(Json.parse("[1]"))).isInstanceOf(ApiError.class);
        assertThatThrownBy(() -> Json.parse("{\"a\":1,\"a\":2}")).isInstanceOf(ApiError.class);
        assertThatThrownBy(() -> Body.of(Json.parse("{\"x\":1e999}")).number("x")).isInstanceOf(ApiError.class);
    }

    @Test
    void loneSurrogatesAreRefused() {
        Body body = Body.of(Json.parse("{\"t\":\"a\\ud800b\"}"));
        assertThatThrownBy(() -> body.string("t")).isInstanceOf(ApiError.class);
    }

    @Test
    void textRules() {
        String rlo = String.valueOf((char) 0x202E);
        String zwj = String.valueOf((char) 0x200D);
        String nul = String.valueOf((char) 0);
        assertThat(Text.plain("a" + rlo + "b" + zwj + "c" + nul)).isEqualTo("ab" + zwj + "c");
        assertThat(Text.length("😀a")).isEqualTo(2);
        assertThat(Text.cut("😀😀😀", 2)).isEqualTo("😀😀");
        assertThat(Text.strip("  hi 　")).isEqualTo("hi");
        assertThat(Text.words("  a \t b  ")).isEqualTo("a b");
        assertThat(Text.handle("Müller Hans")).isEqualTo("mullerhans");
        assertThat(Text.handle("Алиса")).isEmpty();
        assertThat(Text.handle("..sara..m__")).isEqualTo("sara.m");
        assertThat(Text.usernameProblem("sara_m")).isEmpty();
        assertThat(Text.usernameProblem("sa")).isNotEmpty();
        assertThat(Text.usernameProblem("sara..m")).isNotEmpty();
        assertThat(Text.usernameProblem("sara\n")).isNotEmpty();
    }

    @Test
    void idsRoundTripOnlyInCanonicalForm() {
        UUID id = Ids.next();
        String pub = Ids.publicId("ev", id);
        assertThat(pub).startsWith("ev_").hasSize(25);
        assertThat(Ids.parse("ev", pub)).contains(id);
        assertThat(Ids.parse("msg", pub)).isEmpty();
        assertThat(Ids.parse("ev", "ev_1-1-1-1-1")).isEmpty();
        assertThat(id.version()).isEqualTo(7);
        assertThat(Ids.random().version()).isEqualTo(4);
        assertThat(Ids.secret(18)).hasSize(24).matches("[A-Za-z0-9_-]+");
    }

    @Test
    void timesHaveMilliseconds() {
        assertThat(Times.iso(Instant.parse("2026-10-15T18:00:00Z"))).isEqualTo("2026-10-15T18:00:00.000Z");
        assertThat(Times.parse("2026-10-15T20:00:00.123+02:00", "t")).isEqualTo(Instant.parse("2026-10-15T18:00:00.123Z"));
        assertThatThrownBy(() -> Times.parse("2026-10-15", "t")).isInstanceOf(ApiError.class);
        assertThat(Json.text(java.util.Map.of("b", 1, "a", 2))).isEqualTo("{\"a\":2,\"b\":1}");
    }

    @Test
    void distancesOnTheSphere() {
        double d = Geo.distance(41.9, 12.5, 41.9, 12.512);
        assertThat(d).isBetween(990.0, 1000.0);
        double[] a = Geo.xyz(41.9, 12.5);
        double[] b = Geo.xyz(41.9, 12.512);
        double chord = Math.sqrt(Math.pow(a[0] - b[0], 2) + Math.pow(a[1] - b[1], 2) + Math.pow(a[2] - b[2], 2));
        assertThat(Geo.chordToArc(chord)).isCloseTo(d, org.assertj.core.data.Offset.offset(0.001));
        assertThat(new Point(1, 2).toString()).doesNotContain("1").doesNotContain("2");
    }
}
