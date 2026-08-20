# Google AdSense setup

Bindary shows a single ad slot (`AdBar`, in [src/AdBar.jsx](../src/AdBar.jsx)) docked at the
bottom of the app, below the library/tasks panes on desktop and above the tab bar on phone.
It periodically requests a fresh ad on its own, rather than staying completely static.

**Read the "About the refresh behavior" section before enabling this in production** — it
explains a real policy tradeoff, not just how the code works.

## How ads are kept off the login/loading screens

The AdSense loader script (`adsbygoogle.js`) is loaded **site-wide from
[index.html](../index.html)**, in the `<head>`, because Google requires that script to be
present on every page for the account to be verified and for any ads to serve at all —
including for AdSense's crawler, which only ever sees the app in its signed-out state, so
the tag has to be there unconditionally.

That script loading does **not** by itself put ads anywhere:

- **Auto ads is turned off** in the AdSense dashboard (Ads → By site → Auto ads). With Auto
  ads off, the site-wide script never scans the page and inserts ads on its own — it only
  ever serves an ad where you've explicitly placed an `<ins class="adsbygoogle">` slot and
  called `push({})` for it.
- The only place that happens is `<AdBar />`, and it is only ever rendered inside the
  **signed-in** branches of the app in [poem-library.jsx](../poem-library.jsx) — never in
  `FirebaseSetupScreen`, `AuthScreen`, or the `Splash` loading screen.

So as long as Auto ads stays off in the dashboard, ads are structurally incapable of
appearing before someone signs in, regardless of how the login/loading screens are styled.
If Auto ads is ever turned back on, that guarantee no longer holds — it would need
per-page-level exclusions instead.

## 1. Create an AdSense account

1. Go to https://www.google.com/adsense and sign up with the Google account you want to own
   the ad revenue (robotduck961@gmail.com or whichever account you use for Bindary).
2. Add your site's URL (e.g. `https://bindary-books.web.app`) when asked.
3. Google reviews the site before it starts serving ads. This can take anywhere from a few
   hours to a couple of weeks. The site needs to be live and reachable during review, so
   deploy Bindary first (`npm run build` + `firebase deploy`) and do the AdSense signup
   against the live URL.

## 2. Verify site ownership with ads.txt

AdSense requires an `ads.txt` file at your site's root confirming you're an authorized
seller. [public/ads.txt](../public/ads.txt) already has this project's real publisher ID:

```
google.com, pub-5369071869400012, DIRECT, f08c47fec0942fa0
```

That's deployed at `https://bindary-books.web.app/ads.txt`. In AdSense, check
**Sites → ads.txt status** — it should flip to "Authorized" once Google re-crawls the file
(can take a day or two). If you ever rotate publisher IDs, get the new one from
**Account → Account information** and swap it into `public/ads.txt` before redeploying.

## 3. Create an ad unit

1. In AdSense, go to **Ads → By ad unit → Display ads**.
2. Create a new **Display ad**, responsive, horizontal-leaning (this matches the bar shape
   `AdBar` renders). Name it something like "Bindary — bottom bar".
3. After saving, AdSense shows you a snippet like:

   ```html
   <ins class="adsbygoogle"
        data-ad-client="ca-pub-1234567890123456"
        data-ad-slot="9876543210"></ins>
   ```

   You only need two values out of it:
   - `data-ad-client` → your **client ID** (`ca-pub-...`)
   - `data-ad-slot` → your **slot ID** (the number)

## 4. Configure Bindary

Two things read the AdSense config, both from `.env` (see `.env.example`):

```bash
VITE_ADSENSE_CLIENT_ID=ca-pub-1234567890123456
VITE_ADSENSE_SLOT_ID=9876543210
VITE_ADSENSE_REFRESH_SECONDS=45
```

