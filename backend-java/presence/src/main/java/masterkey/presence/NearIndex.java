// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.presence;

import ch.ethz.globis.phtree.PhTreeMultiMapF;

/**
 * Points on the sphere (three coordinates in metres, {@link masterkey.core.Geo#xyz}) by an
 * integer id: who is nearest to a point (JAVA-BACKEND.md §5, Indice in memoria). A multimap:
 * two people on the very same point do not overwrite each other. The query object is reused,
 * so an index belongs to one thread.
 */
final class NearIndex {

    /** One hit of a search: return false to stop it. */
    interface Hits {
        boolean hit(int id, double chord);
    }

    private final PhTreeMultiMapF<Boolean> tree = PhTreeMultiMapF.create(3);
    private final PhTreeMultiMapF.PhKnnQueryMMF<Boolean> query;
    private final PhTreeMultiMapF.PhRangeQueryMMF<Boolean> range;
    private final double[] center = new double[3];
    private int size;

    NearIndex() {
        query = tree.nearestNeighbour(1, new double[3]);
        range = tree.rangeQuery(1, new double[3]);
    }

    void add(int id, double[] xyz) {
        tree.put(xyz.clone(), id, Boolean.TRUE);
        size++;
    }

    void move(int id, double[] from, double[] to) {
        if (tree.update(from, id, to) == null) throw new IllegalStateException("index entry missing");
    }

    void remove(int id, double[] xyz) {
        if (tree.remove(xyz, id) == null) throw new IllegalStateException("index entry missing");
        size--;
    }

    int size() {
        return size;
    }

    /**
     * The {@code k} nearest to the point, nearest first, until {@code hits} says stop.
     * Returns how many it went through.
     */
    int nearest(double x, double y, double z, int k, Hits hits) {
        if (size == 0) return 0;
        center[0] = x;
        center[1] = y;
        center[2] = z;
        query.reset(k, null, center);
        int found = 0;
        while (query.hasNext() && found < k) {
            var entry = query.nextEntryReuse();
            found++;
            if (!hits.hit((int) entry.getId(), entry.dist())) break;
        }
        return found;
    }

    /** Every point within {@code chord} of the point, in no order. */
    void within(double x, double y, double z, double chord, Hits hits) {
        if (size == 0) return;
        center[0] = x;
        center[1] = y;
        center[2] = z;
        range.reset(chord, center);
        while (range.hasNext()) {
            // Not the reused entry: the range query of this version does not fill its id
            var entry = range.nextEntry();
            double[] key = entry.getKey();
            double dx = key[0] - x, dy = key[1] - y, dz = key[2] - z;
            if (!hits.hit((int) entry.getId(), Math.sqrt(dx * dx + dy * dy + dz * dz))) return;
        }
    }
}
