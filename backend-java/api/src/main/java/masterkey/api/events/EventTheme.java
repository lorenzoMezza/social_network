// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.events;

import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.core.Json;
import masterkey.core.Text;
import org.jooq.JSONB;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * Event.theme (JAVA-BACKEND.md §16, Il tema di un evento): six fields, always all of them,
 * written in jsonb in this shape and never as the JSON received. Every write replaces the whole
 * theme; colours are kept as they came; gold is never a colour of the theme.
 */
public record EventTheme(@Nullable String color, @Nullable String beam, String beamStyle, @Nullable String emoji, String background,
                         String title) {

    static final Pattern HEX = Pattern.compile("#[0-9A-Fa-f]{6}");
    static final Set<String> BEAM_STYLES = Set.of("beam", "pulse", "helix", "stardust", "veil");
    static final Set<String> BACKGROUNDS = Set.of("plain", "glow", "tint", "aurora", "pattern");
    static final Set<String> TITLES = Set.of("classic", "bold", "serif", "mono");

    /** null when the theme is null; 400 for a value that is not allowed. */
    public static @Nullable EventTheme of(@Nullable JsonNode value) {
        if (value == null || value.isNull()) return null;
        if (!value.isObject()) throw ApiError.badRequest("theme: an object or null");
        Body body = Body.of(value);
        String emoji = body.string("emoji");
        if (emoji != null) {
            emoji = Text.plain(emoji);
            if (Text.length(emoji) > 16 || emoji.codePoints().anyMatch(Character::isLetterOrDigit)) {
                throw ApiError.badRequest("theme.emoji: one emoji");
            }
        }
        return new EventTheme(hex(body, "color"), hex(body, "beam"), oneOf(body, "beamStyle", BEAM_STYLES, "beam"), emoji,
                oneOf(body, "background", BACKGROUNDS, "plain"), oneOf(body, "title", TITLES, "classic"));
    }

    private static @Nullable String hex(Body body, String field) {
        String value = body.string(field);
        if (value != null && !HEX.matcher(value).matches()) throw ApiError.badRequest("theme." + field + ": #RRGGBB");
        return value;
    }

    private static String oneOf(Body body, String field, Set<String> allowed, String otherwise) {
        String value = body.string(field);
        if (value == null) return otherwise;
        if (!allowed.contains(value)) throw ApiError.badRequest("theme." + field + ": one of " + new TreeSet<>(allowed));
        return value;
    }

    public JSONB jsonb() {
        return JSONB.valueOf(Json.text(this));
    }

    public static @Nullable JsonNode read(@Nullable JSONB value) {
        return value == null ? null : Json.parse(value.data());
    }
}
