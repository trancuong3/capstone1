from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo


def local_schedule_to_utc(
    local_date: date,
    local_time: time,
    timezone_name: str,
) -> datetime | None:
    """Resolve a recurring local wall-clock time without guessing through DST gaps.

    A nonexistent local time is skipped for that date. During a fall-back overlap,
    the first occurrence is chosen, so one schedule can only fire once per day.
    """
    zone = ZoneInfo(timezone_name)
    wall_time = datetime.combine(local_date, local_time.replace(tzinfo=None))
    candidates: set[datetime] = set()
    for fold in (0, 1):
        local = wall_time.replace(tzinfo=zone, fold=fold)
        utc_value = local.astimezone(timezone.utc)
        round_trip = utc_value.astimezone(zone).replace(tzinfo=None)
        if round_trip == wall_time:
            candidates.add(utc_value)
    if not candidates:
        return None
    return min(candidates)
