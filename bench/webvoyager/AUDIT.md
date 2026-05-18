# WebVoyager Bench Date Audit — 2026-05-14

Categorizes all 643 tasks in `bench/webvoyager/data/data/WebVoyager_data.jsonl` for date-staleness as of 2026-05-14. The companion `patches.json` (same directory) is the machine-readable form; this document is the human-readable rationale.

Patches operate on the `ques` field only. A task NOT in `patches.json` defaults to **keep** (no modification).

## Summary

- Total tasks: 643
- Tasks containing an explicit year token (2020-2050): 96
- `substitute`: 74
- `remove`: 2
- `keep` (year-bearing but historical-fact / incidental year): 20
- `keep` (relative-date phrasing, year-free — resolved dynamically by the site): 23
- `keep` (no temporal reference at all): 524

## Methodology

Each task was classified along one axis:

1. **Forward-scheduling / recency marker** — the date is a *scheduling input* (book a hotel on X) or a *recency proxy* ("projects created in 2023"). These were `substitute`d to 2027 (or 2028 for round-trips that cross year-end). 2027 was chosen because:
   - It is 19+ months in the future from 2026-05-14, so Booking/Google Flights will return real inventory.
   - It is far enough out that a re-run in late 2026 still finds it future-dated.
   - 2026 was rejected because we are already 4.5 months into 2026, so most early-2026 dates are stale.
2. **Historical fact query** — the date is the *thing being asked about*. E.g. "NBA scores December 25, 2023" — substituting 2027 would query a game that has not been played. These were `keep`.
3. **Event-concluded with no future analog** — the question requires a specific past event AND a specific past cross-reference. E.g. "papers announced in December 2023 that mention AAAI 2024 acceptance" — there is no 2027 analog because AAAI 2027 acceptance announcements do not exist yet. These were `remove`.
4. **Relative-date phrasing** ("today", "tomorrow", "this week") — resolved dynamically by the live site. `keep` and rely on the site.

Edge cases handled:
- **Leap-day collision (Booking--28)**: original task uses `February 22 to February 29, 2024` (2024 is a leap year). 2027 is not. The substitution shifts the end date to Feb 28 to remain a valid date; the task intent (one-week Dubai stay) is preserved.
- **Year-end-spanning flights (Google Flights--12, --17)**: depart Dec 2023, return Jan 2024 → depart Dec 2027, return Jan 2028. The 2-year forward shift keeps the round-trip semantics.
- **Standalone-year recency markers (Amazon--30/39, GitHub--36, Huggingface--20)**: where the task only contains a bare "2024" or "2022" with no surrounding date phrase, the year token alone is substituted. `2024 → 2027`, `2022 → 2027`.
- **BBC News--18 ("best podcasts for 2023")**: substituted to 2026, not 2027 — this is a recency marker for the BBC's *current-year* list, and BBC won't have a 2027 list page in May 2026.

## Per-site distribution

| Site | Total | Substituted | Removed | Kept (year-bearing) |
| --- | ---: | ---: | ---: | ---: |
| Allrecipes | 45 | 0 | 0 | 0 |
| Amazon | 41 | 2 | 0 | 0 |
| Apple | 43 | 1 | 0 | 0 |
| ArXiv | 43 | 0 | 1 | 5 |
| BBC News | 42 | 1 | 0 | 0 |
| Booking | 44 | 32 | 0 | 0 |
| Cambridge Dictionary | 43 | 0 | 0 | 0 |
| Coursera | 42 | 0 | 0 | 0 |
| ESPN | 44 | 0 | 1 | 7 |
| GitHub | 41 | 3 | 0 | 0 |
| Google Flights | 42 | 32 | 0 | 0 |
| Google Map | 41 | 0 | 0 | 0 |
| Google Search | 43 | 1 | 0 | 2 |
| Huggingface | 43 | 2 | 0 | 0 |
| Wolfram Alpha | 46 | 0 | 0 | 6 |
| **Total** | **643** | **74** | **2** | **20** |

## Per-task entries

### Substituted

