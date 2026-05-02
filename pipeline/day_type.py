"""
Day-type classification for Norwegian transit data.

Each calendar date maps to one of five categories used to filter and
aggregate delay statistics:

    weekday  — Monday–Friday, ikke helligdag
    saturday — lørdag, ikke helligdag
    sunday   — søndag, ikke helligdag
    holiday  — norsk helligdag (også når den faller på lørdag/søndag)
    may17    — Grunnlovsdag (eget skille pga. parade og avvikende rutemønster)

Priority order (highest first): may17 → holiday → sunday → saturday → weekday.
"""
from datetime import date
from functools import lru_cache

import holidays  # type: ignore


@lru_cache(maxsize=1)
def _no_holidays() -> "holidays.HolidayBase":
    # Cover a generous range so backfills of older data still resolve.
    return holidays.Norway(years=range(2015, 2045))


def compute_day_type(d: date) -> str:
    if d.month == 5 and d.day == 17:
        return "may17"
    if d in _no_holidays():
        return "holiday"
    weekday = d.weekday()  # 0 = Monday … 6 = Sunday
    if weekday == 5:
        return "saturday"
    if weekday == 6:
        return "sunday"
    return "weekday"


__all__ = ["compute_day_type"]
