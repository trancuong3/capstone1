"""Exact ordered word edit distance for repeated singing transcripts.

SequenceMatcher chooses longest matching blocks greedily. On repeated choruses
a block from a later chorus can hide many earlier matches. Minimum edit distance
accounts for every insertion, deletion and substitution in temporal order.
The bit-vector recurrence avoids a quadratic matrix at the 10,000-unit limit.
This agreement is a review signal, never a calibrated timing accuracy score.
"""


def transcript_agreement(expected, recognized):
    longest = max(len(expected), len(recognized))
    if not longest:
        return 0.0
    if not expected or not recognized:
        return 0.0
    pattern, stream = (expected, recognized) if len(expected) <= len(recognized) else (recognized, expected)
    masks = {}
    for index, word in enumerate(pattern):
        masks[word] = masks.get(word, 0) | (1 << index)
    width = len(pattern)
    mask = (1 << width) - 1
    high = 1 << (width - 1)
    positive, negative, distance = mask, 0, width
    for word in stream:
        equal = masks.get(word, 0)
        vertical = equal | negative
        horizontal = (((equal & positive) + positive) ^ positive) | equal
        plus = negative | ~(horizontal | positive)
        minus = positive & horizontal
        if plus & high:
            distance += 1
        elif minus & high:
            distance -= 1
        plus = (plus << 1) | 1
        minus <<= 1
        positive = (minus | ~(vertical | plus)) & mask
        negative = (plus & vertical) & mask
    return max(0.0, 1.0 - distance / longest)
