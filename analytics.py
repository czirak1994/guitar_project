"""Server-side analytics (PostHog) for events the frontend can't see.

The frontend tracks its own funnel (record started, analysis submitted,
guest limit hit, upgrade clicked, ...) via posthog-js. This module is only
for events whose ground truth lives on the backend — right now that's the
Stripe subscription webhook, which fires after the user has left the site
for Stripe's hosted checkout page.

Uses the same distinct_id (the Clerk user_id) the frontend identifies with
via posthog.identify(), so frontend and backend events land on one person's
timeline in PostHog instead of two disconnected profiles.

No-ops when POSTHOG_API_KEY isn't set.
"""

import os
import posthog

POSTHOG_API_KEY = os.getenv("POSTHOG_API_KEY")
posthog.api_key = POSTHOG_API_KEY
posthog.host = os.getenv("POSTHOG_HOST", "https://us.i.posthog.com")
posthog.disabled = not POSTHOG_API_KEY


def track(distinct_id: str, event: str, properties: dict | None = None):
    if not POSTHOG_API_KEY or not distinct_id:
        return
    try:
        posthog.capture(event, distinct_id=distinct_id, properties=properties or {})
    except Exception as e:
        print(f"[Analytics] capture failed: {e}")
