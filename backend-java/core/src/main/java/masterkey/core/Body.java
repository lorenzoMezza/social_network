// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.core;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;

/**
 * The body of a request, or an object inside it: strict types in one place (JAVA-BACKEND.md
 * §16). A wrong type is a 400, never a 500 and never a silent conversion: {@code 8.0},
 * {@code "8"}, {@code true} and {@code 99999999999} are not integers; {@code 1e999} is not a
 * number; a string with NUL or a lone surrogate is refused or cleaned before Postgres sees it.
 * A field that is missing and one that is {@code null} read the same, except with
 * {@link #has}: for a PATCH, absent and null differ ({@code links: null} clears them).
 */
public final class Body {

    private final JsonNode node;
    private final String path;

    public static Body of(@Nullable JsonNode node) {
        if (node == null || node.isNull() || node.isMissingNode()) return new Body(Json.object(), "");
        if (!node.isObject()) throw ApiError.badRequest("a JSON object is needed");
        return new Body(node, "");
    }

    public static Body empty() {
        return new Body(Json.object(), "");
    }

    private Body(JsonNode node, String path) {
        this.node = node;
        this.path = path;
    }

    private String name(String field) {
        return path.isEmpty() ? field : path + "." + field;
    }

    public boolean has(String field) {
        return node.has(field);
    }

    public boolean isNull(String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull();
    }

    public @Nullable JsonNode raw(String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() ? null : v;
    }

    public JsonNode node() {
        return node;
    }

    public Iterator<String> fieldNames() {
        return node.propertyNames().iterator();
    }

    /** null when absent or null. */
    public @Nullable String string(String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isString()) throw ApiError.badRequest(name(field) + ": a string is needed");
        return clean(v.stringValue(), name(field));
    }

    public String requiredString(String field) {
        String s = string(field);
        if (s == null) throw ApiError.badRequest(name(field) + ": required");
        return s;
    }

    static String clean(String s, String field) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) i++;
            else if (Character.isSurrogate(c)) throw ApiError.badRequest(field + ": invalid text");
        }
        return s.indexOf('\0') >= 0 ? s.replace("\0", "") : s;
    }

    public @Nullable Integer integer(String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isIntegralNumber() || !v.canConvertToInt()) throw ApiError.badRequest(name(field) + ": an integer is needed");
        return v.intValue();
    }

    public @Nullable Long longInteger(String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isIntegralNumber() || !v.canConvertToLong()) throw ApiError.badRequest(name(field) + ": an integer is needed");
        return v.longValue();
    }

    public @Nullable Double number(String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isNumber() || !Double.isFinite(v.doubleValue())) throw ApiError.badRequest(name(field) + ": a number is needed");
        return v.doubleValue();
    }

    public @Nullable Boolean bool(String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isBoolean()) throw ApiError.badRequest(name(field) + ": true or false is needed");
        return v.booleanValue();
    }

    /** An object inside the body; null when absent or null. */
    public @Nullable Body object(String field) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isObject()) throw ApiError.badRequest(name(field) + ": an object is needed");
        return new Body(v, name(field));
    }

    /** A list of strings; null when absent or null. Each item must be a string. */
    public @Nullable List<String> strings(String field, int maxItems) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isArray()) throw ApiError.badRequest(name(field) + ": a list is needed");
        if (v.size() > maxItems) throw ApiError.badRequest(name(field) + ": at most " + maxItems);
        List<String> out = new ArrayList<>(v.size());
        for (JsonNode item : v) {
            if (!item.isString()) throw ApiError.badRequest(name(field) + ": strings only");
            out.add(clean(item.stringValue(), name(field)));
        }
        return out;
    }

    /** A list of objects; null when absent or null. */
    public @Nullable List<Body> objects(String field, int maxItems) {
        JsonNode v = node.get(field);
        if (v == null || v.isNull()) return null;
        if (!v.isArray()) throw ApiError.badRequest(name(field) + ": a list is needed");
        if (v.size() > maxItems) throw ApiError.badRequest(name(field) + ": at most " + maxItems);
        List<Body> out = new ArrayList<>(v.size());
        int i = 0;
        for (JsonNode item : v) {
            if (!item.isObject()) throw ApiError.badRequest(name(field) + ": objects only");
            out.add(new Body(item, name(field) + "[" + i++ + "]"));
        }
        return out;
    }
}
