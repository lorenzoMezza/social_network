// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.core.Ids;
import org.jspecify.annotations.Nullable;

/**
 * Someone with a socket open, as the presence thread knows them: their relations and
 * summary, where they are when on the map, who they see and who sees them. Touched by the
 * presence thread only. {@code toString} says nothing of where they are.
 */
final class Person {

    /** A sent version that forces the record out (someone new on the map). */
    static final long NEW = -1;
    /** The phone has an old record of them: sent again, and their going is told. */
    static final long STALE = -2;

    final UUID id;
    final String publicId;
    final int slot;
    final ArrayList<SocketState> sockets = new ArrayList<>(2);

    // Relations and summary, loaded through Directory before the first matching
    Set<UUID> connections = Set.of();
    Set<UUID> blocked = Set.of();
    boolean relationsLoaded;
    long relationsAsked;
    @Nullable String summary;
    int avatarVersion;
    int summaryVersion;
    long summaryAsked;
    /** A presence frame that came before relations and summary: applied when they arrive. */
    @Nullable SocketState pendingSocket;
    ClientFrame.@Nullable PresenceUpdate pending;

    // On the map
    boolean on;
    Mode mode = Mode.INVISIBLE;
    double latitude;
    double longitude;
    @Nullable Double heading;
    @Nullable Double speed;
    @Nullable Boolean moving;
    Instant updatedAt = Instant.EPOCH;
    long lastFrame;
    @Nullable SocketState owner;
    double[] xyz = new double[3];

    // The area point: the square, the day and the point shown
    boolean areaSet;
    long areaRow;
    long areaColumn;
    long areaDay;
    double areaLatitude;
    double areaLongitude;
    double[] areaXyz = new double[3];

    // What is shown of them: a new version when it changes, so only changes go out
    long preciseVersion;
    long areaVersion;
    long shownLatitude;
    long shownLongitude;
    long shownHeading;
    long shownSpeed;
    int shownMoving;
    @Nullable String preciseRecord;
    long preciseRecordVersion = NEW;
    @Nullable String areaRecord;
    long areaRecordVersion = NEW;

    // Who they see: at most maxShown, and what was last sent to them about each
    Person[] watching;
    long[] sent;
    boolean[] sentPrecise;
    int watchingCount;
    /** Taken off their map since the last round, with what they had been sent. */
    final ArrayList<Gone> gone = new ArrayList<>();
    /** Who has them on the map: they get this person's moves and broadcasts. */
    final ArrayList<Person> watchers = new ArrayList<>(8);
    long worst = Long.MAX_VALUE;
    @Nullable Person worstPerson;
    boolean worstValid;
    long lastRematch;
    double rematchLatitude;
    double rematchLongitude;
    /** Position in the list of the people on the map, -1 when not on it. */
    int onMapIndex = -1;
    boolean touched;
    boolean soon;
    /** Who just waved at them: on their map for a minute (until, in nanos). */
    final Map<UUID, Long> pinned = new HashMap<>();

    record Gone(Person who, long sent, boolean sentPrecise) {
    }

    Person(UUID id, int slot, int maxShown) {
        this.id = id;
        this.publicId = Ids.publicId("usr", id);
        this.slot = slot;
        // One more than the cap: someone new arrives before the worst one leaves
        this.watching = new Person[maxShown + 1];
        this.sent = new long[maxShown + 1];
        this.sentPrecise = new boolean[maxShown + 1];
    }

    boolean ready() {
        return relationsLoaded && summary != null;
    }

    boolean blocks(Person other) {
        return blocked.contains(other.id) || other.blocked.contains(id);
    }

    int indexInView(Person other) {
        for (int i = 0; i < watchingCount; i++) if (watching[i] == other) return i;
        return -1;
    }

    @Override
    public String toString() {
        return "Person[" + publicId + "]";
    }
}
