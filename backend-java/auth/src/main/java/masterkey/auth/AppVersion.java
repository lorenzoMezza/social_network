// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.auth;

import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * Which app is asking ({@code X-Client: 1.2.0 (ios)}, API.md Conventions): one older than the
 * minimum is answered 426 {@code upgrade_required}, and the app asks to update. Nothing to
 * compare (no minimum set, no header, a header that is not a version: a store's notice, a
 * browser opening a data export) is served as ever.
 */
public final class AppVersion {

    private static final Pattern VERSION = Pattern.compile("[0-9]{1,6}(\\.[0-9]{1,6}){0,3}");

    private final int @Nullable [] minimum;

    public AppVersion(@Nullable String minimum) {
        if (minimum == null || minimum.isBlank()) {
            this.minimum = null;
        } else {
            if (!VERSION.matcher(minimum.strip()).matches()) throw new IllegalArgumentException("MIN_APP_VERSION is not a version");
            this.minimum = parts(minimum.strip());
        }
    }

    public boolean tooOld(@Nullable String client) {
        int[] floor = minimum;
        if (floor == null || client == null) return false;
        String version = client.strip();
        int space = version.indexOf(' ');
        if (space >= 0) version = version.substring(0, space);
        if (!VERSION.matcher(version).matches()) return false;
        int[] mine = parts(version);
        for (int i = 0; i < Math.max(mine.length, floor.length); i++) {
            int a = i < mine.length ? mine[i] : 0;
            int b = i < floor.length ? floor[i] : 0;
            if (a != b) return a < b;
        }
        return false;
    }

    private static int[] parts(String version) {
        // Matched by VERSION: digits separated by single dots, no empty pieces to drop
        String[] pieces = version.split("\\.", -1);
        int[] numbers = new int[pieces.length];
        for (int i = 0; i < pieces.length; i++) numbers[i] = Integer.parseInt(pieces[i]);
        return numbers;
    }
}
