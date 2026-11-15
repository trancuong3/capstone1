def stars_for_round(mistakes: int, hints: int) -> int:
    """Award at least one star; mistakes and hints reduce the maximum of three."""
    return max(1, 3 - min(2, max(0, mistakes) + max(0, hints)))
