// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

package masterkey.api.chats;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import masterkey.core.ApiError;
import masterkey.core.Body;
import masterkey.core.Ids;
import masterkey.core.Json;
import masterkey.core.Text;
import masterkey.store.db.tables.records.MessagesRecord;
import org.jooq.JSONB;
import org.jspecify.annotations.Nullable;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Polls in chats ({@code moderation.poll_input}, {@code vote_input}, {@code views.poll_view}): the
 * question and the options on the message, the votes in their table. Counts only, however many
 * voted: a message never grows with its chat. {@code mine} only in answers to one person.
 */
final class Polls {

    static final int OPTIONS_MIN = 2;
    static final int OPTIONS_MAX = 10;
    static final int QUESTION_MAX = 200;
    static final int OPTION_MAX = 80;
    /** Where the reader's own choices sit among a poll's votes (Chats.votesOf). */
    static final UUID READER = new UUID(0, 1);

    private Polls() {
    }

    record Input(String question, JSONB poll) {
    }

    static Input input(Body body, UUID creator) {
        String question = body.string("question");
        question = question == null ? "" : Text.words(Text.plain(question));
        if (Text.length(question) < 1 || Text.length(question) > QUESTION_MAX) {
            throw ApiError.badRequest("question: 1–" + QUESTION_MAX + " characters");
        }
        JsonNode options = body.raw("options");
        if (options == null || !options.isArray() || options.size() < OPTIONS_MIN || options.size() > OPTIONS_MAX) {
            throw ApiError.badRequest("options: " + OPTIONS_MIN + "–" + OPTIONS_MAX);
        }
        List<String> texts = new ArrayList<>();
        for (JsonNode option : options) {
            String text = option.isString() ? Text.words(Text.plain(option.stringValue())) : "";
            if (Text.length(text) < 1 || Text.length(text) > OPTION_MAX) throw ApiError.badRequest("each option: 1–" + OPTION_MAX + " characters");
            texts.add(text);
        }
        Set<String> distinct = new HashSet<>();
        for (String text : texts) distinct.add(text.toLowerCase(Locale.ROOT));
        if (distinct.size() != texts.size()) throw ApiError.badRequest("options: all different");
        Boolean multiple = body.has("multiple") ? body.bool("multiple") : Boolean.FALSE;
        ObjectNode poll = Json.object();
        poll.put("question", question);
        ArrayNode list = poll.putArray("options");
        for (int i = 0; i < texts.size(); i++) {
            ObjectNode option = list.addObject();
            option.put("id", "o" + (i + 1));
            option.put("text", texts.get(i));
        }
        poll.put("multiple", Boolean.TRUE.equals(multiple));
        poll.put("closed", false);
        poll.put("creator", creator.toString());
        return new Input(question, JSONB.valueOf(Json.text(poll)));
    }

    static ObjectNode of(MessagesRecord message) {
        JSONB poll = message.getPoll();
        if (poll == null) throw ApiError.notFound("poll not found");
        return (ObjectNode) Json.parse(poll.data());
    }

    /** The choices of a vote, checked against the poll; [] takes the vote back. */
    static List<String> choices(ObjectNode poll, Body body) {
        JsonNode ids = body.raw("optionIds");
        if (ids == null || !ids.isArray()) throw ApiError.badRequest("optionIds: a list of option ids (empty: no vote)");
        Set<String> valid = new HashSet<>();
        for (JsonNode option : poll.get("options")) valid.add(option.get("id").stringValue());
        List<String> choices = new ArrayList<>();
        for (JsonNode id : ids) {
            if (!id.isString()) throw ApiError.badRequest("optionIds: a list of option ids (empty: no vote)");
            choices.add(id.stringValue());
        }
        if (new HashSet<>(choices).size() != choices.size() || !valid.containsAll(choices)) {
            throw ApiError.badRequest("optionIds: options of this poll, once each");
        }
        if (!poll.get("multiple").booleanValue() && choices.size() > 1) throw ApiError.badRequest("this poll takes one option");
        if (poll.get("closed").booleanValue()) throw ApiError.conflict("closed", "the poll is closed");
        return choices;
    }

    /** Poll of API.md: counts, and with {@code withMine} the reader's own choices. */
    static Map<String, Object> view(MessagesRecord message, @Nullable Map<UUID, List<String>> votes, boolean withMine) {
        ObjectNode poll = of(message);
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (JsonNode option : poll.get("options")) counts.put(option.get("id").stringValue(), 0);
        int voters = 0;
        if (votes != null) {
            for (Map.Entry<UUID, List<String>> vote : votes.entrySet()) {
                if (vote.getKey().equals(READER)) continue;
                voters++;
                for (String choice : vote.getValue()) counts.computeIfPresent(choice, (key, count) -> count + 1);
            }
        }
        List<Map<String, Object>> options = new ArrayList<>();
        for (JsonNode option : poll.get("options")) {
            Map<String, Object> view = new LinkedHashMap<>();
            String id = option.get("id").stringValue();
            view.put("id", id);
            view.put("text", option.get("text").stringValue());
            view.put("votes", counts.getOrDefault(id, 0));
            options.add(view);
        }
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("question", poll.get("question").stringValue());
        view.put("options", options);
        view.put("multiple", poll.get("multiple").booleanValue());
        view.put("closed", poll.get("closed").booleanValue());
        view.put("voterCount", voters);
        view.put("creator", Ids.publicId("usr", UUID.fromString(poll.get("creator").stringValue())));
        if (withMine) view.put("mine", votes == null ? List.of() : votes.getOrDefault(READER, List.of()));
        return view;
    }
}
