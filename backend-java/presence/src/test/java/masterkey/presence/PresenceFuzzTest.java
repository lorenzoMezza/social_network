// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import static masterkey.presence.Harness.ROME_LAT;
import static masterkey.presence.Harness.ROME_LON;
import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SplittableRandom;
import java.util.UUID;
import masterkey.core.Geo;
import masterkey.core.Point;
import net.jqwik.api.ForAll;
import net.jqwik.api.Property;
import net.jqwik.api.constraints.IntRange;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import tools.jackson.databind.JsonNode;

/**
 * Random lives on the map: people come and go, move, change mode, block, connect and wave.
 * After all of it, every pair is the same from both ends, every phone shows what the server
 * thinks it shows, no record breaks the privacy of its pair, and the matching found by the
 * indexes is the one found by looking at everybody.
 */
class PresenceFuzzTest {

    @ParameterizedTest
    @ValueSource(ints = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24})
    void randomLivesKeepEveryRule(int seed) {
        SplittableRandom random = new SplittableRandom(seed);
        Harness h = new Harness(PresenceConfig.of(Harness.KEY, 340).withMaxShown(5));
        List<UUID> users = new ArrayList<>();
        for (int i = 0; i < 40; i++) users.add(h.user());
        Map<UUID, List<SocketId>> open = new HashMap<>();
        Map<UUID, double[]> where = new HashMap<>();
        h.delivery.check = (socket, frame) -> checkPrivacy(h, socket, frame);

        for (int step = 0; step < 1500; step++) {
            UUID user = users.get(random.nextInt(users.size()));
            List<SocketId> mine = open.computeIfAbsent(user, k -> new ArrayList<>());
            int roll = random.nextInt(100);
            if (mine.isEmpty() || roll < 4) {
                if (mine.size() < 2) mine.add(h.open(user));
            } else if (roll < 8) {
                h.close(user, mine.remove(random.nextInt(mine.size())));
            } else if (roll < 55) {
                double[] at = where.computeIfAbsent(user, k -> new double[] {random.nextDouble(-800, 800), random.nextDouble(-800, 800)});
                at[0] += random.nextDouble(-60, 60);
                at[1] += random.nextDouble(-60, 60);
                Point point = Geo.offset(ROME_LAT, ROME_LON, at[0], at[1]);
                int modeRoll = random.nextInt(100);
                Mode mode = modeRoll < 60 ? Mode.VISIBLE : modeRoll < 88 ? Mode.APPROXIMATE : Mode.INVISIBLE;
                h.send(user, mine.get(random.nextInt(mine.size())), new ClientFrame.PresenceUpdate(null, mode,
                        new ClientFrame.Position(point.latitude(), point.longitude(), null, random.nextDouble(0, 360), 1.0, true)));
            } else if (roll < 60) {
                h.leave(user, mine.getFirst());
            } else if (roll < 66) {
                UUID other = users.get(random.nextInt(users.size()));
                if (!other.equals(user)) {
                    if (h.directory.blocked.getOrDefault(user, Set.of()).contains(other)) {
                        h.directory.blocked.get(user).remove(other);
                        h.directory.blocked.get(other).remove(user);
                    } else {
                        h.directory.block(user, other);
                    }
                    h.engine.relationChanged(user, other);
                    h.settle();
                }
            } else if (roll < 72) {
                UUID other = users.get(random.nextInt(users.size()));
                if (!other.equals(user)) {
                    h.directory.connect(user, other);
                    h.engine.relationChanged(user, other);
                    h.settle();
                }
            } else if (roll < 78) {
                UUID other = users.get(random.nextInt(users.size()));
                h.send(user, mine.getFirst(), new ClientFrame.Gesture(null, other, "wave"));
            } else if (roll < 82) {
                h.directory.avatars.merge(user, 1, Integer::sum);
                h.engine.userChanged(user);
                h.settle();
            } else if (roll < 90) {
                h.engine.rematchSome(5);
            } else if (roll < 95) {
                h.advance(Duration.ofMillis(random.nextInt(3000)));
                if (random.nextInt(4) == 0) h.engine.expire();
            } else {
                h.tick();
                h.checkModels();
            }
        }
        h.tick();
        h.checkModels();
        checkExact(h);
    }

    /** A record never says more than its pair allows. */
    private static void checkPrivacy(Harness h, SocketId socket, JsonNode frame) {
        String type = frame.get("type").stringValue();
        if (!type.startsWith("presence.")) return;
        Person viewer = h.engine.person(h.delivery.owners.get(socket));
        assertThat(viewer).isNotNull();
        for (JsonNode record : frame.get("people")) {
            Person other = h.engine.everyone().stream()
                    .filter(p -> p.publicId.equals(record.get("userId").stringValue())).findFirst().orElseThrow();
            assertThat(other.on).as("someone on the map").isTrue();
            assertThat(viewer.blocks(other)).as("never someone blocked").isFalse();
            double lat = record.get("position").get("latitude").doubleValue();
            double lon = record.get("position").get("longitude").doubleValue();
            if (record.get("precision").stringValue().equals("precise")) {
                assertThat(viewer.mode).isEqualTo(Mode.VISIBLE);
                assertThat(other.mode).isEqualTo(Mode.VISIBLE);
            } else {
                assertThat(record.get("heading").isNull()).isTrue();
                assertThat(lat).isEqualTo(Math.round(other.areaLatitude * 1e6) / 1e6);
                assertThat(lon).isEqualTo(Math.round(other.areaLongitude * 1e6) / 1e6);
            }
        }
    }

    /** The matching through the indexes against the rule applied to everybody. */
    private static void checkExact(Harness h) {
        int checked = 0;
        for (Person viewer : h.engine.everyone()) {
            if (!viewer.on) continue;
            Set<Person> shown = new HashSet<>(Arrays.asList(viewer.watching).subList(0, viewer.watchingCount));
            List<Long> keys = new ArrayList<>();
            Map<Long, Person> byKey = new HashMap<>();
            for (Person other : h.engine.everyone()) {
                if (other == viewer || !other.on || viewer.blocks(other)) continue;
                double chord = Engine.pairChord(viewer, other);
                if (chord > h.engine.maxChord()) continue;
                int group = viewer.connections.contains(other.id) ? 0
                        : viewer.pinned.getOrDefault(other.id, 0L) > h.clock.nanos ? 1 : 2;
                long key = Engine.key(group, shown.contains(other) ? chord * 0.85 : chord, other.slot);
                keys.add(key);
                byKey.put(key, other);
            }
            keys.sort(null);
            Set<Person> expected = new HashSet<>();
            for (int i = 0; i < Math.min(5, keys.size()); i++) expected.add(byKey.get(keys.get(i)));
            h.engine.rematchNow(viewer.id);
            Set<Person> actual = new HashSet<>(Arrays.asList(viewer.watching).subList(0, viewer.watchingCount));
            assertThat(actual).as("the matching of " + viewer).isEqualTo(expected);
            checked++;
        }
        assertThat(checked).isPositive();
    }

    @Property(tries = 60)
    void theIndexFindsTheNearestLikeLookingAtAll(@ForAll("seeds") long seed, @ForAll @IntRange(min = 1, max = 300) int count) {
        SplittableRandom random = new SplittableRandom(seed);
        NearIndex index = new NearIndex();
        double[][] points = new double[count][];
        // Rome, next to the North Pole, or across the antimeridian
        int place = (int) Math.floorMod(seed, 3L);
        double baseLat = place == 0 ? 41.9 : place == 1 ? 89.985 : 0.5;
        double baseLon = place == 2 ? 179.995 : 12.49;
        for (int i = 0; i < count; i++) {
            double lat = Math.max(-90, Math.min(90, baseLat + random.nextDouble(-0.01, 0.01)));
            double lon = baseLon + random.nextDouble(-0.01, 0.01);
            if (lon > 180) lon -= 360;
            // Some on the very same point as another
            points[i] = i > 0 && random.nextInt(8) == 0 ? points[i - 1].clone() : Geo.xyz(lat, lon);
            index.add(i, points[i]);
        }
        double[] centre = points[random.nextInt(count)];
        int k = 1 + random.nextInt(40);
        List<double[]> found = new ArrayList<>();
        index.nearest(centre[0], centre[1], centre[2], k, (id, chord) -> {
            found.add(new double[] {id, chord});
            return true;
        });
        double[] all = new double[count];
        for (int i = 0; i < count; i++) all[i] = distance(points[i], centre);
        Arrays.sort(all);
        assertThat(found).hasSize(Math.min(k, count));
        for (int i = 0; i < found.size(); i++) {
            assertThat(found.get(i)[1]).isCloseTo(all[i], org.assertj.core.data.Offset.offset(1e-6));
            assertThat(found.get(i)[1]).isCloseTo(distance(points[(int) found.get(i)[0]], centre), org.assertj.core.data.Offset.offset(1e-6));
        }
    }

    @net.jqwik.api.Provide
    net.jqwik.api.Arbitrary<Long> seeds() {
        return net.jqwik.api.Arbitraries.longs();
    }

    private static double distance(double[] a, double[] b) {
        double dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    @Property(tries = 200)
    void theChordLimitIsTheOneKilometreOfTheApp(@ForAll("seeds") long seed) {
        SplittableRandom random = new SplittableRandom(seed);
        double lat = random.nextDouble(-89, 89), lon = random.nextDouble(-180, 180);
        double metres = random.nextDouble(0, 2000), bearing = random.nextDouble(0, 360);
        Point other = Geo.offsetBearing(lat, lon, metres, bearing);
        if (!Geo.validLongitude(other.longitude())) return;
        double haversine = Geo.distance(lat, lon, other.latitude(), other.longitude());
        double chord = distance(Geo.xyz(lat, lon), Geo.xyz(other.latitude(), other.longitude()));
        if (Math.abs(haversine - 1000) > 0.01) {
            assertThat(chord <= Geo.arcToChord(1000)).isEqualTo(haversine <= 1000);
        }
    }
}
