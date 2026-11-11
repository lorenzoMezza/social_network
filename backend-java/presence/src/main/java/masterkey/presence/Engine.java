// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.PriorityQueue;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;
import masterkey.core.ApiError;
import masterkey.core.Geo;
import masterkey.core.Ids;
import masterkey.core.Point;
import masterkey.core.Text;
import org.jspecify.annotations.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Who sees whom on the map (JAVA-BACKEND.md §4.3-4.10, the rules of {@code realtime.py}).
 * Everything here belongs to one thread, the presence thread: no lock, no race. The
 * {@link PresenceService} hands it the messages one at a time and calls {@link #tick},
 * {@link #rematchSome} and the others on time; tests call them by hand.
 *
 * <p>The privacy of a pair is decided when the pair forms (§4.5): who is Visible to a
 * Visible viewer is seen precisely, anyone else by their area point, and the distance of an
 * area pair is measured to the point shown, never to the real place. Three indexes hold
 * exactly those points, so a search reads only the nearest.
 *
 * <p>Who is on a map (§4.6): their connections within 1 km, then who just waved at them for
 * a minute, then the nearest; within the same group someone already shown counts as 15%
 * nearer, so two people at the same distance do not take turns.
 */
final class Engine {

    private static final Logger log = LoggerFactory.getLogger(Engine.class);

    static final long SECOND = 1_000_000_000L;
    static final Set<String> GESTURES = Set.of("wave", "handsair", "fistpump", "dab");
    static final int BROADCAST_MAX = 120;
    static final long GESTURE_COOLDOWN = 2 * SECOND;
    static final long BROADCAST_COOLDOWN = 10 * SECOND;
    static final long INVITE_COOLDOWN = 10 * SECOND;
    static final long INVITE_TTL = 60 * SECOND;
    /** How long a failed load of relations or a summary waits before trying again. */
    static final long RETRY = SECOND;
    /** Searched events: the range the app may ask, and what counts for who never searched. */
    static final int SEARCH_MIN = 100;
    static final int SEARCH_MAX = 10_000;
    static final int SEARCH_AROUND_MAP = 2000;
    static final double SEARCH_MOVE = 100;
    /** A search is kept while the app is connected, and this long after it if not (C1c). */
    static final long SEARCH_KEEP_OFFLINE = 10 * 60 * SECOND;
    /** Slots are packed in 24 bits of the matching keys. */
    static final int MAX_SLOTS = 1 << 24;
    private static final long SLOT_MASK = MAX_SLOTS - 1;
    private static final String EMPTY_SNAPSHOT = "{\"type\":\"presence.snapshot\",\"people\":[]}";
    /** Nobody: what a free slot or the reused search points at. */
    private static final Person NOBODY = new Person(new UUID(0, 0), 0, 0);
    private static final Search NO_SEARCH = new Search(new UUID(0, 0), 0, 0, 0);

    private final PresenceConfig config;
    private final Directory directory;
    private final Delivery delivery;
    private final PresenceClock clock;
    private final Consumer<Runnable> inbox;
    private final double maxChord;
    private final int maxShown;

    private final Map<UUID, Person> people = new HashMap<>();
    private Person[] bySlot = new Person[1024];
    private int[] freeSlots = new int[64];
    private int freeCount;
    private int nextSlot;
    private final Map<SocketId, SocketState> sockets = new HashMap<>();
    private final ArrayList<Person> onMap = new ArrayList<>();
    private final ArrayList<Person> touched = new ArrayList<>();
    private final ArrayList<Person> soon = new ArrayList<>();
    private final NearIndex realVisible = new NearIndex();
    private final NearIndex areaVisible = new NearIndex();
    private final NearIndex areaApprox = new NearIndex();

    private final PositionGuard guard;
    private final AreaPoints areas;

    // Searched events (§4.8): their own index and slots
    private final NearIndex searchIndex = new NearIndex();
    private final Map<UUID, Search> searches = new HashMap<>();
    private Search[] searchBySlot = new Search[1024];
    private int[] freeSearchSlots = new int[64];
    private int freeSearchCount;
    private int nextSearchSlot;

    // Gestures, broadcasts, invitations
    private final Map<Pair, Long> lastGesture = new HashMap<>();
    private final Map<Pair, Long> lastInvite = new HashMap<>();
    private final Map<UUID, Long> lastBroadcast = new HashMap<>();
    private final RateWindow gestureWindow = new RateWindow(60, 60 * SECOND);
    private final RateWindow inviteWindow = new RateWindow(30, 3600 * SECOND);
    private final Map<String, Invite> invites = new HashMap<>();

    private final PriorityQueue<Timer> timers = new PriorityQueue<>();
    private long timerSequence;

    // The matching, reused at every call
    private long[] candidates = new long[256];
    private int candidateCount;
    private int[] mark = new int[1024];
    private int stamp;
    private int[] shownMark = new int[1024];
    private int shownStamp;
    private int[] keptMark = new int[1024];
    private int keptStamp;
    private Person[] selected;
    private final ArrayList<Person> added = new ArrayList<>();
    private final SearchHits searchHits = new SearchHits();
    private int rematchCursor;

    // Counters, read by the service for the metrics
    long rematches;
    long frames;
    long rejectedPositions;

    record Pair(UUID from, UUID to) {
    }

    record Invite(UUID from, UUID to, long expires) {
    }

    private record Timer(long due, long sequence, Runnable run) implements Comparable<Timer> {
        @Override
        public int compareTo(Timer other) {
            int byTime = Long.compare(due, other.due);
            return byTime != 0 ? byTime : Long.compare(sequence, other.sequence);
        }

        @Override
        public boolean equals(@Nullable Object other) {
            return other instanceof Timer timer && timer.sequence == sequence;
        }

        @Override
        public int hashCode() {
            return Long.hashCode(sequence);
        }
    }

    /** The point and range of someone's last search for events, rounded (§4.8). */
    private static final class Search {
        final UUID user;
        final int slot;
        double[] xyz;
        double latitude;
        double longitude;
        int range;
        boolean explicit;
        long at;

        Search(UUID user, int slot, double latitude, double longitude) {
            this.user = user;
            this.slot = slot;
            this.latitude = latitude;
            this.longitude = longitude;
            this.xyz = Geo.xyz(latitude, longitude);
        }

        @Override
        public String toString() {
            return "Search[…]";
        }
    }

    Engine(PresenceConfig config, Directory directory, Delivery delivery, PresenceClock clock, Consumer<Runnable> inbox) {
        this.config = config;
        this.directory = directory;
        this.delivery = delivery;
        this.clock = clock;
        this.inbox = inbox;
        this.maxShown = config.maxShown;
        this.maxChord = Geo.arcToChord(config.rangeMetres);
        this.guard = new PositionGuard(config.maxTravelSpeed);
        this.areas = new AreaPoints(config.areaKey(), config.areaCellMetres, config.areaJitterMetres);
        this.selected = new Person[config.maxShown];
    }

    // --- sockets ---

    void socketOpened(UUID user, SocketId id) {
        if (sockets.containsKey(id)) return;
        Person person = people.get(user);
        if (person == null) person = newPerson(user);
        SocketState socket = new SocketState(id, person, clock.nanos());
        person.sockets.add(socket);
        sockets.put(id, socket);
        // A person has a few devices; a script opening sockets without end does not get them
        while (person.sockets.size() > config.maxSocketsPerUser) {
            SocketState oldest = person.sockets.getFirst();
            for (SocketState other : person.sockets) if (other.opened < oldest.opened) oldest = other;
            delivery.close(oldest.id, 1008, "too many connections");
            closeSocket(oldest);
        }
        // Connections and blocks are kept only for who has a socket, and loaded again at each one
        askRelations(person);
        askSummary(person);
    }

    void socketClosed(UUID user, SocketId id) {
        SocketState socket = sockets.get(id);
        if (socket != null && socket.person.id.equals(user)) closeSocket(socket);
    }

    private void closeSocket(SocketState socket) {
        sockets.remove(socket.id);
        Person person = socket.person;
        person.sockets.remove(socket);
        if (person.pendingSocket == socket) {
            person.pending = null;
            person.pendingSocket = null;
        }
        // The app went to the background or was closed: out of everyone's map at once.
        // The TTL is only for a connection lost without a word.
        if (person.on && (person.owner == socket || person.sockets.isEmpty())) exit(person, false);
        if (person.owner == socket) person.owner = null;
        if (person.sockets.isEmpty()) forget(person);
    }

    // --- frames ---

    void frame(UUID user, SocketId id, ClientFrame frame) {
        SocketState socket = sockets.get(id);
        if (socket == null || !socket.person.id.equals(user)) return;
        frames++;
        Person person = socket.person;
        switch (frame) {
            case ClientFrame.PresenceUpdate update -> presence(socket, update);
            case ClientFrame.Gesture gesture -> answer(socket, gesture.ref(), () -> gesture(person, gesture));
            case ClientFrame.Broadcast broadcast -> answer(socket, broadcast.ref(), () -> broadcast(person, broadcast.text()));
            case ClientFrame.ConnectInvite invite -> answer(socket, invite.ref(), () -> invite(person, invite.to()));
            case ClientFrame.ConnectAnswer reply -> answer(socket, reply.ref(), () -> reply(person, reply.invite(), reply.accept()));
        }
    }

    private interface Action {
        /** The fields of the ack: empty, or starting with a comma. */
        String run();
    }

    private void answer(SocketState socket, @Nullable String ref, Action action) {
        String reply;
        try {
            reply = Wire.ack(ref, action.run());
        } catch (ApiError error) {
            reply = Wire.error(ref, error);
        }
        delivery.send(socket.id, reply);
    }

    private void presence(SocketState socket, ClientFrame.PresenceUpdate update) {
        Person person = socket.person;
        ClientFrame.Position position = update.position();
        if (position != null && update.mode() != Mode.INVISIBLE
                && !guard.plausible(person.id, position.latitude(), position.longitude(), clock.nanos())) {
            // Refused: the user stays where they were, and leaves the map with the TTL
            rejectedPositions++;
            delivery.send(socket.id, Wire.error(update.ref(),
                    new ApiError(409, "position_rejected", "this position is not possible")));
            return;
        }
        if (!person.ready()) {
            // Their connections and blocks are not here yet: the position waits for them
            if (update.mode() == Mode.INVISIBLE || position == null) {
                person.pending = null;
                person.pendingSocket = null;
                if (update.mode() == Mode.INVISIBLE) sendToUser(person, EMPTY_SNAPSHOT);
            } else {
                person.pending = update;
                person.pendingSocket = socket;
            }
            return;
        }
        apply(person, socket, update);
    }

    private void apply(Person person, SocketState socket, ClientFrame.PresenceUpdate update) {
        ClientFrame.Position position = update.position();
        if (update.mode() == Mode.INVISIBLE || position == null) {
            boolean invisible = update.mode() == Mode.INVISIBLE;
            if (person.on) exit(person, invisible);
            if (invisible) {
                // The empty snapshot replaces everything, also who went and was not told yet
                person.gone.clear();
                sendToUser(person, EMPTY_SNAPSHOT);
                for (SocketState each : person.sockets) each.audienceTold = -1;
                touch(person);
            }
            return;
        }
        person.lastFrame = clock.nanos();
        person.owner = socket;
        if (!person.on) {
            enter(person, update.mode(), position);
            snapshot(person);
        } else if (person.mode != update.mode()) {
            changeMode(person, update.mode(), position);
            snapshot(person);
        } else {
            move(person, position);
            if (!socket.started) snapshot(person);
        }
    }

    // --- on and off the map ---

    private void enter(Person person, Mode mode, ClientFrame.Position position) {
        person.on = true;
        person.mode = mode;
        person.onMapIndex = onMap.size();
        onMap.add(person);
        place(person, position, true);
        indexAdd(person);
        person.gone.clear();
        rematch(person);
        aroundMap(person);
    }

    private void changeMode(Person person, Mode mode, ClientFrame.Position position) {
        indexRemove(person);
        person.mode = mode;
        place(person, position, false);
        indexAdd(person);
        // The precision of all their pairs changed: who has them and who they see, again now
        rematch(person);
        for (Person watcher : new ArrayList<>(person.watchers)) rematch(watcher);
    }

    private void move(Person person, ClientFrame.Position position) {
        double[] oldXyz = person.xyz;
        double[] oldArea = person.areaXyz;
        long precise = person.preciseVersion;
        long area = person.areaVersion;
        boolean moved = place(person, position, false);
        if (moved && person.mode == Mode.VISIBLE) realVisible.move(person.slot, oldXyz, person.xyz);
        if (person.areaVersion != area) (person.mode == Mode.VISIBLE ? areaVisible : areaApprox).move(person.slot, oldArea, person.areaXyz);
        if (person.preciseVersion != precise || person.areaVersion != area) {
            for (Person watcher : person.watchers) touch(watcher);
        }
        aroundMap(person);
        if (Geo.distance(person.rematchLatitude, person.rematchLongitude, person.latitude, person.longitude) > config.rematchAfterMetres) {
            markSoon(person);
        }
    }

    /**
     * Where they are now, what of it is shown, and the area point. Returns whether the real
     * point moved. A new version of a record when what it shows changed: a keepalive that does
     * not move them sends nothing to anybody. {@code fresh}: they just came on the map.
     */
    private boolean place(Person person, ClientFrame.Position position, boolean fresh) {
        boolean moved = fresh || position.latitude() != person.latitude || position.longitude() != person.longitude;
        if (fresh) person.areaSet = false;
        person.latitude = position.latitude();
        person.longitude = position.longitude();
        person.heading = position.heading();
        person.speed = position.speed();
        person.moving = position.moving();
        person.updatedAt = clock.instant();
        // A new array each time: the index may keep the one it was given (§16)
        if (moved) person.xyz = Geo.xyz(person.latitude, person.longitude);
        long latitude = Math.round(person.latitude * 1e6);
        long longitude = Math.round(person.longitude * 1e6);
        Double rawHeading = person.heading;
        Double rawSpeed = person.speed;
        Boolean rawMoving = person.moving;
        long heading = rawHeading == null ? Long.MIN_VALUE : Math.round(rawHeading);
        long speed = rawSpeed == null ? Long.MIN_VALUE : Math.round(rawSpeed * 10);
        int moving = rawMoving == null ? 2 : rawMoving ? 1 : 0;
        if (fresh || latitude != person.shownLatitude || longitude != person.shownLongitude || heading != person.shownHeading
                || speed != person.shownSpeed || moving != person.shownMoving) {
            person.shownLatitude = latitude;
            person.shownLongitude = longitude;
            person.shownHeading = heading;
            person.shownSpeed = speed;
            person.shownMoving = moving;
            person.preciseVersion++;
        }
        long day = Math.floorDiv(person.updatedAt.getEpochSecond(), 86_400L);
        long row = areas.row(person.latitude);
        long column = areas.column(row, person.longitude);
        if (!person.areaSet || row != person.areaRow || column != person.areaColumn || day != person.areaDay) {
            double[] point = areas.point(person.id.toString(), row, column, day);
            person.areaSet = true;
            person.areaRow = row;
            person.areaColumn = column;
            person.areaDay = day;
            person.areaLatitude = point[0];
            person.areaLongitude = point[1];
            person.areaXyz = Geo.xyz(point[0], point[1]);
            person.areaVersion++;
        }
        return moved;
    }

    private void indexAdd(Person person) {
        if (person.mode == Mode.VISIBLE) {
            realVisible.add(person.slot, person.xyz);
            areaVisible.add(person.slot, person.areaXyz);
        } else {
            areaApprox.add(person.slot, person.areaXyz);
        }
    }

    private void indexRemove(Person person) {
        if (person.mode == Mode.VISIBLE) {
            realVisible.remove(person.slot, person.xyz);
            areaVisible.remove(person.slot, person.areaXyz);
        } else {
            areaApprox.remove(person.slot, person.areaXyz);
        }
    }

    /**
     * Off the map: out of the indexes and of every pair. {@code quiet}: invisible, whose
     * phone gets an empty snapshot instead of the list of who went.
     */
    private void exit(Person person, boolean quiet) {
        indexRemove(person);
        person.on = false;
        int at = person.onMapIndex;
        Person last = onMap.removeLast();
        if (last != person) {
            onMap.set(at, last);
            last.onMapIndex = at;
        }
        person.onMapIndex = -1;
        person.owner = null;
        for (Person watcher : new ArrayList<>(person.watchers)) {
            removePair(watcher, person);
            // One fewer on their map: someone else may take the place
            markSoon(watcher);
        }
        for (int i = person.watchingCount - 1; i >= 0; i--) {
            Person other = person.watching[i];
            removePair(person, other);
        }
        if (quiet) person.gone.clear();
        touch(person);
        Search search = searches.get(person.id);
        if (search != null && !search.explicit) removeSearch(search);
    }

    // --- the matching ---

    /** Whom the viewer sees now: the rule of §4.6, searched in the indexes. */
    private void rematch(Person viewer) {
        if (!viewer.on) return;
        rematches++;
        long now = clock.nanos();
        viewer.soon = false;
        viewer.lastRematch = now;
        viewer.rematchLatitude = viewer.latitude;
        viewer.rematchLongitude = viewer.longitude;
        shownStamp++;
        for (int i = 0; i < viewer.watchingCount; i++) shownMark[viewer.watching[i].slot] = shownStamp;
        stamp++;
        candidateCount = 0;
        // Directly: who is already shown, their connections, who just waved at them
        for (int i = 0; i < viewer.watchingCount; i++) candidate(viewer, viewer.watching[i], -1);
        for (UUID id : viewer.connections) {
            Person other = people.get(id);
            if (other != null && other.on) candidate(viewer, other, -1);
        }
        for (Map.Entry<UUID, Long> pin : viewer.pinned.entrySet()) {
            if (pin.getValue() <= now) continue;
            Person other = people.get(pin.getKey());
            if (other != null && other.on) candidate(viewer, other, -1);
        }
        search(viewer.mode == Mode.VISIBLE ? realVisible : areaVisible, viewer);
        search(areaApprox, viewer);
        Arrays.sort(candidates, 0, candidateCount);
        int count = Math.min(maxShown, candidateCount);
        keptStamp++;
        for (int i = 0; i < count; i++) {
            Person other = bySlot[(int) (candidates[i] & SLOT_MASK)];
            selected[i] = other;
            keptMark[other.slot] = keptStamp;
        }
        for (int i = viewer.watchingCount - 1; i >= 0; i--) {
            Person other = viewer.watching[i];
            if (keptMark[other.slot] != keptStamp) removePair(viewer, other);
        }
        added.clear();
        for (int i = 0; i < count; i++) {
            Person other = selected[i];
            if (shownMark[other.slot] != shownStamp) {
                addPair(viewer, other);
                added.add(other);
            }
            selected[i] = NOBODY;
        }
        viewer.worstValid = false;
        // Whom they see now likely should see them too: without waiting for their own round
        for (Person other : new ArrayList<>(added)) considerAdd(/* host= */ other, /* guest= */ viewer);
    }

    private void candidate(Person viewer, Person other, double chord) {
        if (other == viewer || mark[other.slot] == stamp) return;
        mark[other.slot] = stamp;
        if (!other.on || viewer.blocks(other)) return;
        if (chord < 0) chord = pairChord(viewer, other);
        if (chord > maxChord) return;
        double score = shownMark[other.slot] == shownStamp ? chord * config.shownAdvantage : chord;
        if (candidateCount == candidates.length) candidates = Arrays.copyOf(candidates, candidateCount * 2);
        candidates[candidateCount++] = key(group(viewer, other), score, other.slot);
    }

    /** The nearest of one index: when blocks take too many away, again with k doubled. */
    private void search(NearIndex index, Person viewer) {
        int k = maxShown + 1;
        while (true) {
            searchHits.viewer = viewer;
            searchHits.kept = 0;
            searchHits.far = false;
            int found = index.nearest(viewer.xyz[0], viewer.xyz[1], viewer.xyz[2], k, searchHits);
            if (searchHits.kept >= maxShown || searchHits.far || found < k) return;
            k *= 2;
        }
    }

    private final class SearchHits implements NearIndex.Hits {
        Person viewer = NOBODY;
        int kept;
        boolean far;

        @Override
        public boolean hit(int id, double chord) {
            if (chord > maxChord) {
                far = true;
                return false;
            }
            Person other = bySlot[id];
            if (other != viewer && !viewer.blocks(other)) {
                kept++;
                candidate(viewer, other, chord);
            }
            return true;
        }
    }

    /** Someone new near the host enters the host's map if there is room or they beat the last one. */
    private void considerAdd(Person host, Person guest) {
        if (!host.on || !guest.on || host == guest || host.blocks(guest)) return;
        if (host.indexInView(guest) >= 0) return;
        double chord = pairChord(host, guest);
        if (chord > maxChord) return;
        if (host.watchingCount < maxShown) {
            addPair(host, guest);
            return;
        }
        if (!host.worstValid) recomputeWorst(host);
        Person out = host.worstPerson;
        long key = key(group(host, guest), chord, guest.slot);
        if (out == null || key >= host.worst) return;
        removePair(host, out);
        addPair(host, guest);
        host.worstValid = false;
    }

    /** The last of the viewer's map, by the same order as the matching (they are all shown). */
    private void recomputeWorst(Person viewer) {
        long worst = Long.MIN_VALUE;
        Person who = null;
        for (int i = 0; i < viewer.watchingCount; i++) {
            Person other = viewer.watching[i];
            long key = !other.on || viewer.blocks(other)
                    ? Long.MAX_VALUE
                    : key(group(viewer, other), pairChord(viewer, other) * config.shownAdvantage, other.slot);
            if (who == null || key > worst) {
                worst = key;
                who = other;
            }
        }
        viewer.worst = worst;
        viewer.worstPerson = who;
        viewer.worstValid = true;
    }

    /** 0: a connection; 1: waved at the viewer in the last minute; 2: anyone else. */
    private int group(Person viewer, Person other) {
        if (viewer.connections.contains(other.id)) return 0;
        Long until = viewer.pinned.get(other.id);
        return until != null && until > clock.nanos() ? 1 : 2;
    }

    /** Group first, then the distance in centimetres, then the slot: one number to sort. */
    static long key(int group, double metres, int slot) {
        return ((long) group << 58) | (Math.round(metres * 100) << 24) | slot;
    }

    static boolean precise(Person viewer, Person other) {
        return viewer.mode == Mode.VISIBLE && other.mode == Mode.VISIBLE;
    }

    /** The distance of the pair: from the viewer's real place to the point shown to them. */
    static double pairChord(Person viewer, Person other) {
        double[] to = precise(viewer, other) ? other.xyz : other.areaXyz;
        double dx = to[0] - viewer.xyz[0], dy = to[1] - viewer.xyz[1], dz = to[2] - viewer.xyz[2];
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    private void addPair(Person viewer, Person other) {
        int at = viewer.watchingCount;
        if (at == viewer.watching.length) throw new IllegalStateException("view over its size");
        viewer.watching[at] = other;
        viewer.sent[at] = Person.NEW;
        viewer.sentPrecise[at] = false;
        // Taken off and back in the same round: what they had is still there
        for (Iterator<Person.Gone> it = viewer.gone.iterator(); it.hasNext(); ) {
            Person.Gone gone = it.next();
            if (gone.who().id.equals(other.id)) {
                // The same person, or the same user come back since: the phone still has them
                viewer.sent[at] = gone.who() == other ? gone.sent() : Person.STALE;
                viewer.sentPrecise[at] = gone.sentPrecise();
                it.remove();
                break;
            }
        }
        viewer.watchingCount = at + 1;
        other.watchers.add(viewer);
        viewer.worstValid = false;
        touch(viewer);
        touch(other);
    }

    private void removePair(Person viewer, Person other) {
        int at = viewer.indexInView(other);
        if (at < 0) return;
        if (viewer.sent[at] != Person.NEW) viewer.gone.add(new Person.Gone(other, viewer.sent[at], viewer.sentPrecise[at]));
        int last = viewer.watchingCount - 1;
        viewer.watching[at] = viewer.watching[last];
        viewer.sent[at] = viewer.sent[last];
        viewer.sentPrecise[at] = viewer.sentPrecise[last];
        viewer.watching[last] = NOBODY;
        viewer.watchingCount = last;
        if (!other.watchers.remove(viewer)) throw new IllegalStateException("watcher missing");
        viewer.worstValid = false;
        touch(viewer);
        touch(other);
    }

    // --- relations and summaries, from Directory ---

    private void askRelations(Person person) {
        long version = ++person.relationsAsked;
        UUID id = person.id;
        CompletableFuture<Directory.Relations> answer;
        try {
            answer = directory.relations(id);
        } catch (RuntimeException error) {
            answer = CompletableFuture.failedFuture(error);
        }
        // The answer comes back as a message to this thread: nothing waits for it here
        CompletableFuture<?> _ =
                answer.whenComplete((relations, error) -> inbox.accept(() -> relationsArrived(id, version, relations, error)));
    }

    private void relationsArrived(UUID id, long version, Directory.@Nullable Relations relations, @Nullable Throwable error) {
        Person person = people.get(id);
        if (person == null || person.relationsAsked != version) return;
        if (error != null || relations == null) {
            log.warn("presence: loading relations failed, retrying: {}", error == null ? "no answer" : error.getClass().getSimpleName());
            later(RETRY, () -> {
                Person again = people.get(id);
                if (again != null && again.relationsAsked == version) askRelations(again);
            });
            return;
        }
        person.connections = relations.connections();
        person.blocked = relations.blocked();
        person.relationsLoaded = true;
        if (person.on) {
            // A block breaks the pair at once, in both directions
            for (int i = person.watchingCount - 1; i >= 0; i--) {
                Person other = person.watching[i];
                if (person.blocks(other)) removePair(person, other);
            }
            for (Person watcher : new ArrayList<>(person.watchers)) {
                if (watcher.blocks(person)) {
                    removePair(watcher, person);
                    markSoon(watcher);
                }
            }
            rematch(person);
        }
        whenReady(person);
    }

    private void askSummary(Person person) {
        long version = ++person.summaryAsked;
        UUID id = person.id;
        CompletableFuture<Directory.Summary> answer;
        try {
            answer = directory.summary(id);
        } catch (RuntimeException error) {
            answer = CompletableFuture.failedFuture(error);
        }
        CompletableFuture<?> _ =
                answer.whenComplete((summary, error) -> inbox.accept(() -> summaryArrived(id, version, summary, error)));
    }

    private void summaryArrived(UUID id, long version, Directory.@Nullable Summary summary, @Nullable Throwable error) {
        Person person = people.get(id);
        if (person == null || person.summaryAsked != version) return;
        if (error != null || summary == null) {
            log.warn("presence: loading a summary failed, retrying: {}", error == null ? "no answer" : error.getClass().getSimpleName());
            later(RETRY, () -> {
                Person again = people.get(id);
                if (again != null && again.summaryAsked == version) askSummary(again);
            });
            return;
        }
        if (!summary.json().equals(person.summary) || summary.avatarVersion() != person.avatarVersion) {
            boolean first = person.summary == null;
            person.summary = summary.json();
            person.avatarVersion = summary.avatarVersion();
            if (!first) {
                // The user goes again to whoever has them, with the new record
                person.summaryVersion++;
                person.preciseVersion++;
                person.areaVersion++;
                for (Person watcher : person.watchers) touch(watcher);
            }
        }
        whenReady(person);
    }

    private void whenReady(Person person) {
        ClientFrame.PresenceUpdate pending = person.pending;
        SocketState socket = person.pendingSocket;
        if (!person.ready() || pending == null || socket == null) return;
        person.pending = null;
        person.pendingSocket = null;
        if (sockets.get(socket.id) == socket) apply(person, socket, pending);
    }

    void relationChanged(UUID a, UUID b) {
        Person first = people.get(a);
        if (first != null) askRelations(first);
        Person second = people.get(b);
        if (second != null) askRelations(second);
    }

    void userChanged(UUID user) {
        Person person = people.get(user);
        if (person != null) askSummary(person);
    }

    /** The account is gone: nothing in memory says anything about them any more. */
    void accountErased(UUID user) {
        Person person = people.get(user);
        if (person != null) {
            for (SocketState socket : new ArrayList<>(person.sockets)) {
                delivery.close(socket.id, 4001, "account deleted");
                closeSocket(socket);
            }
        }
        guard.forget(user);
        gestureWindow.forget(user);
        inviteWindow.forget(user);
        lastBroadcast.remove(user);
        lastGesture.keySet().removeIf(pair -> pair.from.equals(user) || pair.to.equals(user));
        lastInvite.keySet().removeIf(pair -> pair.from.equals(user) || pair.to.equals(user));
        invites.values().removeIf(invite -> invite.from.equals(user) || invite.to.equals(user));
        Search search = searches.get(user);
        if (search != null) removeSearch(search);
        for (Person other : people.values()) other.pinned.remove(user);
        for (SocketState socket : sockets.values()) socket.known.remove(user);
    }

    // --- gestures, broadcasts, invitations (§4.10, Le azioni) ---

    private String gesture(Person sender, ClientFrame.Gesture frame) {
        if (!GESTURES.contains(frame.gesture())) throw ApiError.badRequest("unknown gesture");
        Person target = people.get(frame.to());
        if (target == null || !near(sender, target)) throw ApiError.forbidden("they cannot see you on the map now");
        long now = clock.nanos();
        Pair pair = new Pair(sender.id, target.id);
        Long last = lastGesture.get(pair);
        if (last != null && now - last < GESTURE_COOLDOWN) throw new ApiError(429, "rate_limited", "one gesture every 2 s");
        gestureWindow.check(sender.id, now);
        lastGesture.put(pair, now);
        boolean shown = target.indexInView(sender) >= 0;
        target.pinned.put(sender.id, now + config.pinnedNanos);
        String text = "{\"type\":\"gesture\",\"id\":\"g_" + Ids.secret(9) + "\",\"from\":\"" + sender.publicId
                + "\",\"gesture\":\"" + frame.gesture() + "\",\"at\":\"" + Wire.time(clock.instant()) + "\"}";
        if (shown) {
            sendToUser(target, text);
        } else {
            // The map plays a gesture only on someone it shows: first the delta, the gesture after
            rematch(target);
            flush(target);
            UUID id = target.id;
            later(config.pinDelayNanos, () -> {
                Person again = people.get(id);
                if (again != null) sendToUser(again, text);
            });
        }
        return "";
    }

    private String broadcast(Person sender, String raw) {
        String text = Text.strip(Text.plain(raw));
        int length = Text.length(text);
        if (length == 0 || length > BROADCAST_MAX) throw ApiError.badRequest("1–120 characters");
        if (!sender.on) throw ApiError.forbidden("nobody sees you while you are invisible");
        long now = clock.nanos();
        Long last = lastBroadcast.get(sender.id);
        if (last != null && now - last < BROADCAST_COOLDOWN) throw new ApiError(429, "rate_limited", "one message every 10 s");
        lastBroadcast.put(sender.id, now);
        String frame = "{\"type\":\"broadcast\",\"id\":\"b_" + Ids.secret(9) + "\",\"from\":\"" + sender.publicId
                + "\",\"text\":" + Wire.quote(text) + ",\"at\":\"" + Wire.time(clock.instant()) + "\"}";
        // Only who has them on the map hears it: at most a few dozen, never a whole square
        for (Person watcher : sender.watchers) sendToUser(watcher, frame);
        return ",\"recipients\":" + sender.watchers.size();
    }

    private String invite(Person sender, UUID to) {
        if (to.equals(sender.id)) throw ApiError.notFound("unknown person");
        Person target = people.get(to);
        if (target == null || !near(sender, target)) throw ApiError.forbidden("they cannot see you on the map now");
        if (sender.connections.contains(target.id)) throw ApiError.conflict("already", "already connected");
        long now = clock.nanos();
        Pair pair = new Pair(sender.id, target.id);
        Long last = lastInvite.get(pair);
        if (last != null && now - last < INVITE_COOLDOWN) throw new ApiError(429, "rate_limited", "one invitation every 10 s");
        inviteWindow.check(sender.id, now);
        lastInvite.put(pair, now);
        String id = "ci_" + Ids.secret(9);
        invites.put(id, new Invite(sender.id, target.id, now + INVITE_TTL));
        Instant expires = clock.instant().plusNanos(INVITE_TTL);
        sendToUser(target, "{\"type\":\"connect.invite\",\"id\":\"" + id + "\",\"from\":" + summaryOf(sender)
                + ",\"expiresAt\":\"" + Wire.time(expires) + "\"}");
        // Kept among their notifications too: a request they may have missed
        try {
            directory.connectInvited(target.id, sender.id);
        } catch (RuntimeException error) {
            log.warn("presence: the invitation's notification failed: {}", error.getClass().getSimpleName());
        }
        return ",\"invite\":\"" + id + "\"";
    }

    private String reply(Person person, String id, boolean accept) {
        if (!person.relationsLoaded) throw ApiError.unavailable("try again", 1);
        Invite invite = invites.get(id);
        // Blocked meanwhile: as if it had run out, and nothing goes to the other
        if (invite == null || !invite.to.equals(person.id) || clock.nanos() > invite.expires || person.blocked.contains(invite.from)) {
            throw ApiError.gone("expired", "the invitation is over");
        }
        invites.remove(id);
        Person inviter = people.get(invite.from);
        if (inviter != null) {
            sendToUser(inviter, "{\"type\":\"connect.answer\",\"invite\":\"" + id + "\",\"accept\":" + accept
                    + ",\"by\":" + summaryOf(person) + "}");
        }
        return "";
    }

    private static String summaryOf(Person person) {
        String summary = person.summary;
        return summary == null ? "null" : summary;
    }

    // --- questions from api and worker ---

    /**
     * Both on the map, neither invisible, no block, within 1 km measured as the pair is
     * (from the area point when the pair is by area). The cap of 25 does not count.
     */
    private boolean near(Person viewer, Person other) {
        return viewer != other && viewer.on && other.on && !viewer.blocks(other) && pairChord(viewer, other) <= maxChord;
    }

    Map<UUID, Boolean> near(UUID viewer, List<UUID> others) {
        Map<UUID, Boolean> answer = new LinkedHashMap<>();
        Person me = people.get(viewer);
        for (UUID id : others) {
            Person other = people.get(id);
            answer.put(id, me != null && other != null && near(me, other));
        }
        return answer;
    }

    Optional<Point> position(UUID user) {
        Person person = people.get(user);
        return person != null && person.on ? Optional.of(new Point(person.latitude, person.longitude)) : Optional.empty();
    }

    boolean plausible(UUID user, Point point) {
        boolean fine = guard.plausible(user, point.latitude(), point.longitude(), clock.nanos());
        if (!fine) rejectedPositions++;
        return fine;
    }

    boolean searchedEvents(UUID user, Point point, int rangeMetres) {
        if (!plausible(user, point)) return false;
        int range = Math.max(SEARCH_MIN, Math.min(SEARCH_MAX, rangeMetres));
        keepSearch(user, round3(point.latitude()), round3(point.longitude()), range, true);
        return true;
    }

    /** Who is online and has the place within their events: their search, else 2 km around them. */
    List<UUID> eventAudience(Point place, int reachMetres) {
        int reach = Math.max(0, Math.min(SEARCH_MAX, reachMetres));
        double[] xyz = Geo.xyz(place.latitude(), place.longitude());
        List<UUID> found = new ArrayList<>();
        searchIndex.within(xyz[0], xyz[1], xyz[2], Geo.arcToChord(reach), (slot, chord) -> {
            Search search = searchBySlot[slot];
            if (chord <= Geo.arcToChord(Math.min(search.range, reach)) && people.containsKey(search.user)) found.add(search.user);
            return true;
        });
        return found;
    }

    List<UUID> online(List<UUID> users) {
        List<UUID> found = new ArrayList<>();
        for (UUID user : users) if (people.containsKey(user)) found.add(user);
        return found;
    }

    /** Someone on the map who never searched counts as 2 km around where they are. */
    private void aroundMap(Person person) {
        Search search = searches.get(person.id);
        if (search != null && search.explicit) return;
        if (search != null && Geo.distance(search.latitude, search.longitude, person.latitude, person.longitude) < SEARCH_MOVE) return;
        keepSearch(person.id, round3(person.latitude), round3(person.longitude), SEARCH_AROUND_MAP, false);
    }

    private void keepSearch(UUID user, double latitude, double longitude, int range, boolean explicit) {
        Search search = searches.get(user);
        if (search == null) {
            int slot = newSearchSlot();
            search = new Search(user, slot, latitude, longitude);
            searchBySlot[slot] = search;
            searches.put(user, search);
            searchIndex.add(slot, search.xyz);
        } else if (search.latitude != latitude || search.longitude != longitude) {
            double[] from = search.xyz;
            search.latitude = latitude;
            search.longitude = longitude;
            search.xyz = Geo.xyz(latitude, longitude);
            searchIndex.move(search.slot, from, search.xyz);
        }
        search.range = range;
        search.explicit = explicit;
        search.at = clock.nanos();
    }

    private void removeSearch(Search search) {
        searches.remove(search.user);
        searchIndex.remove(search.slot, search.xyz);
        searchBySlot[search.slot] = NO_SEARCH;
        if (freeSearchCount == freeSearchSlots.length) freeSearchSlots = Arrays.copyOf(freeSearchSlots, freeSearchCount * 2);
        freeSearchSlots[freeSearchCount++] = search.slot;
    }

    private int newSearchSlot() {
        if (freeSearchCount > 0) return freeSearchSlots[--freeSearchCount];
        if (nextSearchSlot == searchBySlot.length) searchBySlot = Arrays.copyOf(searchBySlot, searchBySlot.length * 2);
        return nextSearchSlot++;
    }

    static double round3(double value) {
        return Math.round(value * 1000) / 1000.0;
    }

    // --- the round every 0.5 s ---

    private void touch(Person person) {
        if (!person.touched) {
            person.touched = true;
            touched.add(person);
        }
    }

    private void markSoon(Person person) {
        if (person.on && !person.soon) {
            person.soon = true;
            soon.add(person);
        }
    }

    /** The matchings asked for now (moved 25 m, someone left their map): before the round. */
    void rematchSoon() {
        if (soon.isEmpty()) return;
        List<Person> now = new ArrayList<>(soon);
        soon.clear();
        for (Person person : now) if (person.soon) rematch(person);
    }

    /** A slice of the matchings every 5 s: {@code count} people from where the last slice stopped. */
    int rematchSome(int count) {
        int done = 0;
        long now = clock.nanos();
        for (int tries = 0; done < count && tries < onMap.size(); tries++) {
            if (rematchCursor >= onMap.size()) rematchCursor = 0;
            Person person = onMap.get(rematchCursor++);
            if (now - person.lastRematch >= config.rematchEveryNanos / 2) {
                rematch(person);
                done++;
            }
        }
        return done;
    }

    int onMapCount() {
        return onMap.size();
    }

    /** One matching now, for tests. */
    void rematchNow(UUID user) {
        Person person = people.get(user);
        if (person != null) rematch(person);
    }

    /**
     * For each viewer touched since the last round, what changed for them: who appeared or
     * moved, who went, how many see them. Nothing changed: no frame.
     */
    void tick() {
        rematchSoon();
        for (Person person : touched) {
            person.touched = false;
            if (people.get(person.id) == person) flush(person);
        }
        touched.clear();
    }

    private void flush(Person viewer) {
        int audience = viewer.watchers.size();
        boolean started = false;
        for (SocketState socket : viewer.sockets) {
            if (!socket.started) continue;
            started = true;
            StringBuilder out = new StringBuilder(256).append("{\"type\":\"presence.delta\",\"people\":[");
            int count = 0;
            for (int i = 0; i < viewer.watchingCount; i++) {
                Person other = viewer.watching[i];
                boolean precise = precise(viewer, other);
                long version = precise ? other.preciseVersion : other.areaVersion;
                if (viewer.sent[i] == Person.NEW || viewer.sentPrecise[i] != precise || viewer.sent[i] != version) {
                    if (count++ > 0) out.append(',');
                    appendRecord(out, socket, other, precise);
                }
            }
            out.append("],\"removed\":[");
            for (int i = 0; i < viewer.gone.size(); i++) {
                if (i > 0) out.append(',');
                out.append('"').append(viewer.gone.get(i).who().publicId).append('"');
            }
            out.append(']');
            boolean audienceChanged = socket.audienceTold != audience;
            if (audienceChanged) {
                out.append(",\"audience\":").append(audience);
                socket.audienceTold = audience;
            }
            out.append('}');
            if (count > 0 || !viewer.gone.isEmpty() || audienceChanged) delivery.send(socket.id, out.toString());
        }
        if (started) markSent(viewer);
        viewer.gone.clear();
    }

    private void snapshot(Person viewer) {
        for (SocketState socket : viewer.sockets) {
            StringBuilder out = new StringBuilder(1024).append("{\"type\":\"presence.snapshot\",\"people\":[");
            for (int i = 0; i < viewer.watchingCount; i++) {
                if (i > 0) out.append(',');
                Person other = viewer.watching[i];
                appendRecord(out, socket, other, precise(viewer, other));
            }
            out.append("]}");
            delivery.send(socket.id, out.toString());
            socket.started = true;
            // Told again after it: the app forgot it when it left the map
            socket.audienceTold = -1;
        }
        markSent(viewer);
        viewer.gone.clear();
        touch(viewer);
    }

    private static void markSent(Person viewer) {
        for (int i = 0; i < viewer.watchingCount; i++) {
            Person other = viewer.watching[i];
            boolean precise = precise(viewer, other);
            viewer.sent[i] = precise ? other.preciseVersion : other.areaVersion;
            viewer.sentPrecise[i] = precise;
        }
    }

    /** The record, built once per change; the {@code user} the first time on this socket and after a change. */
    private static void appendRecord(StringBuilder out, SocketState socket, Person other, boolean precise) {
        out.append(precise ? preciseRecord(other) : areaRecord(other));
        Integer known = socket.known.get(other.id);
        if (known == null || known != other.summaryVersion) {
            out.append(",\"user\":").append(summaryOf(other));
            socket.known.put(other.id, other.summaryVersion);
        }
        out.append('}');
    }

    private static String preciseRecord(Person person) {
        String record = person.preciseRecord;
        if (record != null && person.preciseRecordVersion == person.preciseVersion) return record;
        StringBuilder out = new StringBuilder(200);
        out.append("{\"userId\":\"").append(person.publicId).append("\",\"position\":{\"latitude\":");
        Wire.micro(out, person.shownLatitude);
        out.append(",\"longitude\":");
        Wire.micro(out, person.shownLongitude);
        out.append("},\"precision\":\"precise\",\"heading\":");
        if (person.shownHeading == Long.MIN_VALUE) out.append("null");
        else out.append(person.shownHeading);
        out.append(",\"speed\":");
        if (person.shownSpeed == Long.MIN_VALUE) out.append("null");
        else Wire.tenths(out, person.shownSpeed);
        out.append(",\"moving\":").append(person.shownMoving == 2 ? "null" : person.shownMoving == 1 ? "true" : "false");
        out.append(",\"avatarVersion\":").append(person.avatarVersion);
        out.append(",\"updatedAt\":\"").append(Wire.time(person.updatedAt)).append('"');
        record = out.toString();
        person.preciseRecord = record;
        person.preciseRecordVersion = person.preciseVersion;
        return record;
    }

    private static String areaRecord(Person person) {
        String record = person.areaRecord;
        if (record != null && person.areaRecordVersion == person.areaVersion) return record;
        StringBuilder out = new StringBuilder(200);
        out.append("{\"userId\":\"").append(person.publicId).append("\",\"position\":{\"latitude\":");
        Wire.micro(out, Math.round(person.areaLatitude * 1e6));
        out.append(",\"longitude\":");
        Wire.micro(out, Math.round(person.areaLongitude * 1e6));
        out.append("},\"precision\":\"area\",\"heading\":null,\"speed\":null,\"moving\":null,\"avatarVersion\":")
                .append(person.avatarVersion)
                .append(",\"updatedAt\":\"").append(Wire.time(person.updatedAt)).append('"');
        record = out.toString();
        person.areaRecord = record;
        person.areaRecordVersion = person.areaVersion;
        return record;
    }

    private void sendToUser(Person person, String frame) {
        for (SocketState socket : person.sockets) delivery.send(socket.id, frame);
    }

    // --- time ---

    /** Without a frame for 45 s (a connection lost without a word): off the map. */
    void expire() {
        long limit = clock.nanos() - config.ttlNanos;
        for (int i = onMap.size() - 1; i >= 0; i--) {
            if (i >= onMap.size()) continue;
            Person person = onMap.get(i);
            if (person.lastFrame < limit) exit(person, false);
        }
    }

    /** Forgets what ran out: cooldowns, pins, invitations, old anchors and searches. */
    void sweep() {
        long now = clock.nanos();
        lastGesture.values().removeIf(at -> now - at >= GESTURE_COOLDOWN);
        lastInvite.values().removeIf(at -> now - at >= INVITE_COOLDOWN);
        lastBroadcast.values().removeIf(at -> now - at >= BROADCAST_COOLDOWN);
        gestureWindow.sweep(now);
        inviteWindow.sweep(now);
        invites.values().removeIf(invite -> now > invite.expires);
        for (Person person : people.values()) person.pinned.values().removeIf(until -> until <= now);
        guard.sweep(now);
        for (Search search : new ArrayList<>(searches.values())) {
            if (!people.containsKey(search.user) && now - search.at >= SEARCH_KEEP_OFFLINE) removeSearch(search);
        }
    }

    void later(long nanos, Runnable run) {
        timers.add(new Timer(clock.nanos() + nanos, timerSequence++, run));
    }

    /** The timers that are due; returns when the next one is (Long.MAX_VALUE: none). */
    long runTimers() {
        long now = clock.nanos();
        Timer next;
        while ((next = timers.peek()) != null && next.due <= now) {
            timers.poll();
            try {
                next.run.run();
            } catch (RuntimeException error) {
                log.error("presence: a timer failed", error);
            }
        }
        next = timers.peek();
        return next == null ? Long.MAX_VALUE : next.due;
    }

    // --- slots ---

    private Person newPerson(UUID user) {
        int slot;
        if (freeCount > 0) {
            slot = freeSlots[--freeCount];
        } else {
            if (nextSlot == MAX_SLOTS) throw new IllegalStateException("presence full");
            if (nextSlot == bySlot.length) grow(bySlot.length * 2);
            slot = nextSlot++;
        }
        Person person = new Person(user, slot, maxShown);
        bySlot[slot] = person;
        people.put(user, person);
        return person;
    }

    private void grow(int size) {
        bySlot = Arrays.copyOf(bySlot, size);
        mark = Arrays.copyOf(mark, size);
        shownMark = Arrays.copyOf(shownMark, size);
        keptMark = Arrays.copyOf(keptMark, size);
    }

    private void forget(Person person) {
        people.remove(person.id);
        bySlot[person.slot] = NOBODY;
        // Stamps of a slot taken again must not look current
        mark[person.slot] = 0;
        shownMark[person.slot] = 0;
        keptMark[person.slot] = 0;
        if (freeCount == freeSlots.length) freeSlots = Arrays.copyOf(freeSlots, freeCount * 2);
        freeSlots[freeCount++] = person.slot;
        person.pinned.clear();
    }

    // --- for tests and metrics ---

    int peopleCount() {
        return people.size();
    }

    int socketCount() {
        return sockets.size();
    }

    @Nullable Person person(UUID user) {
        return people.get(user);
    }

    List<Person> everyone() {
        return List.copyOf(people.values());
    }

    double maxChord() {
        return maxChord;
    }

    /** Every pair is the same seen from both ends, and none breaks a rule: for tests. */
    String invariants() {
        StringBuilder problems = new StringBuilder();
        for (Person viewer : people.values()) {
            if (!viewer.on && (viewer.watchingCount != 0 || !viewer.watchers.isEmpty())) problems.append(viewer).append(" off the map with pairs; ");
            if (viewer.watchingCount > maxShown) problems.append(viewer).append(" over the cap; ");
            for (int i = 0; i < viewer.watchingCount; i++) {
                Person other = viewer.watching[i];
                if (!other.on) problems.append(viewer).append(" sees someone off the map; ");
                if (viewer.blocks(other)) problems.append(viewer).append(" sees someone blocked; ");
                if (!other.watchers.contains(viewer)) problems.append(viewer).append(" missing among the watchers; ");
            }
            for (Person watcher : viewer.watchers) {
                if (watcher.indexInView(viewer) < 0) problems.append(viewer).append(" has a watcher who does not see them; ");
            }
        }
        return problems.toString();
    }
}
