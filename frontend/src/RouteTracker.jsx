import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { track } from './utils/analytics'

/**
 * HashRouter changes the URL hash, not pathname via the History API, so
 * PostHog's own SPA pageview autocapture (which patches pushState) never
 * sees route changes here. Fire $pageview manually on each route change
 * instead — the very first load is already captured by posthog.init().
 */
export default function RouteTracker() {
  const location = useLocation()
  const isFirst = useRef(true)

  useEffect(() => {
    if (isFirst.current) { isFirst.current = false; return }
    track('$pageview', { path: location.pathname })
  }, [location.pathname])

  return null
}