- **Amazon--30** — find: `2024` → replace: `2027` — *"released in 2024" is a recency marker that becomes stale; 2027 preserves the "recent year" intent.*
- **Amazon--39** — find: `2024` → replace: `2027` — *"published in 2024" is a recency marker; 2027 preserves the "recent travel guide" intent.*
- **Apple--9** — find: `January 10, 2024` → replace: `January 10, 2027` — *forward-scheduling in-store pickup; substitution preserves scheduling intent.*
- **BBC News--18** — find: `2023` → replace: `2026` — *"best PodCasts for 2023" is a recency marker for the BBC current-year list; 2026 is the latest year that should have a list page.*
- **Booking--5** — find: `Jan 1 to Jan 4, 2024` → replace: `Jan 1 to Jan 4, 2027` — *forward-scheduling hotel search; substitution preserves 4-day stay intent.*
- **Booking--8** — find: `20/12/2023 - 21/12/2023` → replace: `20/12/2027 - 21/12/2027` — *forward-scheduling Chennai hotel; preserves 1-night stay intent.*
- **Booking--10** — find: `February 14-21, 2024` → replace: `February 14-21, 2027` — *forward-scheduling Valentine's week; preserves week-long Paris stay.*
- **Booking--11** — find: `March 20-27, 2024` → replace: `March 20-27, 2027` — *forward-scheduling Chicago week.*
- **Booking--12** — find: `January 5th, 2024` → replace: `January 5th, 2027` — *forward-scheduling 5-night Paris stay.*
- **Booking--13** — find: `February 14-21, 2024` → replace: `February 14-21, 2027` — *forward-scheduling Paris family stay.*
- **Booking--14** — find: `March 3-5, 2024` → replace: `March 3-5, 2027` — *forward-scheduling Paris weekend.*
- **Booking--15** — find: `from January 10, 2024, to January 20, 2024` → replace: `from January 10, 2027, to January 20, 2027` — *forward-scheduling Rome 10-day stay; both dates substituted in one find/replace.*
- **Booking--16** — find: `January 15, 2024` → replace: `January 15, 2027` — *forward-scheduling 5-night Paris stay.*
- **Booking--17** — find: `February 14, 2024` → replace: `February 14, 2027` — *forward-scheduling 5-night Paris stay.*
- **Booking--18** — find: `between February 14th, 2024, and February 21st, 2024` → replace: `between February 14th, 2027, and February 21st, 2027` — *forward-scheduling London couple stay.*
- **Booking--19** — find: `from March 18, 2024, to March 20, 2024` → replace: `from March 18, 2027, to March 20, 2027` — *forward-scheduling Paris weekend stay.*
- **Booking--20** — find: `February 28 to March 2, 2024` → replace: `February 28 to March 2, 2027` — *forward-scheduling Rome 3-night stay.*
- **Booking--21** — find: `March 10, 2024` → replace: `March 10, 2027` — *forward-scheduling Sydney 4-night stay.*
- **Booking--22** — find: `March 15 to March 22, 2024` → replace: `March 15 to March 22, 2027` — *forward-scheduling Amsterdam week.*
- **Booking--23** — find: `February 20, 2024` → replace: `February 20, 2027` — *forward-scheduling Tokyo 5-night stay.*
- **Booking--24** — find: `February 25-28, 2024` → replace: `February 25-28, 2027` — *forward-scheduling Barcelona stay.*
- **Booking--25** — find: `March 1 to March 7, 2024` → replace: `March 1 to March 7, 2027` — *forward-scheduling Lisbon 6-night stay.*
- **Booking--26** — find: `February 20-23, 2024` → replace: `February 20-23, 2027` — *forward-scheduling Paris stay.*
- **Booking--27** — find: `February 28 to March 4, 2024` → replace: `February 28 to March 4, 2027` — *forward-scheduling Melbourne stay.*
- **Booking--28** — find: `February 22 to February 29, 2024` → replace: `February 22 to February 28, 2027` — *forward-scheduling Dubai week; Feb 29 only exists in leap years — 2027 not leap, switched to Feb 28.*
- **Booking--29** — find: `March 5 to March 7, 2024` → replace: `March 5 to March 7, 2027` — *forward-scheduling Toronto 2-night stay.*
- **Booking--30** — find: `March 20 to March 23, 2024` → replace: `March 20 to March 23, 2027` — *forward-scheduling London filter task.*
- **Booking--31** — find: `March 1-7, 2024` → replace: `March 1-7, 2027` — *forward-scheduling Rio de Janeiro week.*
- **Booking--32** — find: `February 24 to February 27, 2024` → replace: `February 24 to February 27, 2027` — *forward-scheduling Sydney filter task.*
- **Booking--34** — find: `March 15 to March 18, 2024` → replace: `March 15 to March 18, 2027` — *forward-scheduling Berlin 3-night stay.*
- **Booking--36** — find: `March 20 to March 23, 2024` → replace: `March 20 to March 23, 2027` — *forward-scheduling Rome budget hotel.*
- **Booking--37** — find: `between March 20, 2024, and March 25, 2024` → replace: `between March 20, 2027, and March 25, 2027` — *forward-scheduling Bali resort.*
- **Booking--38** — find: `February 28 to March 4, 2024` → replace: `February 28 to March 4, 2027` — *forward-scheduling Vienna 4-night stay.*
- **Booking--39** — find: `February 24-26, 2024` → replace: `February 24-26, 2027` — *forward-scheduling Toronto pet-friendly stay.*
- **Booking--40** — find: `6 March to 8 March 2024` → replace: `6 March to 8 March 2027` — *forward-scheduling Shenzhen stay.*
- **Booking--42** — find: `March 1 to March 7, 2024` → replace: `March 1 to March 7, 2027` — *forward-scheduling Hokkaido week.*
- **GitHub--11** — find: `January 2023` → replace: `January 2027` — *"newly created project initiated in January 2023" is a recency marker; substitution preserves "recently created" intent.*
- **GitHub--28** — find: `2023-12-29` → replace: `2027-12-29` — *"most starred repos created after date" is a recency marker; substitution preserves the "recently created" intent.*
- **GitHub--36** — find: `2022` → replace: `2027` — *"new open-source project created in 2022" is a recency marker; substitution preserves "recently created" intent.*
- **Google Flights--1** — find: `February 17, 2024` → replace: `February 17, 2027` — *forward-scheduling one-way; "today" wording is rhetorical since explicit date given.*
- **Google Flights--10** — find: `January 25, 2024, and returning on February 15, 2024` → replace: `January 25, 2027, and returning on February 15, 2027` — *forward-scheduling round-trip.*
- **Google Flights--11** — find: `February 10, 2024, and a return on February 24, 2024` → replace: `February 10, 2027, and a return on February 24, 2027` — *forward-scheduling round-trip.*
- **Google Flights--12** — find: `December 25, 2023, and returning on January 5, 2024` → replace: `December 25, 2027, and returning on January 5, 2028` — *forward-scheduling round-trip spanning year-end.*
- **Google Flights--13** — find: `January 10, 2024, and a return on January 24, 2024` → replace: `January 10, 2027, and a return on January 24, 2027` — *forward-scheduling round-trip.*
- **Google Flights--14** — find: `January 10, 2024, and returning on January 17, 2024` → replace: `January 10, 2027, and returning on January 17, 2027` — *forward-scheduling round-trip.*
- **Google Flights--15** — find: `February 12th, 2024, and returning on February 26th, 2024` → replace: `February 12th, 2027, and returning on February 26th, 2027` — *forward-scheduling round-trip.*
- **Google Flights--16** — find: `January 15, 2024` → replace: `January 15, 2027` — *forward-scheduling one-way.*
- **Google Flights--17** — find: `December 27, 2023, and returning on January 10, 2024` → replace: `December 27, 2027, and returning on January 10, 2028` — *forward-scheduling round-trip spanning year-end.*
- **Google Flights--18** — find: `January 25, 2024, and returning on February 15, 2024` → replace: `January 25, 2027, and returning on February 15, 2027` — *forward-scheduling round-trip.*
- **Google Flights--19** — find: `January 25, 2024` → replace: `January 25, 2027` — *forward-scheduling one-way.*
- **Google Flights--20** — find: `March 5, 2024, and returning on March 12, 2024` → replace: `March 5, 2027, and returning on March 12, 2027` — *forward-scheduling round-trip.*
- **Google Flights--21** — find: `February 25, 2024` → replace: `February 25, 2027` — *forward-scheduling one-way.*
- **Google Flights--22** — find: `March 15, 2024, and returning on March 22, 2024` → replace: `March 15, 2027, and returning on March 22, 2027` — *forward-scheduling round-trip.*
- **Google Flights--23** — find: `February 28, 2024` → replace: `February 28, 2027` — *forward-scheduling one-way.*
- **Google Flights--24** — find: `March 1, 2024, and returning on March 8, 2024` → replace: `March 1, 2027, and returning on March 8, 2027` — *forward-scheduling round-trip.*
- **Google Flights--25** — find: `March 10, 2024` → replace: `March 10, 2027` — *forward-scheduling one-way business class.*
- **Google Flights--26** — find: `February 26, 2024, and returning on February 28, 2024` → replace: `February 26, 2027, and returning on February 28, 2027` — *forward-scheduling round-trip.*
- **Google Flights--27** — find: `March 30, 2024` → replace: `March 30, 2027` — *forward-scheduling one-way.*
- **Google Flights--28** — find: `February 27, 2024, and returning on March 1, 2024` → replace: `February 27, 2027, and returning on March 1, 2027` — *forward-scheduling round-trip.*
- **Google Flights--29** — find: `March 5, 2024, and returning on March 15, 2024` → replace: `March 5, 2027, and returning on March 15, 2027` — *forward-scheduling non-stop round-trip.*
- **Google Flights--30** — find: `March 20, 2024` → replace: `March 20, 2027` — *forward-scheduling one-way.*
- **Google Flights--31** — find: `March 25, 2024` → replace: `March 25, 2027` — *forward-scheduling one-way economy.*
- **Google Flights--32** — find: `March 3, 2024, and returning on March 10, 2024` → replace: `March 3, 2027, and returning on March 10, 2027` — *forward-scheduling round-trip.*
- **Google Flights--33** — find: `February 27, 2024` → replace: `February 27, 2027` — *forward-scheduling one-way.*
- **Google Flights--34** — find: `March 15, 2024` → replace: `March 15, 2027` — *forward-scheduling business class one-way.*
- **Google Flights--35** — find: `February 21, 2024` → replace: `February 21, 2027` — *forward-scheduling one-way.*
- **Google Flights--36** — find: `March 28, 2024, and returning on April 4, 2024` → replace: `March 28, 2027, and returning on April 4, 2027` — *forward-scheduling round-trip.*
- **Google Flights--37** — find: `February 28, 2024, and returning on March 3, 2024` → replace: `February 28, 2027, and returning on March 3, 2027` — *forward-scheduling round-trip.*
- **Google Flights--38** — find: `March 8, 2024` → replace: `March 8, 2027` — *forward-scheduling one-way.*
- **Google Flights--39** — find: `March 20, 2024` → replace: `March 20, 2027` — *forward-scheduling one-way.*
- **Google Flights--41** — find: `8 March 2024` → replace: `8 March 2027` — *forward-scheduling one-way business class.*
- **Google Search--39** — find: `2024` → replace: `2027` — *"top trending destinations for 2024" is a recency marker; 2027 preserves the current-year-trending intent.*
- **Huggingface--0** — find: `March 2023` → replace: `March 2027` — *"last update within March 2023" is a recency marker; substitution preserves "recently updated" intent.*
- **Huggingface--20** — find: `2022` → replace: `2027` — *"last updated in 2022" is a recency marker; substitution preserves "recently updated" intent.*

