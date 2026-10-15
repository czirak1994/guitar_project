/**
 * analytics.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin wrapper around PostHog so the rest of the app never touches the SDK
 * directly. No-ops everywhere when VITE_POSTHOG_KEY isn't set — same pattern
 * as CLERK_ENABLED, so analytics is opt-in per environment and local/dev
 * never sends real events.
 *
 * Pageviews (and UTM/referrer on them) are captured automatically by
 * PostHog once initialized — that's what answers "did the Reddit post
 * actually send anyone here". Everything else is an explicit funnel step,
 * captured deliberately rather than via autocapture, so the events map
 * onto the actual guest → signup → paid funnel instead of every click.
 */
import posthog from 'posthog-js'

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com'

let initialized = false

export function initAnalytics() {
  if (!POSTHOG_KEY || initialized) return
  posthog.init(POSTHOG_KEY, {
    api_host: POSTHOG_HOST,
    capture_pageview: true,
    capture_pageleave: true,
    autocapture: false,
  })
  initialized = true
}

/** Link the current (possibly anonymous) PostHog session to a known user_id. */
export function identifyUser(distinctId, props = {}) {
  if (!POSTHOG_KEY || !distinctId) return
  try { posthog.identify(distinctId, props) } catch { /* analytics must never break the app */ }
}

export function track(event, props = {}) {
  if (!POSTHOG_KEY) return
  try { posthog.capture(event, props) } catch { /* analytics must never break the app */ }
}
