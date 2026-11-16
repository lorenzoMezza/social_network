// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.people;

import java.util.Map;
import java.util.Set;
import masterkey.core.Json;
import tools.jackson.databind.node.ObjectNode;

/** The fixed parts of a profile ({@code store.py}, {@code routes/people.py}). */
public final class Profiles {

    private Profiles() {
    }

    /** Handles that would read as the app speaking: nobody gets them, however they sign in. */
    public static final Set<String> RESERVED_USERNAMES = Set.of(
            "admin", "administrator", "support", "help", "official", "staff", "moderator", "system", "masterkey", "security", "team");

    /** ProfileStyle: every key and the values it may take. */
    public static final Map<String, Set<String>> STYLE_VALUES = Map.of(
            "backdrop", Set.of("studio", "sunset", "ocean", "forest", "candy", "lemon", "night", "ember"),
            "pedestal", Set.of("none", "disc", "ring"),
            "effect", Set.of("none", "sparkles", "bubbles", "fireflies", "notes", "hearts", "confetti", "petals"),
            "greeting", Set.of("wave", "fistpump", "handsair", "dab", "dontsee", "punch", "shrug"),
            "outline", Set.of("outline", "none"));

    public static final Set<String> SETTINGS = Set.of("notifyEventUpdates", "notifyConnections", "notifyMessages");
    /** What a profile's story shows to others: kinds of moments. */
    public static final java.util.List<String> STORY_KINDS = java.util.List.of("organized", "going", "reviewed", "connected");
    public static final java.util.List<String> STORY_AUDIENCES = java.util.List.of("connections", "everyone");

    public static ObjectNode defaultStyle() {
        ObjectNode style = Json.object();
        style.put("backdrop", "ocean");
        style.put("pedestal", "disc");
        style.put("effect", "sparkles");
        style.put("greeting", "wave");
        style.put("outline", "outline");
        return style;
    }

    public static ObjectNode defaultSettings() {
        ObjectNode settings = Json.object();
        for (String key : new String[] {"notifyEventUpdates", "notifyConnections", "notifyMessages"}) settings.put(key, true);
        return settings;
    }

    public static ObjectNode defaultStory() {
        ObjectNode story = Json.object();
        for (String kind : STORY_KINDS) story.put(kind, true);
        return story;
    }
}
