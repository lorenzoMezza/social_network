// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { piazza } from './piazza.js';

// The look of the scene as one set of data (ART-DIRECTION.md), read by the map's
// palette (map/themes/), the sky, the clouds, the light and the weather grade:
//   palette      the map's colours: land, greens, plants, water, roads (their lamps at night),
//                the glass of the blocks
//   atmosphere   the colours of the scene by sun altitude in degrees; between two
//                stops every value is interpolated, so dawn and dusk are smooth:
//                  zenith, horizon   sky gradient
//                  haze, hazeSun     the fog and the horizon haze, away from and on
//                                    the side of the sun (or moon)
//                  light             colour and strength of the direct light
//                  ambientSky/Ground hemisphere light on lit objects (the avatars)
//                  tint, saturation  grade of every map colour (the palette is daylight)
//                  cloudLit/Shade    sunlit tops and shaded undersides of the clouds
//                  stars             star visibility
//                Night stays readable, never black: the map must be usable.
//   overcast     the same colours under a grey sky ([night, day] pairs)
//   weather      how grey skies, rain, storms and snow grade the map
//   aerial       colour shift with distance, air, foreground, drifting mist banks
//   paint        broad drifts of hue and value over the land
//   horizon      height of the haze above the map's edge; hills: their shade
//   shadow       the cloud shadows
//   night        the glow of the lit city on the haze
export const look = piazza;