### Removed

- **ArXiv--15** — `Searching Chinese Benchmark on ArXiv, how many papers announced in December 2023 mention being accepted for AAAI 2024?` — *Cross-references AAAI 2024 acceptance announcements made in December 2023 — both events have concluded and no plausible 2027 substitution preserves the task semantics (AAAI 2027 acceptances will not yet be announced in late 2026).*
- **ESPN--33** — `Locate the latest ESPN articles discussing potential MVP candidates in the NFL for 2023 season.` — *"Latest ESPN articles discussing MVP candidates for 2023 season" — the 2023 NFL season has concluded and MVP voting is settled; "latest articles" implies current-season speculation that no longer exists. Substituting 2027 fails because that season has not yet been played.*

### Keep — year-bearing but historical-fact (no patch needed)

These tasks contain an explicit year token but the year *is* the data being queried. Substituting it would change the question; keeping it preserves the task because the underlying site (ArXiv archive, ESPN season pages, Wolfram Alpha historical data, fixed YouTube videos) still resolves the original query.

- **ArXiv--14** — "SimCSE papers announced in October 2023" — historical paper count, ArXiv archives are stable.
- **ArXiv--29** — "Papers with Neural Network Optimization title in 2023" — historical count, stable on ArXiv.
- **ArXiv--31** — "Graph Neural Networks abstract papers Jan 1-3, 2024" — historical 3-day window, stable count on ArXiv.
- **ArXiv--36** — "CVPR 2023 / CVPR2023 journal ref search" — historical conference, stable archived count on ArXiv.
- **ArXiv--42** — "Article between 1 Jan 2000 and 1 Jan 2005 about SVMs (ACL Workshop)" — fixed historical 5-year window in the deep past.
- **ESPN--15** — "NBA scores December 25, 2023" — historical game results, archived on ESPN.
- **ESPN--16** — "NBA schedule December 25, 2023" — historical schedule, archived.
- **ESPN--17** — "NBA Power Index 2023-24" — archived season page remains on ESPN.
- **ESPN--19** — "Boston Celtics Roster 2023-24 highest salary" — archived season roster.
- **ESPN--30** — "NHL Standings 2023-24" — archived final standings.
- **ESPN--31** — "NY Yankees Roster 2023-24 heaviest infielder" — archived season roster.
- **ESPN--38** — "Lakers Stats 2023-24 Anthony Davis games played" — archived season stats.
- **Google Search--8** — "Oscars 2023: Must-See Moments!" — the YouTube video at that exact title still exists; substituting the year breaks the title match.
- **Google Search--14** — "James Smith retired ... 2020-2021 club membership" — fixed biographical fact about a specific retired player.
- **Wolfram Alpha--9** — Annual energy production of Diablo Canyon 2 in 2010 — historical fact query; Wolfram still resolves it.
- **Wolfram Alpha--10** — Geomagnetic field on June 20, 2023 in Oslo — historical fact, fixed date.
- **Wolfram Alpha--17** — Average movie ticket price in 2023 — historical fact query.
- **Wolfram Alpha--23** — Population growth rate of Canada from 2020 to 2023 — fixed historical interval.
- **Wolfram Alpha--33** — Itaipu Dam electrical output in 2023 — historical fact query.
- **Wolfram Alpha--37** — Date math between February 12, 2024 and August 9, 2050 — both inputs are intentionally fixed.

