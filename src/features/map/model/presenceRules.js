// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Who sees whom on the map: the rules the backend will apply (the app never receives
// positions it should not show). Both people's modes count, and the less precise wins:
//                 their: visible     approximate   invisible
//   you visible          precise     area          —
//   you approximate      area        area          —
//   you invisible        —           —             —
// "Area": never the real coordinates. The server knows the user only to the
// APPROXIMATE_RADIUS_M square of a grid they are in, and sends a point near its centre,
// moved by an amount derived from a server secret, the same for that person, square
// and day (a new random point at every update would give the real one away by
// averaging): docs/API.md, Presence rules. Only people within the map's range are
// ever shown (MAP_RANGE_M), never farther.

export const MAP_RANGE_M = 1000; // what the user is told: the map shows about 1 km
export const APPROXIMATE_RADIUS_M = 300;
