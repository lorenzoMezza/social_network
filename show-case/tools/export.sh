#!/usr/bin/env bash
# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

# From the raw takes (show-case/raw/*.mov, not committed) to what the site shows
# (show-case/media/): one light video per chapter of the page, with its poster.
#   show-case/tools/export.sh
set -euo pipefail
cd "$(dirname "$0")/.."
CLIPS_DIR=raw/clips  # each take cut and scaled (not committed)
mkdir -p media "$CLIPS_DIR"
rm -f media/*.mp4 media/*.jpg
WIDTH=600            # the clips: 600 × 1304, plenty for a phone frame on a page
FADE=0.5             # between the two clips of a chapter

# name  start  length  [A-B*F[,C-D*G]  poster]   (seconds into the raw take; A-B*F plays A to B
# F times faster, for typing and tapping through a form, - for none; the poster is else a frame
# a third of the way in)
CLIPS=(
  "00-map-day 1.0 12.4"
  "01-opening 1.2 13.0"
  "10-spot 2.0 15.2"
  "11-connect 2.0 15.4"
  "04-events 2.4 7.6"
  "05-social 2.0 7.0"
  "07-avatar 2.3 10.6"
  "08-storm 1.8 12.6"
  "09-album 2.0 5.2"
  "12-pin 2.2 24.6 6.4-21.0*3 25.5"
  "16-planned 2.6 59.9 5.5-11.5*3,13.5-20.5*3,24.0-29.0*1.8,35.0-50.5*2,54.0-57.0*2 53.0"
  "13-people 2.6 20.4 11.6-15.2*2 7.2"
  "14-profile 2.4 23.2 - 24.6"
)

for clip in "${CLIPS[@]}"; do
  read -r name start length fast poster <<<"$clip"
  look="fps=30,scale=$WIDTH:-2:flags=lanczos,format=yuv420p"
  if [ -n "${fast:-}" ] && [ "$fast" != - ]; then
    # Played faster: A-B*F, several joined by commas (A-B*F,C-D*G), in order
    graph=$(python3 - "$start" "$length" "$fast" "$look" <<'PY'
import sys
start, length, fast, look = float(sys.argv[1]), float(sys.argv[2]), sys.argv[3], sys.argv[4]
cuts, at = [], start
for part in fast.split(','):
    span, factor = part.split('*')
    a, b = (float(x) for x in span.split('-'))
    cuts += [(at, a, 1.0), (a, b, float(factor))]
    at = b
cuts.append((at, start + length, 1.0))
pieces = [f"[0:v]trim={a}:{b},setpts=(PTS-STARTPTS)/{f}[p{i}]" for i, (a, b, f) in enumerate(cuts)]
print(';'.join(pieces) + ';' + ''.join(f'[p{i}]' for i in range(len(cuts))) + f'concat=n={len(cuts)}:v=1:a=0,{look}[out]')
PY
)
    ffmpeg -y -loglevel error -i "raw/$name.mov" -filter_complex "$graph" -map '[out]' \
      -c:v libx264 -preset slow -crf 27 -profile:v high -movflags +faststart -an "$CLIPS_DIR/$name.mp4"
  else
    ffmpeg -y -loglevel error -ss "$start" -t "$length" -i "raw/$name.mov" -vf "$look" \
      -c:v libx264 -preset slow -crf 27 -profile:v high -movflags +faststart -an "$CLIPS_DIR/$name.mp4"
  fi
  # The poster: what shows before the clip plays
  ffmpeg -y -loglevel error -ss "${poster:-$(python3 -c "print($start + $length / 3)")}" -i "raw/$name.mov" \
    -frames:v 1 -vf "scale=$WIDTH:-2:flags=lanczos" -q:v 3 "$CLIPS_DIR/$name.jpg"
done

# Stills of the connection, step by step (the site shows them in order)
for still in "connect-card 4.6" "connect-code 7.8" "connect-wave 17.2"; do
  read -r name at <<<"$still"
  ffmpeg -y -loglevel error -ss "$at" -i raw/11-connect.mov -frames:v 1 -vf "scale=$WIDTH:-2:flags=lanczos" -q:v 3 "media/$name.jpg"
done

# What the site shows: one video per chapter, two clips joined by a cross-fade where the
# chapter tells two things; the poster is the first clip's
#   name  clip  [clip]
SITE=(
  "opening 01-opening"
  "city 00-map-day 08-storm"
  "people 13-people"
  "pin 12-pin 16-planned"
  "reach 10-spot 04-events"
  "connect 11-connect"
  "plans 05-social 09-album"
  "you 07-avatar 14-profile"
)
for video in "${SITE[@]}"; do
  read -r name first second <<<"$video"
  cp "$CLIPS_DIR/$first.jpg" "media/$name.jpg"
  if [ -z "${second:-}" ]; then
    cp "$CLIPS_DIR/$first.mp4" "media/$name.mp4"
  else
    offset=$(python3 -c "print(round($(ffprobe -v error -show_entries format=duration -of csv=p=0 "$CLIPS_DIR/$first.mp4") - $FADE, 3))")
    ffmpeg -y -loglevel error -i "$CLIPS_DIR/$first.mp4" -i "$CLIPS_DIR/$second.mp4" \
      -filter_complex "[0:v][1:v]xfade=transition=fade:duration=$FADE:offset=$offset,format=yuv420p[out]" -map '[out]' \
      -c:v libx264 -preset slow -crf 27 -profile:v high -movflags +faststart -an "media/$name.mp4"
  fi
  echo "media/$name.mp4 $(du -h "media/$name.mp4" | cut -f1)"
done
