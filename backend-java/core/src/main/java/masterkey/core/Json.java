// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.core;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import tools.jackson.core.JsonGenerator;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.MapperFeature;
import tools.jackson.databind.SerializationContext;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.ValueSerializer;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.module.SimpleModule;
import tools.jackson.databind.node.ObjectNode;

/**
 * The one JSON mapper of the server, for REST, socket and jobs alike (JAVA-BACKEND.md §16).
 * Strict on input (Jackson by default turns {@code 8.5} into {@code 8} and {@code "8"} into a
 * number: bodies are read with {@link Body}, never bound to records), stable on output: map
 * keys sorted (the same body gives the same ETag on every machine), every field present (a
 * nullable field is {@code null}, a list is never null), times with milliseconds.
 */
public final class Json {

    static final DateTimeFormatter TIME =
            DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

    public static final JsonMapper MAPPER = JsonMapper.builder(JsonFactory.builder()
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .streamReadConstraints(StreamReadConstraints.builder()
                            .maxNestingDepth(64).maxStringLength(1 << 20).maxNumberLength(64).build())
                    .build())
            .disable(MapperFeature.ALLOW_COERCION_OF_SCALARS)
            .disable(DeserializationFeature.ACCEPT_FLOAT_AS_INT)
            .enable(DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES)
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            .changeDefaultPropertyInclusion(v -> v.withValueInclusion(JsonInclude.Include.ALWAYS))
            .addModule(new SimpleModule().addSerializer(Instant.class, new ValueSerializer<Instant>() {
                @Override
                public void serialize(Instant value, JsonGenerator out, SerializationContext context) {
                    out.writeString(TIME.format(value));
                }
            }))
            .build();

    private Json() {
    }

    /** {@code 2026-10-15T18:00:00.000Z}: what every time in an answer looks like. */
    public static String time(Instant instant) {
        return TIME.format(instant);
    }

    public static byte[] bytes(Object value) {
        return MAPPER.writeValueAsBytes(value);
    }

    public static String text(Object value) {
        return MAPPER.writeValueAsString(value);
    }

    public static JsonNode tree(Object value) {
        return MAPPER.valueToTree(value);
    }

    public static ObjectNode object() {
        return MAPPER.createObjectNode();
    }

    /** A JSON document read strictly; anything unreadable is a 400. */
    public static JsonNode parse(byte[] bytes) {
        try {
            return MAPPER.readTree(bytes);
        } catch (RuntimeException e) {
            throw ApiError.badRequest("the body is not valid JSON");
        }
    }

    public static JsonNode parse(String text) {
        try {
            return MAPPER.readTree(text);
        } catch (RuntimeException e) {
            throw ApiError.badRequest("not valid JSON");
        }
    }
}
