
import re
import unicodedata


def normalize_text(text: str) -> list[str]:
    text = unicodedata.normalize("NFC", text).lower()
    text = re.sub(r"[^\w\s]", "", text)
    return text.split()


def align_text(reference_text: str, transcript: str) -> dict:
    reference = normalize_text(reference_text)
    spoken = normalize_text(transcript)

    n = len(reference)
    m = len(spoken)

    dp = [[0] * (m + 1) for _ in range(n + 1)]

    for i in range(n + 1):
        dp[i][0] = i

    for j in range(m + 1):
        dp[0][j] = j

    # Calculate edit distance
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost = 0 if reference[i - 1] == spoken[j - 1] else 1

            dp[i][j] = min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost
            )

    # Backtrack
    i, j = n, m
    results = []

    while i > 0 or j > 0:

        # MATCH
        if (
            i > 0 and j > 0
            and reference[i - 1] == spoken[j - 1]
            and dp[i][j] == dp[i - 1][j - 1]
        ):
            results.append({
                "book_word": reference[i - 1],
                "spoken_word": spoken[j - 1],
                "book_index": i - 1,
                "spoken_index": j - 1,
                "status": "MATCH"
            })
            i -= 1
            j -= 1

        # INSERT
        elif j > 0 and dp[i][j] == dp[i][j - 1] + 1:
            results.append({
                "book_word": None,
                "spoken_word": spoken[j - 1],
                "book_index": None,
                "spoken_index": j - 1,
                "status": "INSERT"
            })
            j -= 1

        # DELETE
        elif i > 0 and dp[i][j] == dp[i - 1][j] + 1:
            results.append({
                "book_word": reference[i - 1],
                "spoken_word": None,
                "book_index": i - 1,
                "spoken_index": None,
                "status": "DELETE"
            })
            i -= 1

        # SUBSTITUTE
        else:
            results.append({
                "book_word": reference[i - 1],
                "spoken_word": spoken[j - 1],
                "book_index": i - 1,
                "spoken_index": j - 1,
                "status": "SUBSTITUTE"
            })
            i -= 1
            j -= 1

    results.reverse()

    return {
        "distance": dp[n][m],
        "alignment": results
    }



def detect_repeated_words(alignment):
    repeated_words = []

    for i, item in enumerate(alignment):
        if item["status"] != "INSERT":
            continue

        word = item.get("spoken_word")
        if not word:
            continue

        # Check whether this word also appears in a nearby MATCH
        previous_word = (
            alignment[i - 1].get("spoken_word")
            if i > 0 else None
        )
        next_word = (
            alignment[i + 1].get("spoken_word")
            if i + 1 < len(alignment) else None
        )

        if word == previous_word or word == next_word:
            repeated_words.append(word)

    return {
        "repeated_count": len(repeated_words),
        "repeated_words": repeated_words
    }

def detect_hesitations(words, threshold=1.0):
    hesitations = []

    if not words:
        return hesitations

    # Sort words by their start time
    words = sorted(words, key=lambda word: word["start"])

    for i in range(1, len(words)):
        current = words[i - 1]
        next_word = words[i]

        pause = next_word["start"] - current["end"]

        if pause >= threshold:
            hesitations.append({
                "after_word": current["text"],
                "before_word": next_word["text"],
                "pause": round(pause, 2),
            })

    return hesitations


def summarize_hesitations(hesitations):
    return round(
        sum(item["pause"] for item in hesitations),
        2
    )


def summarize_alignment(alignment, words=None, threshold=1.0):
    missing_words = []
    extra_words = []
    substitutions = []

    repeated_result = detect_repeated_words(alignment)

    for item in alignment:
        if item["status"] == "DELETE":
            missing_words.append(item["book_word"])

        elif item["status"] == "INSERT":
            extra_words.append(item["spoken_word"])

        elif item["status"] == "SUBSTITUTE":
            substitutions.append({
                "book_word": item["book_word"],
                "spoken_word": item["spoken_word"],
            })

    hesitations = detect_hesitations(words, threshold)

    return {
        "missing_words": missing_words,
        "extra_words": extra_words,
        "substitutions": substitutions,
        "repeated_count": repeated_result["repeated_count"],
        "repeated_words": repeated_result["repeated_words"],
        "hesitations": hesitations,
        "hesitation_seconds": (
            summarize_hesitations(hesitations)
            if words else None
        ),
    }
