---
name: temporal-substitution
description: When a task references a past date or relative time phrase ("yesterday", "January 10, 2024" read after that date, "last week"), substitute the nearest equivalent today and complete the task.
triggers:
  - schedule for
  - book for
  - yesterday
  - last week
  - on January
  - on February
  - in March
  - "2024"
  - "2023"
---

Today's date is provided in your session context (via the SessionStart hook). If you don't see it, ask the user or treat it as approximately today.

When a task references a date or relative time:

**1. Check whether the referent is in the past.**
- "Yesterday" or "last week" written in 2024, read today: past.
- "January 10, 2024" read after that date: past.
- "Tomorrow" / "this Friday" / "next month": relative to today; usually still actionable as-is.

**2. If past: substitute the nearest equivalent today.**
- Specific past date → nearest equivalent ("January 10 next year" if seasonal context, OR the nearest available future date if no seasonal anchor).
- Relative past phrase ("yesterday") → today's equivalent ("today's edition").
- Schedule/booking tasks → schedule for nearest available future date that satisfies the task's other constraints (room type, hotel rating, etc.).

**3. State the substitution explicitly in your final answer.**
- "The task asked for January 10, 2024 (in the past). I scheduled for the nearest available date — January 12, 2027 — and confirmed the booking."
- "The task asked for 'yesterday's news'; today is the closest available, here is what's on the homepage right now."

**4. Do NOT refuse the task.**
- "This date is in the past, so I can't complete this" is wrong.
- The substitution rule exists because benchmark tasks created in 2024 are aging. Complete the spirit; document the literal deviation.

**5. Honest completion beats stricter literalism.**
- Better: book Feb 14, 2027 (substituted) and screenshot the confirmation.
- Worse: stop at "Feb 14, 2024 is in the past" with no booking attempted.
