// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.core;

/**
 * Distances on the sphere, as the app and the Python reference compute them (haversine,
 * radius 6,371,000 m), and the three coordinates in metres on the same sphere that the
 * presence indexes hold (JAVA-BACKEND.md §4.5): the straight distance between two points
 * grows with the distance on the surface, so the order of the nearest is the same, and poles
 * and the antimeridian are not special cases. Indexing latitude and longitude as plain numbers
 * instead would make a "1 km" 744 m wide eastwards in Rome.
 */
public final class Geo {

    public static final double R = 6_371_000;
    public static final double METRES_PER_DEGREE = 111_320;

    private Geo() {
    }

    public static double distance(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double s = Math.sin(dLat / 2);
        double t = Math.sin(dLon / 2);
        double h = s * s + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * t * t;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    public static double distance(Point a, Point b) {
        return distance(a.latitude(), a.longitude(), b.latitude(), b.longitude());
    }

    /** A new array of x, y, z in metres (the PH-Tree may keep the array: never reuse it, §16). */
    public static double[] xyz(double lat, double lon) {
        double a = Math.toRadians(lat);
        double b = Math.toRadians(lon);
        double c = Math.cos(a);
        return new double[] {R * c * Math.cos(b), R * c * Math.sin(b), R * Math.sin(a)};
    }

    /** A distance on the surface as the straight line between its ends (index searches). */
    public static double arcToChord(double metres) {
        return 2 * R * Math.sin(metres / (2 * R));
    }

    public static double chordToArc(double chord) {
        return 2 * R * Math.asin(Math.min(1, chord / (2 * R)));
    }

    /** The point {@code east} and {@code north} metres away (small distances, as util.offset). */
    public static Point offset(double lat, double lon, double eastMetres, double northMetres) {
        return new Point(lat + northMetres / METRES_PER_DEGREE,
                lon + eastMetres / (METRES_PER_DEGREE * Math.cos(Math.toRadians(lat))));
    }

    public static Point offsetBearing(double lat, double lon, double metres, double bearingDegrees) {
        double b = Math.toRadians(bearingDegrees);
        return offset(lat, lon, Math.sin(b) * metres, Math.cos(b) * metres);
    }

    public static boolean validLatitude(double lat) {
        return lat >= -90 && lat <= 90;
    }

    public static boolean validLongitude(double lon) {
        return lon >= -180 && lon <= 180;
    }
}
