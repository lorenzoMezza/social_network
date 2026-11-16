// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.avatars;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import masterkey.core.Json;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * The avatar catalog and its presets (avatar-server/shared/avatarFormat.js; {@code avatars.py}): a saved
 * avatar is checked against the catalog with the rules of {@code avatarFormat.js}
 * ({@code validateAvatar}); who never saved one gets a preset chosen from their id, always the
 * same. Without a catalog only the shape is checked: development only (Settings refuses
 * production without it, §9).
 */
public final class AvatarLibrary {

    public static final String FORMAT = "masterkey.avatar";
    public static final int VERSION = 1;
    static final Pattern HEX = Pattern.compile("#[0-9A-Fa-f]{6}");

    private final Map<String, JsonNode> items = new HashMap<>();
    private final Map<String, JsonNode> slots = new HashMap<>();
    private final List<JsonNode> presets = new ArrayList<>();
    private final boolean loaded;

    public AvatarLibrary(Path folder) {
        boolean ok = false;
        try {
            JsonNode catalog = Json.parse(Files.readAllBytes(folder.resolve("catalog.json")));
            for (JsonNode item : catalog.get("items")) items.put(item.get("id").stringValue(), item);
            for (JsonNode slot : catalog.get("categories")) slots.put(slot.get("id").stringValue(), slot);
            for (JsonNode preset : Json.parse(Files.readAllBytes(folder.resolve("presets.json"))).get("presets")) presets.add(preset.get("avatar"));
            ok = !items.isEmpty();
        } catch (IOException | RuntimeException error) {
            ok = false;
        }
        this.loaded = ok;
    }

    public boolean loaded() {
        return loaded;
    }

    /** The errors of an avatar, and its clean copy when there are none. */
    public record Checked(List<String> errors, @Nullable ObjectNode clean) {
    }

    public Checked validate(@Nullable JsonNode avatar) {
        List<String> errors = new ArrayList<>();
        if (avatar == null || !avatar.isObject()) return new Checked(List.of("not an object"), null);
        JsonNode body = avatar.get("bodyShape");
        JsonNode colors = avatar.get("colors");
        JsonNode wearables = avatar.get("wearables");
        boolean shaped = body != null && body.isString()
                && (colors == null || colors.isNull() || colors.isObject())
                && (wearables == null || wearables.isNull() || wearables.isObject());
        if (shaped && wearables != null && wearables.isObject()) {
            for (JsonNode value : wearables) if (!value.isString()) shaped = false;
        }
        if (!shaped) return new Checked(List.of("bodyShape: a string; colors, wearables: objects of strings"), null);
        JsonNode format = avatar.get("format");
        if (format == null || !FORMAT.equals(format.isString() ? format.stringValue() : null)) errors.add("format must be \"" + FORMAT + "\"");
        JsonNode version = avatar.get("version");
        if (version == null || !version.isIntegralNumber() || version.intValue() != VERSION) errors.add("version must be " + VERSION);
        String bodyShape = body.stringValue();
        JsonNode bodyItem = items.get(bodyShape);
        if (loaded && (bodyItem == null || !"body_shape".equals(bodyItem.get("category").stringValue()))) {
            errors.add("unknown bodyShape \"" + cut(bodyShape) + "\"");
        }
        ObjectNode cleanColors = Json.object();
        for (String key : new String[] {"skin", "hair", "eyes"}) {
            JsonNode value = colors == null || colors.isNull() ? null : colors.get(key);
            if (value == null || !value.isString() || !HEX.matcher(value.stringValue()).matches()) errors.add("colors." + key + " must be #RRGGBB");
            else cleanColors.put(key, value.stringValue().toUpperCase(java.util.Locale.ROOT));
        }
        ObjectNode cleanWearables = Json.object();
        if (wearables != null && wearables.isObject()) {
            if (wearables.size() > 32) errors.add("too many wearables");
            for (Iterator<Map.Entry<String, JsonNode>> it = wearables.properties().iterator(); it.hasNext(); ) {
                Map.Entry<String, JsonNode> entry = it.next();
                String slot = entry.getKey(), id = entry.getValue().stringValue();
                if (loaded) {
                    JsonNode item = items.get(id);
                    if (!slots.containsKey(slot) || "body_shape".equals(slot)) errors.add("unknown slot \"" + cut(slot) + "\"");
                    else if (item == null) errors.add("unknown item \"" + cut(id) + "\"");
                    else if (!slot.equals(item.get("category").stringValue())) errors.add("\"" + cut(id) + "\" is a " + item.get("category").stringValue() + ", not a " + slot);
                    else if (bodyItem != null && !item.get("representations").has(bodyShape)) errors.add("\"" + cut(id) + "\" has no version for " + cut(bodyShape));
                } else if (slot.length() > 40 || id.length() > 200) {
                    errors.add("unknown item \"" + cut(id) + "\"");
                }
                cleanWearables.put(slot, id);
            }
        }
        if (loaded) {
            for (JsonNode slot : slots.values()) {
                JsonNode required = slot.get("required");
                String id = slot.get("id").stringValue();
                if (required != null && required.asBoolean() && !"body_shape".equals(id) && (wearables == null || !wearables.has(id))) {
                    errors.add("missing required slot \"" + id + "\"");
                }
            }
        }
        if (!errors.isEmpty()) return new Checked(errors, null);
        ObjectNode clean = Json.object();
        clean.put("format", FORMAT);
        clean.put("version", VERSION);
        clean.put("bodyShape", bodyShape);
        clean.set("colors", cleanColors);
        clean.set("wearables", cleanWearables);
        return new Checked(List.of(), clean);
    }

    /** A preset for who never saved an avatar, always the same for the same id. */
    public @Nullable JsonNode presetFor(String publicId) {
        if (presets.isEmpty()) return null;
        try {
            byte[] digest = MessageDigest.getInstance("SHA-1").digest(publicId.getBytes(StandardCharsets.UTF_8));
            long index = ((digest[0] & 0xffL) << 24 | (digest[1] & 0xffL) << 16 | (digest[2] & 0xffL) << 8 | (digest[3] & 0xffL)) % presets.size();
            return presets.get((int) index);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private static String cut(String text) {
        return text.length() > 60 ? text.substring(0, 60) : text;
    }
}