- `VITE_ADSENSE_CLIENT_ID` is injected into the site-wide loader `<script>` tag in
  [index.html](../index.html) (via Vite's `%VITE_ADSENSE_CLIENT_ID%` HTML env substitution)
  — this is **already set** in this project's `.env` to `ca-pub-5369071869400012`.
- `VITE_ADSENSE_SLOT_ID` is the specific ad unit `AdBar` renders — **still needs to be filled
  in** with the slot ID from step 3 once you've created the display ad unit. Until then,
  `AdBar` renders nothing (same graceful-degradation pattern used for Firebase config in
  [src/firebase.js](../src/firebase.js)) — the site-wide script is present and the account
  can be verified, but no ad actually shows anywhere yet.
- `VITE_ADSENSE_REFRESH_SECONDS` is how often the slot requests a new ad. **The code clamps
  this to a 30-second floor no matter what you set** — see below for why.

Rebuild (`npm run build`) and redeploy after changing `.env` — Vite bakes these values into
the build output, they aren't read at runtime in the browser.

## 5. About the refresh behavior — read this

Standard AdSense ad units are designed to load **once per page view**. Google's policies
only officially sanction *refreshing* an ad slot to request a new one when you use
**Google Ad Manager**, and even then only at a 30-second-or-slower cadence, tied to a
genuine change in page content, and only while the ad is actually visible on screen.
Bindary is a single-page app on plain AdSense (not Ad Manager), so there is no officially
supported "give me a new ad every N seconds" API here — `AdBar` reconstructs the `<ins>`
element on a timer to trigger a fresh ad request, which is a widely-used but
**self-managed, not Google-sanctioned** technique.

To stay as close to Google's own guidance as possible while still doing this:

- **30-second floor.** `AdBar` clamps `VITE_ADSENSE_REFRESH_SECONDS` to a minimum of 30
  seconds in code ([src/AdBar.jsx](../src/AdBar.jsx)), matching Ad Manager's own minimum.
  You cannot configure it faster than that.
- **Visibility-gated.** The refresh timer only fires while the browser tab is actually
  visible (`document.visibilityState === "visible"`). A backgrounded or minimized tab never
  generates a "refreshed" impression — Google explicitly treats those as invalid traffic.
- **One slot only.** There's exactly one ad slot on the page, so refreshing it never
  inflates the ad-to-content ratio.

**This still isn't the same as Google's officially supported refresh path**, and there's no
guarantee it will always be treated as compliant — AdSense enforcement can change, and
"invalid traffic" findings can lead to ad serving being limited or the account being
suspended, which would stop *all* revenue, not just this slot. Two safer alternatives if
you want to de-risk this further:

- **Turn off the refresh.** Set `VITE_ADSENSE_REFRESH_SECONDS` high enough that it never
  meaningfully refreshes during a session (e.g. `999999`), or remove the refresh `useEffect`
  in `AdBar.jsx` and just call `adsbygoogle.push({})` once on mount. A static slot is fully
  within standard AdSense's normal use.
- **Use Google's own Anchor ads (Auto ads).** AdSense has a built-in "Anchor ad" format —
  a persistent bar pinned to the top or bottom of the viewport — that Google serves and
  refreshes entirely on its own, fully compliant by construction. Enable it under
  **Ads → By site → Auto ads → Anchor ads** in the AdSense dashboard; no code changes
  needed, though it replaces the custom `AdBar` placement described here.

Keep an eye on the **Policy center** in your AdSense dashboard after enabling this — that's
where Google surfaces any invalid-traffic or policy warnings before serving is restricted.

## 6. Testing

- Ads will not show on `localhost` / `npm run dev` in most cases — AdSense only serves ads
  on domains you've verified and that have passed review. You'll see empty space where the
  bar would be (or nothing, if the slot fails to load) during local development; that's
  expected, not a bug.
- Once deployed to the approved domain, ads can still take a few minutes to start appearing
  after a brand-new site is approved.
- Ad blockers (uBlock Origin, Brave's built-in blocker, etc.) will hide the bar entirely —
  test in a browser/profile without one if you're checking that ads render at all.

## Files involved

| File | Purpose |
|---|---|
| [index.html](../index.html) | Loads the site-wide `adsbygoogle.js` script (client ID injected from `VITE_ADSENSE_CLIENT_ID`) — present on every page, including the login/loading screens, as Google requires. |
| [src/AdBar.jsx](../src/AdBar.jsx) | The ad component: renders the `<ins>` slot and runs the visibility-gated refresh timer. Only ever mounted while signed in. |
| [poem-library.jsx](../poem-library.jsx) | Renders `<AdBar />` in both the desktop layout (bottom of `app-main`) and phone layout (above the tab bar), and defines the `.ad-bar` styling in the `CSS` block. |
| [public/ads.txt](../public/ads.txt) | Publisher authorization file required by AdSense — needs your real `pub-...` ID before deploying. |
| [.env.example](../.env.example) | Documents the three `VITE_ADSENSE_*` variables. |
