import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 *  AdBar — a single persistent Google AdSense slot that periodically
 *  requests a fresh ad. See documentation/adsense-setup.md for the
 *  full setup guide and the policy reasoning behind the choices below.
 *
 *  The AdSense loader script itself is loaded site-wide from index.html
 *  (Google requires it on every page). Auto ads is turned off in the
 *  AdSense dashboard, so that script alone never places ads on its own —
 *  ads only ever appear where this component renders an <ins> slot, and
 *  AdBar only ever mounts once a user is signed in (see poem-library.jsx).
 *  That's what keeps ads off the login and loading screens.
 *
 *  Standard AdSense (unlike Google Ad Manager) has no official "refresh
 *  this slot" API — Google's own ad-refresh policy only sanctions
 *  refreshing ads through Ad Manager, at a 30-second-or-slower cadence,
 *  tied to genuine content change, and only while the ad is actually
 *  viewable. This component gets as close to that as is possible on
 *  plain AdSense:
 *    - the refresh interval is clamped to a 30s floor, regardless of config
 *    - the timer only ticks while the tab is visible (Page Visibility API) —
 *      a backgrounded/hidden tab never generates a "refreshed" impression
 *    - there is exactly one ad slot on the page, so refreshing it never
 *      multiplies the ad-to-content ratio
 *  This is still a self-managed technique rather than an officially
 *  supported one, so it carries some residual policy risk. If AdSense
 *  ever flags the account, switch this slot to a static (non-refreshing)
 *  unit — see the docs for how.
 * ------------------------------------------------------------------ */

const ADSENSE_CLIENT = (import.meta.env.VITE_ADSENSE_CLIENT_ID || "").trim();
const ADSENSE_SLOT = (import.meta.env.VITE_ADSENSE_SLOT_ID || "").trim();
const REQUESTED_REFRESH_SECONDS = Number(import.meta.env.VITE_ADSENSE_REFRESH_SECONDS) || 45;
const MIN_REFRESH_SECONDS = 30; // Google's own floor for any ad-refresh technique
const REFRESH_SECONDS = Math.max(MIN_REFRESH_SECONDS, REQUESTED_REFRESH_SECONDS);

export const adsenseConfigured = Boolean(ADSENSE_CLIENT && ADSENSE_SLOT);

export default function AdBar() {
  const [refreshIndex, setRefreshIndex] = useState(0);
  const timerRef = useRef(null);

  /* the refresh cadence — visibility-gated, floor-clamped */
  useEffect(() => {
    if (!adsenseConfigured) return;
    const tick = () => {
      if (document.visibilityState === "visible") setRefreshIndex((n) => n + 1);
    };
    const start = () => {
      clearInterval(timerRef.current);
      timerRef.current = setInterval(tick, REFRESH_SECONDS * 1000);
    };
    start();
    const onVisibility = () => { if (document.visibilityState === "visible") start(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timerRef.current);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /* request an ad for the current <ins> — fires on first mount and every refresh.
     The adsbygoogle.js loader (from index.html) queues this even if it hasn't
     finished loading yet, so there's no need to wait for a "ready" signal. */
  useEffect(() => {
    if (!adsenseConfigured) return;
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch {
      // ad blocker, offline, or the slot has no measurable size yet — safe to skip
    }
  }, [refreshIndex]);

  if (!adsenseConfigured) return null;

  return (
    <div className="ad-bar" role="complementary" aria-label="Advertisement">
      <span className="ad-bar-label">Advertisement</span>
      {/* the `key` forces a fresh DOM node per refresh — AdSense ties its slot
          state to the specific <ins> element, so a new node means a new ad request */}
      <ins
        key={refreshIndex}
        className="adsbygoogle"
        style={{ display: "block", width: "100%" }}
        data-ad-client={ADSENSE_CLIENT}
        data-ad-slot={ADSENSE_SLOT}
        data-ad-format="horizontal"
        data-full-width-responsive="true"
      />
    </div>
  );
}