### Keep — relative-date phrasing (resolved dynamically)

These tasks use phrases like "today", "tomorrow", "this week", or "last week". The live site resolves them at query time, so no patch is needed. Task IDs:

`Apple--10`, `ArXiv--9`, `ArXiv--16`, `ArXiv--21`, `ArXiv--23`, `ArXiv--26`, `BBC News--6`, `BBC News--39`, `ESPN--4`, `ESPN--13`, `ESPN--26`, `ESPN--29`, `ESPN--32`, `GitHub--9`, `GitHub--15`, `GitHub--17`, `GitHub--22`, `GitHub--39`, `Google Search--11`, `Google Search--22`, `Google Search--34`, `Huggingface--6`, `Huggingface--16`


### Keep — no temporal reference (524 tasks)

The remaining 524 tasks have no year token and no relative-date phrase. They are recipe lookups, dictionary queries, map queries, etc. — fully time-independent. Not enumerated here.

## Verification

Every `substitute.find` in `patches.json` was verified to appear EXACTLY ONCE in the corresponding task's `ques` field. Run the verifier:

```bash
python3 -c "
import json, re
tasks = {t['id']: t for t in (json.loads(l) for l in open('bench/webvoyager/data/data/WebVoyager_data.jsonl'))}
p = json.load(open('bench/webvoyager/patches.json'))
for tid, patch in p['patches'].items():
    if patch['action'] != 'substitute': continue
    q = tasks[tid]['ques']
    assert patch['find'] in q, f'{tid}: find not in ques'
    assert q.count(patch['find']) == 1, f'{tid}: find is ambiguous'
print('OK', len(p[\"patches\"]))"
```
