
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
    repeated_items = []

    for i, item in enumerate(alignment):
        if item["status"] != "INSERT":
            continue    

        word = item.get("spoken_word")
        if not word:
            continue

        previous = alignment[i - 1] if i > 0 else None
        next_item = (
            alignment[i + 1]
            if i + 1 < len(alignment)
            else None
        )

        matched_item = None

        if (
            previous
            and previous.get("spoken_word") == word
            and previous.get("book_index") is not None
        ):
            matched_item = previous

        elif (
            next_item
            and next_item.get("spoken_word") == word
            and next_item.get("book_index") is not None
        ):
            matched_item = next_item

        if matched_item:
            repeated_items.append({
                "word": word,
                "spoken_index": item["spoken_index"],
                "book_index": matched_item["book_index"],
            })

    return {
        "repeated_count": len(repeated_items),
        "repeated_words": [
            item["word"] for item in repeated_items
        ],
        "repeated_items": repeated_items,
        "repeated_book_indices": list({
            item["book_index"] for item in repeated_items
        }),
    }

def detect_hesitations(words, threshold=2.0):
    hesitations = []

    if not words:
        return hesitations

    words = sorted(words, key=lambda word: word["start"])

    for i in range(1, len(words)):
        current = words[i - 1]
        next_word = words[i]

        pause = next_word["start"] - current["end"]

        if pause < 0:
            continue

        if pause >= threshold:
            hesitations.append({
                "after_word": current["text"],
                "before_word": next_word["text"],
                "after_spoken_index": i - 1,
                "before_spoken_index": i,
                "pause": round(pause, 2),
            })

    return hesitations


def summarize_hesitations(hesitations):
    return round(
        sum(item["pause"] for item in hesitations),
        2
    )


def summarize_alignment(alignment, words=None, threshold=2.0):
    missing_words = []
    extra_words = []
    substitutions = []

    repeated_result = detect_repeated_words(alignment)

    # Ánh xạ vị trí từ được nói sang vị trí từ trong sách
    spoken_to_book = {
        item["spoken_index"]: item["book_index"]
        for item in alignment
        if item["spoken_index"] is not None
        and item["book_index"] is not None
    }

    for item in alignment:
        if item["status"] == "DELETE":
            missing_words.append(item["book_word"])

        elif item["status"] == "INSERT":
            extra_words.append(item["spoken_word"])

        elif item["status"] == "SUBSTITUTE":
            substitutions.append({
                "book_word": item["book_word"],
                "spoken_word": item["spoken_word"],
                "book_index": item["book_index"],
            })

    hesitations = detect_hesitations(words, threshold)

    # Ánh xạ vị trí ngập ngừng sang từ trong sách
    for item in hesitations:
        item["after_book_index"] = spoken_to_book.get(
            item["after_spoken_index"]
        )
        item["before_book_index"] = spoken_to_book.get(
            item["before_spoken_index"]
        )

    return {
        "missing_words": missing_words,
        "extra_words": extra_words,
        "substitutions": substitutions,
        "repeated_count": repeated_result["repeated_count"],
        "repeated_words": repeated_result["repeated_words"],
        "repeated_items": repeated_result["repeated_items"],
        "repeated_book_indices": repeated_result[
            "repeated_book_indices"
        ],
        "hesitations": hesitations,
        "hesitation_seconds": (
            summarize_hesitations(hesitations)
            if words else None
        ),
    }