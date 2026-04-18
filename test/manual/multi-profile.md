# Multi-Profile Manual QA Checklist

Required before publishing any Safari Pilot release that touches extension/daemon code.

## Setup
1. Enable multiple Safari profiles (Safari → Settings → Profiles)
2. Install the candidate Safari Pilot build (`npm run verify:extension:smoke` done first)
3. Enable the extension in EACH profile

## Per-Profile Test
For each profile:
- [ ] Open a test tab (about:blank OK)
- [ ] Run `safari_extension_health` — verify connected
- [ ] Run `safari_query_shadow` on a Shadow-DOM site — verify result returns with engine=extension

## Concurrent-Profile Test
With all profiles active:
- [ ] Trigger the hourly health-check cron ≥ twice (wait >60 min)
- [ ] Verify no duplicate-execution of any commandId across profiles (check daemon log)

## Acknowledge
After all checks pass, create the flag file:
```
touch .multi-profile-verified-$(git rev-parse HEAD)
```
This flag file is consumed by the pre-publish hook.
