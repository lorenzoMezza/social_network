// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import static masterkey.presence.Harness.ROME_LAT;
import static masterkey.presence.Harness.ROME_LON;
import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Point;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/** The rules of realtime.py and API.md, Presence rules, on the Java engine. */
class EngineTest {

    final Harness h = new Harness();

    @Test
    void twoVisiblePeopleSeeEachOtherPrecisely() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        assertThat(h.delivery.last(sa, "presence.snapshot").get("people")).isEmpty();
        h.east(b, sb, Mode.VISIBLE, 50);
        JsonNode snapshot = h.delivery.last(sb, "presence.snapshot");
        assertThat(snapshot.get("people")).hasSize(1);
        JsonNode seen = snapshot.get("people").get(0);
        assertThat(seen.get("userId").stringValue()).isEqualTo(Ids.publicId("usr", a));
        assertThat(seen.get("precision").stringValue()).isEqualTo("precise");
        assertThat(seen.get("heading").intValue()).isEqualTo(90);
        assertThat(seen.get("speed").doubleValue()).isEqualTo(1.2);
        assertThat(seen.get("moving").booleanValue()).isTrue();
        assertThat(seen.get("user").get("id").stringValue()).isEqualTo(Ids.publicId("usr", a));
        assertThat(seen.get("position").get("latitude").doubleValue()).isEqualTo(Math.round(ROME_LAT * 1e6) / 1e6);
        // A sees B without waiting for their own round
        h.tick();
        assertThat(h.delivery.model(sa).people).containsOnlyKeys(Ids.publicId("usr", b));
        assertThat(h.delivery.model(sa).audience).isEqualTo(1);
        assertThat(h.delivery.model(sb).audience).isEqualTo(1);
        h.checkModels();
    }

    @Test
    void approximatePeopleAreShownByTheirAreaPointOnly() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.APPROXIMATE, 40);
        h.tick();
        JsonNode record = h.delivery.model(sa).people.get(Ids.publicId("usr", b));
        assertThat(record.get("precision").stringValue()).isEqualTo("area");
        assertThat(record.get("heading").isNull()).isTrue();
        assertThat(record.get("speed").isNull()).isTrue();
        assertThat(record.get("moving").isNull()).isTrue();
        Point real = Geo.offset(ROME_LAT, ROME_LON, 40, 0);
        double lat = record.get("position").get("latitude").doubleValue();
        double lon = record.get("position").get("longitude").doubleValue();
        assertThat(Geo.distance(lat, lon, real.latitude(), real.longitude())).isGreaterThan(0.5).isLessThan(320);
        // The Approximate viewer sees the Visible one by area too
        JsonNode other = h.delivery.model(sb).people.get(Ids.publicId("usr", a));
        assertThat(other.get("precision").stringValue()).isEqualTo("area");
        // Walking inside the same square changes nothing that is sent
        h.delivery.clear();
        h.east(b, sb, Mode.APPROXIMATE, 45);
        h.tick();
        assertThat(h.delivery.of(sa, "presence.delta")).isEmpty();
        h.checkModels();
    }

    @Test
    void theAreaPointStaysForTheDayAndMovesTheNextDay() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.APPROXIMATE, 30);
        h.tick();
        JsonNode first = h.delivery.model(sa).people.get(Ids.publicId("usr", b)).get("position");
        h.advance(Duration.ofHours(24));
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.APPROXIMATE, 30);
        h.tick();
        JsonNode next = h.delivery.model(sa).people.get(Ids.publicId("usr", b)).get("position");
        assertThat(next).isNotEqualTo(first);
    }

    @Test
    void invisibleLeavesEveryMapAndGetsAnEmptySnapshot() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        h.east(b, sb, Mode.INVISIBLE, 10);
        assertThat(h.delivery.last(sb, "presence.snapshot").get("people")).isEmpty();
        h.tick();
        assertThat(h.delivery.model(sa).people).isEmpty();
        assertThat(h.engine.near(a, List.of(b))).containsEntry(b, false);
        h.checkModels();
    }

    @Test
    void leavingTheMapSendsWhoWentToBoth() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        h.leave(b, sb);
        h.tick();
        assertThat(h.delivery.model(sa).people).isEmpty();
        assertThat(h.delivery.model(sb).people).isEmpty();
        assertThat(h.delivery.model(sa).audience).isZero();
        h.checkModels();
    }

    @Test
    void aKeepaliveThatDoesNotMoveSendsNothing() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        h.delivery.clear();
        h.advance(Duration.ofSeconds(15));
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        assertThat(h.delivery.of(sa, "presence.delta")).isEmpty();
        h.east(b, sb, Mode.VISIBLE, 14);
        h.tick();
        assertThat(h.delivery.of(sa, "presence.delta")).hasSize(1);
        assertThat(h.delivery.last(sa, "presence.delta").get("people").get(0).has("user")).isFalse();
    }

    @Test
    void numbersOutOfTheirRangeReachNobody() {
        // The gateway turns them into null; the engine must then send null, never a number
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        Point point = Geo.offset(ROME_LAT, ROME_LON, 10, 0);
        h.send(b, sb, new ClientFrame.PresenceUpdate(null, Mode.VISIBLE,
                new ClientFrame.Position(point.latitude(), point.longitude(), null, null, null, null)));
        h.tick();
        JsonNode record = h.delivery.model(sa).people.get(Ids.publicId("usr", b));
        assertThat(record.get("heading").isNull()).isTrue();
        assertThat(record.get("speed").isNull()).isTrue();
        assertThat(record.get("moving").isNull()).isTrue();
    }

    @Test
    void aBlockBreaksThePairAtOnceBothWays() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        h.directory.block(a, b);
        h.engine.relationChanged(a, b);
        h.settle();
        h.tick();
        assertThat(h.delivery.model(sa).people).isEmpty();
        assertThat(h.delivery.model(sb).people).isEmpty();
        assertThat(h.engine.near(a, List.of(b))).containsEntry(b, false);
        // And they do not come back with the next rounds
        h.engine.rematchSome(10);
        h.tick();
        assertThat(h.delivery.model(sa).people).isEmpty();
        h.checkModels();
    }

    @Test
    void farPeopleAreNotShownButWithinOneKilometreAre() {
        UUID a = h.user(), b = h.user(), c = h.user();
        SocketId sa = h.open(a), sb = h.open(b), sc = h.open(c);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 990);
        h.east(c, sc, Mode.VISIBLE, 1010);
        h.tick();
        assertThat(h.delivery.model(sa).people).containsOnlyKeys(Ids.publicId("usr", b));
        assertThat(h.engine.near(a, List.of(b, c))).isEqualTo(Map.of(b, true, c, false));
    }

    @Test
    void theCapKeepsConnectionsFirstThenTheNearest() {
        Harness small = new Harness(PresenceConfig.of(Harness.KEY, 340).withMaxShown(3));
        UUID viewer = small.user(), friend = small.user();
        small.directory.connect(viewer, friend);
        SocketId sv = small.open(viewer);
        small.east(viewer, sv, Mode.VISIBLE, 0);
        UUID[] crowd = new UUID[6];
        for (int i = 0; i < crowd.length; i++) {
            crowd[i] = small.user();
            small.east(crowd[i], small.open(crowd[i]), Mode.VISIBLE, 10 + i * 10);
        }
        SocketId sf = small.open(friend);
        small.east(friend, sf, Mode.VISIBLE, 900);
        small.tick();
        assertThat(small.delivery.model(sv).people).containsOnlyKeys(
                Ids.publicId("usr", friend), Ids.publicId("usr", crowd[0]), Ids.publicId("usr", crowd[1]));
        small.checkModels();
    }

    @Test
    void someoneAlreadyShownKeepsTheirPlaceAgainstOneOnlyABitNearer() {
        Harness small = new Harness(PresenceConfig.of(Harness.KEY, 340).withMaxShown(1));
        UUID viewer = small.user(), first = small.user(), second = small.user();
        SocketId sv = small.open(viewer), s1 = small.open(first), s2 = small.open(second);
        small.east(viewer, sv, Mode.VISIBLE, 0);
        small.east(first, s1, Mode.VISIBLE, 100);
        small.tick();
        small.east(second, s2, Mode.VISIBLE, 90);
        small.engine.rematchNow(viewer);
        small.tick();
        // 90 m against 100 m shown: 100 × 0.85 = 85 still wins
        assertThat(small.delivery.model(sv).people).containsOnlyKeys(Ids.publicId("usr", first));
        small.east(second, s2, Mode.VISIBLE, 80);
        small.engine.rematchNow(viewer);
        small.tick();
        assertThat(small.delivery.model(sv).people).containsOnlyKeys(Ids.publicId("usr", second));
        small.checkModels();
    }

    @Test
    void aGestureFromSomeoneNotShownFirstBringsThemThenPlays() {
        Harness small = new Harness(PresenceConfig.of(Harness.KEY, 340).withMaxShown(1));
        UUID target = small.user(), near = small.user(), waver = small.user();
        SocketId st = small.open(target), sn = small.open(near), sw = small.open(waver);
        small.east(target, st, Mode.VISIBLE, 0);
        small.east(near, sn, Mode.VISIBLE, 5);
        small.east(waver, sw, Mode.VISIBLE, 300);
        small.tick();
        assertThat(small.delivery.model(st).people).containsOnlyKeys(Ids.publicId("usr", near));
        small.send(waver, sw, new ClientFrame.Gesture("\"g1\"", target, "wave"));
        JsonNode ack = small.delivery.last(sw, "ack");
        assertThat(ack.get("ref").stringValue()).isEqualTo("g1");
        // The delta at once, the gesture 0.3 s later
        assertThat(small.delivery.model(st).people).containsOnlyKeys(Ids.publicId("usr", waver));
        assertThat(small.delivery.of(st, "gesture")).isEmpty();
        small.advance(Duration.ofMillis(300));
        JsonNode gesture = small.delivery.last(st, "gesture");
        assertThat(gesture.get("from").stringValue()).isEqualTo(Ids.publicId("usr", waver));
        assertThat(gesture.get("gesture").stringValue()).isEqualTo("wave");
        // Again within 2 s: too soon
        small.send(waver, sw, new ClientFrame.Gesture(null, target, "dab"));
        assertThat(small.delivery.last(sw, "error").get("code").stringValue()).isEqualTo("rate_limited");
        // A minute later they are no longer pinned on the map
        small.advance(Duration.ofSeconds(61));
        small.east(target, st, Mode.VISIBLE, 0);
        small.east(near, sn, Mode.VISIBLE, 5);
        small.east(waver, sw, Mode.VISIBLE, 300);
        small.engine.rematchNow(target);
        small.tick();
        assertThat(small.delivery.model(st).people).containsOnlyKeys(Ids.publicId("usr", near));
        small.checkModels();
    }

    @Test
    void aGestureToSomeoneFarIsForbidden() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 2000);
        h.send(a, sa, new ClientFrame.Gesture("1", b, "wave"));
        JsonNode error = h.delivery.last(sa, "error");
        assertThat(error.get("code").stringValue()).isEqualTo("forbidden");
        assertThat(error.get("ref").intValue()).isEqualTo(1);
    }

    @Test
    void aBroadcastReachesWhoHasTheSenderOnTheMap() {
        UUID a = h.user(), b = h.user(), c = h.user();
        SocketId sa = h.open(a), sb = h.open(b), sc = h.open(c);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 20);
        h.east(c, sc, Mode.VISIBLE, 3000);
        h.send(a, sa, new ClientFrame.Broadcast("\"x\"", "  Ciao <b>a tutti</b>  "));
        assertThat(h.delivery.last(sa, "ack").get("recipients").intValue()).isEqualTo(1);
        assertThat(h.delivery.last(sb, "broadcast").get("text").stringValue()).isEqualTo("Ciao <b>a tutti</b>");
        assertThat(h.delivery.of(sc, "broadcast")).isEmpty();
        h.send(a, sa, new ClientFrame.Broadcast(null, "again"));
        assertThat(h.delivery.last(sa, "error").get("code").stringValue()).isEqualTo("rate_limited");
        h.send(c, sc, new ClientFrame.Broadcast(null, " "));
        assertThat(h.delivery.last(sc, "error").get("code").stringValue()).isEqualTo("bad_request");
    }

    @Test
    void anInvitationGoesToTheOtherAndTheAnswerComesBack() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 30);
        h.send(a, sa, new ClientFrame.ConnectInvite("\"i\"", b));
        String invite = h.delivery.last(sa, "ack").get("invite").stringValue();
        JsonNode got = h.delivery.last(sb, "connect.invite");
        assertThat(got.get("id").stringValue()).isEqualTo(invite);
        assertThat(got.get("from").get("id").stringValue()).isEqualTo(Ids.publicId("usr", a));
        assertThat(h.directory.invited).hasSize(1);
        h.send(a, sa, new ClientFrame.ConnectInvite(null, b));
        assertThat(h.delivery.last(sa, "error").get("code").stringValue()).isEqualTo("rate_limited");
        // Only the invited person answers
        h.send(a, sa, new ClientFrame.ConnectAnswer(null, invite, true));
        assertThat(h.delivery.last(sa, "error").get("code").stringValue()).isEqualTo("expired");
        h.send(b, sb, new ClientFrame.ConnectAnswer("2", invite, true));
        assertThat(h.delivery.last(sb, "ack").get("ref").intValue()).isEqualTo(2);
        JsonNode answer = h.delivery.last(sa, "connect.answer");
        assertThat(answer.get("accept").booleanValue()).isTrue();
        assertThat(answer.get("by").get("id").stringValue()).isEqualTo(Ids.publicId("usr", b));
        // Once only
        h.send(b, sb, new ClientFrame.ConnectAnswer(null, invite, true));
        assertThat(h.delivery.last(sb, "error").get("code").stringValue()).isEqualTo("expired");
    }

    @Test
    void anInvitationRunsOutAfterAMinuteAndNeverToAConnection() {
        UUID a = h.user(), b = h.user(), friend = h.user();
        h.directory.connect(a, friend);
        SocketId sa = h.open(a), sb = h.open(b), sf = h.open(friend);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 30);
        h.east(friend, sf, Mode.VISIBLE, 40);
        h.send(a, sa, new ClientFrame.ConnectInvite(null, friend));
        assertThat(h.delivery.last(sa, "error").get("code").stringValue()).isEqualTo("already");
        h.send(a, sa, new ClientFrame.ConnectInvite(null, b));
        String invite = h.delivery.last(sa, "ack").get("invite").stringValue();
        h.advance(Duration.ofSeconds(61));
        h.send(b, sb, new ClientFrame.ConnectAnswer(null, invite, true));
        assertThat(h.delivery.last(sb, "error").get("code").stringValue()).isEqualTo("expired");
        h.send(a, sa, new ClientFrame.ConnectInvite(null, a));
        assertThat(h.delivery.last(sa, "error").get("code").stringValue()).isEqualTo("not_found");
    }

    @Test
    void withoutFramesFor45SecondsTheyLeaveEveryMap() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        h.advance(Duration.ofSeconds(30));
        h.east(a, sa, Mode.VISIBLE, 0);
        h.advance(Duration.ofSeconds(16));
        h.engine.expire();
        h.tick();
        assertThat(h.delivery.model(sa).people).isEmpty();
        assertThat(h.engine.position(b)).isEmpty();
        assertThat(h.engine.position(a)).isPresent();
        h.checkModels();
    }

    @Test
    void aJumpNoPlaneCouldMakeIsRefused() {
        UUID a = h.user();
        SocketId sa = h.open(a);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.advance(Duration.ofSeconds(2));
        h.at(a, sa, Mode.VISIBLE, 40.7128, -74.0060);
        assertThat(h.delivery.last(sa, "error").get("code").stringValue()).isEqualTo("position_rejected");
        assertThat(h.engine.position(a).orElseThrow().latitude()).isEqualTo(ROME_LAT);
        // A day later anywhere is reachable
        h.advance(Duration.ofHours(17));
        h.at(a, sa, Mode.VISIBLE, 40.7128, -74.0060);
        assertThat(h.engine.position(a).orElseThrow().latitude()).isEqualTo(40.7128);
        assertThat(h.engine.plausible(a, new Point(ROME_LAT, ROME_LON))).isFalse();
    }

    @Test
    void theSixthSocketClosesTheOldest() {
        UUID a = h.user();
        SocketId first = h.open(a);
        for (int i = 0; i < 5; i++) h.open(a);
        assertThat(h.delivery.model(first).closed).isTrue();
        assertThat(h.delivery.model(first).closeCode).isEqualTo(1008);
        assertThat(h.engine.socketCount()).isEqualTo(5);
    }

    @Test
    void closingTheSocketThatSendsThePositionLeavesTheMapAtOnce() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), other = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        h.close(a, sa);
        h.tick();
        assertThat(h.delivery.model(sb).people).isEmpty();
        assertThat(h.engine.online(List.of(a, b))).containsExactlyInAnyOrder(a, b);
        h.close(a, other);
        assertThat(h.engine.online(List.of(a, b))).containsExactly(b);
        assertThat(h.engine.peopleCount()).isEqualTo(1);
    }

    @Test
    void aPositionWaitsForRelationsBeforeTheFirstMatching() {
        UUID a = h.user(), b = h.user();
        h.directory.block(a, b);
        SocketId sa = h.open(a);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.directory.hold = true;
        SocketId sb = h.open(b);
        h.east(b, sb, Mode.VISIBLE, 10);
        assertThat(h.delivery.of(sb, "presence.snapshot")).isEmpty();
        h.directory.held.get(b).complete(h.directory.relationsOf(b));
        h.settle();
        assertThat(h.delivery.last(sb, "presence.snapshot").get("people")).isEmpty();
        h.tick();
        assertThat(h.delivery.model(sa).people).isEmpty();
    }

    @Test
    void relationsThatFailToLoadAreAskedAgain() {
        UUID a = h.user();
        h.directory.failNext = 1;
        SocketId sa = h.open(a);
        h.east(a, sa, Mode.VISIBLE, 0);
        assertThat(h.delivery.of(sa, "presence.snapshot")).isEmpty();
        h.advance(Duration.ofSeconds(1));
        assertThat(h.delivery.of(sa, "presence.snapshot")).hasSize(1);
    }

    @Test
    void aNewNameGoesAgainToWhoSeesThem() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        h.directory.summaries.put(b, "{\"id\":\"" + Ids.publicId("usr", b) + "\",\"username\":\"renamed\"}");
        h.directory.avatars.put(b, 7);
        h.engine.userChanged(b);
        h.settle();
        h.tick();
        JsonNode record = h.delivery.last(sa, "presence.delta").get("people").get(0);
        assertThat(record.get("user").get("username").stringValue()).isEqualTo("renamed");
        assertThat(record.get("avatarVersion").intValue()).isEqualTo(7);
    }

    @Test
    void aSecondPhoneGetsTheUserAgainOnItsSnapshot() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        SocketId second = h.open(a);
        h.east(a, second, Mode.VISIBLE, 0);
        JsonNode snapshot = h.delivery.last(second, "presence.snapshot");
        assertThat(snapshot.get("people").get(0).has("user")).isTrue();
        h.checkModels();
    }

    @Test
    void eventsReachWhoSearchedAroundAndWhoIsOnTheMap() {
        UUID searcher = h.user(), walker = h.user(), offline = h.user();
        SocketId ss = h.open(searcher);
        h.open(offline);
        assertThat(h.engine.searchedEvents(searcher, new Point(ROME_LAT, ROME_LON), 500)).isTrue();
        SocketId sw = h.open(walker);
        h.east(walker, sw, Mode.VISIBLE, 1000);
        Point at400 = Geo.offset(ROME_LAT, ROME_LON, 400, 0);
        Point at600 = Geo.offset(ROME_LAT, ROME_LON, 600, 0);
        assertThat(h.engine.eventAudience(at400, 800)).containsExactlyInAnyOrder(searcher, walker);
        assertThat(h.engine.eventAudience(at600, 800)).containsExactly(walker);
        assertThat(h.engine.eventAudience(at400, 300)).isEmpty();
        h.close(searcher, ss);
        assertThat(h.engine.eventAudience(at400, 800)).containsExactly(walker);
        // An impossible search is refused
        assertThat(h.engine.searchedEvents(walker, new Point(-33.86, 151.2), 500)).isFalse();
    }

    @Test
    void anErasedAccountIsForgottenEverywhere() {
        UUID a = h.user(), b = h.user();
        SocketId sa = h.open(a), sb = h.open(b);
        h.east(a, sa, Mode.VISIBLE, 0);
        h.east(b, sb, Mode.VISIBLE, 10);
        h.tick();
        h.engine.accountErased(b);
        h.settle();
        h.tick();
        assertThat(h.delivery.model(sb).closeCode).isEqualTo(4001);
        assertThat(h.delivery.model(sa).people).isEmpty();
        assertThat(h.engine.online(List.of(b))).isEmpty();
        h.checkModels();
    }

    @Test
    void framesFromAClosedSocketAreIgnored() {
        UUID a = h.user();
        SocketId sa = h.open(a);
        h.close(a, sa);
        h.east(a, sa, Mode.VISIBLE, 0);
        assertThat(h.engine.position(a)).isEmpty();
    }
}
