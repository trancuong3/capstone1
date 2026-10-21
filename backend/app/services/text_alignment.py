
import re
import unicodedata


def normalize_text(text: str) -> list[str]:
    # Normalize Unicode and convert to lowercase
    text = unicodedata.normalize("NFC", text).lower()

    # Remove punctuation
    text = re.sub(r"[^\w\s]", "", text)

    # Split text into tokens
    return text.split()


def align_text(reference_text: str, transcript: str) -> dict:
    reference = normalize_text(reference_text)
    spoken = normalize_text(transcript)

    n = len(reference)
    m = len(spoken)

    # Create DP table``
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
                dp[i - 1][j] + 1,       # Missing book word
                dp[i][j - 1] + 1,       # Extra transcript word
                dp[i - 1][j - 1] + cost # Match or substitution
            )

    # Backtrack to find word alignment
    i, j = n, m
    results = []

    while i > 0 or j > 0:
        # 1. Match identical words first
        if (
            i > 0 and j > 0
            and reference[i - 1] == spoken[j - 1]
            and dp[i][j] == dp[i - 1][j - 1]
        ):
            results.append({
                "book_word": reference[i - 1],
                "spoken_word": spoken[j - 1],
                "status": "MATCH"
            })
            i -= 1
            j -= 1

        # 2. Prefer INSERT when it has the same cost
        elif (
            j > 0
            and dp[i][j] == dp[i][j - 1] + 1
        ):
            results.append({
                "book_word": None,
                "spoken_word": spoken[j - 1],
                "status": "INSERT"
            })
            j -= 1

        # 3. Missing word in transcript
        elif (
            i > 0
            and dp[i][j] == dp[i - 1][j] + 1
        ):
            results.append({
                "book_word": reference[i - 1],
                "spoken_word": None,
                "status": "DELETE"
            })
            i -= 1

        # 4. Different words
        else:
            results.append({
                "book_word": reference[i - 1],
                "spoken_word": spoken[j - 1],
                "status": "SUBSTITUTE"
            })
            i -= 1
            j -= 1

    results.reverse()

    return {
        "distance": dp[n][m],
        "alignment": results
    }

#Lưu trữ các từ bị thiếu, từ thừa và các từ thay thế
def summarize_alignment(alignment):
    missing_words = []
    extra_words = []
    substitutions = []

    for item in alignment:
        if item["status"] == "DELETE":
            missing_words.append(item["book_word"])

        elif item["status"] == "INSERT":
            extra_words.append(item["spoken_word"])

        elif item["status"] == "SUBSTITUTE":
            substitutions.append({
                "book_word": item["book_word"],
                "spoken_word": item["spoken_word"]
            })

    return {
        "missing_words": missing_words,
        "extra_words": extra_words,
        "substitutions": substitutions
    }