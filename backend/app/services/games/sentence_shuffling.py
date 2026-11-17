from __future__ import annotations

import random
from collections.abc import Sequence
from uuid import UUID


def shuffle_token_ids(
    token_ids: Sequence[UUID],
    *,
    rng: random.Random | random.SystemRandom | None = None,
) -> list[UUID]:
    shuffled = list(token_ids)
    source = rng or random.SystemRandom()
    source.shuffle(shuffled)
    if len(shuffled) > 1 and shuffled == list(token_ids):
        offset = source.randrange(1, len(shuffled))
        shuffled = shuffled[offset:] + shuffled[:offset]
    return shuffled
