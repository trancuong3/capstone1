"""Measured CTC word delimiters, never word-length or next-onset interpolation.

Use a delimiter only when the independently greedy-decoded neighboring words
and delimiter have exactly the same text/frame spans as the forced path. This
rejects a space inserted solely because the supplied transcript demanded it.
Thresholds are research guards, not calibrated probabilities of correctness.
"""
import math

BOUNDARY_VERSION = "ctc-delimiter-envelope-v3"
MIN_DELIMITER_SUPPORT = 0.85
MIN_WORD_SUPPORT = 0.55
FRAME_MS = 20


def _words(tokens, separator):
    words, pieces = [], []
    previous_end = 0
    for token in tokens:
        if (set(token) != {"text", "start", "end", "support"}
                or not isinstance(token["text"], str) or not token["text"]
                or type(token["start"]) is not int or type(token["end"]) is not int
                or not previous_end <= token["start"] < token["end"]
                or type(token["support"]) not in (int, float)
                or not math.isfinite(token["support"]) or not 0 <= token["support"] <= 1):
            raise ValueError("INVALID_ALIGNMENT_PATH")
        previous_end = token["end"]
        if token["text"] == separator:
            if pieces:
                words.append({"text": "".join(p["text"] for p in pieces),
                              "start": pieces[0]["start"], "end": pieces[-1]["end"],
                              "support": min(p["support"] for p in pieces), "separator": token})
                pieces = []
            elif words:
                # Several separators are not one unambiguous boundary.
                words[-1]["separator"] = None
        else:
            pieces.append(token)
    if pieces:
        words.append({"text": "".join(p["text"] for p in pieces),
                      "start": pieces[0]["start"], "end": pieces[-1]["end"],
                      "support": min(p["support"] for p in pieces), "separator": None})
    return words


def trusted_delimiters(expected_words, forced_tokens, greedy_tokens, separator="|"):
    forced = _words(forced_tokens, separator)
    greedy = _words(greedy_tokens, separator)
    if len(forced) != len(expected_words) or any(word["text"] != expected
                                               for word, expected in zip(forced, expected_words)):
        raise ValueError("INVALID_ALIGNMENT_PATH")
    greedy_positions = {(word["text"], word["start"], word["end"]): index
                        for index, word in enumerate(greedy)}
    result = {}
    for index, (word, following) in enumerate(zip(forced, forced[1:])):
        position = greedy_positions.get((word["text"], word["start"], word["end"]))
        other_position = greedy_positions.get((following["text"], following["start"], following["end"]))
        mark = word["separator"]
        if (position is None or other_position != position + 1 or mark is None
                or min(word["support"], following["support"]) < MIN_WORD_SUPPORT
                or mark["support"] < MIN_DELIMITER_SUPPORT
                or not 1 <= mark["end"] - mark["start"] <= 5):
            continue
        independent_mark = greedy[position]["separator"]
        if (independent_mark is None or independent_mark["start"] != mark["start"]
                or independent_mark["end"] != mark["end"]
                or min(greedy[position]["support"], greedy[other_position]["support"]) < MIN_WORD_SUPPORT
                or independent_mark["support"] < MIN_DELIMITER_SUPPORT):
            continue
        # Center of the measured event window, not a midpoint between syllables.
        time_ms = round((mark["start"] + mark["end"]) * FRAME_MS / 2)
        if not word["end"] * FRAME_MS <= time_ms < following["start"] * FRAME_MS:
            continue
        result[index] = {"time_ms": time_ms, "support": min(mark["support"], independent_mark["support"])}
    return result
