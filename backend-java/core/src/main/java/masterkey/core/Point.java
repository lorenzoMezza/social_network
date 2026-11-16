// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.core;

/**
 * A place, in WGS 84 degrees. Its {@code toString} says nothing of where: a position must
 * never reach a log, an error message or a dump (JAVA-BACKEND.md §3, §16).
 */
public record Point(double latitude, double longitude) {

    public Point {
        if (!Geo.validLatitude(latitude) || !Geo.validLongitude(longitude)) {
            throw ApiError.badRequest("position out of range");
        }
    }

    @Override
    public String toString() {
        return "Point[…]";
    }
}
