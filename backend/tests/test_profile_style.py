# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""The look of a profile (API.md, ProfileStyle): only the known values are taken."""


def test_the_notes_effect_is_taken_and_the_replaced_ones_are_not(user):
    answer = user.patch("/v1/me", {"style": {"effect": "notes"}})
    assert answer.status_code == 200, answer.text
    assert answer.json()["style"]["effect"] == "notes"
    # Replaced by the notes: no longer offered
    for effect in ("snow", "lanterns"):
        assert user.patch("/v1/me", {"style": {"effect": effect}}).status_code == 400
