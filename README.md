# WatchdogClientV2: Browser Tab Crash Detection & Reporting

## 1. Visible Crashes: Design Decision

This library is designed to detect and report **browser tab crashes that occur while the tab is visible to the user**. We intentionally focus on visible crashes.

General Scenario:
- User opens a tab
- User navigates to a page
- App crashes
- User refreshes or opens new tab
- Watchdog detects the crash and reports it to Sentry while also attaching breadcrumbs and other trace context from the crashed session.


**Design Principle:**
- We only classify and report crashes that occur when the tab's last known state was `visible`.
- We use a cascade of rules to further classify visible crashes (e.g., "fresh" after session start, or "recent" after becoming visible).

## 2. Browser API Support

### APIs Used
- `visibilitychange` (for tracking when the tab becomes visible/hidden)
- `beforeunload` (for detecting clean closes and marking sessions as not crashed)

### Cross-Browser Reliability
- **`visibilitychange`** is supported in all modern browsers (Chrome, Firefox, Safari, Edge, mobile browsers).
- **`beforeunload`** is also widely supported, but may be throttled or skipped in some mobile scenarios or when the browser is killed abruptly.
- We do **not** rely on `unload` or `pagehide` for crash detection currently

**Note:** No browser event is 100% reliable for all crash scenarios (e.g., process kill, power loss), so we use heuristics and localStorage to detect unclean closes on next load.

## 3. Example: Using with Sentry Loader CDN Script

```html
<!-- Sentry Loader Script -->
<script src="https://js.sentry-cdn.com/YOUR_PUBLIC_KEY.min.js" crossorigin="anonymous" data-lazy="no"
  onload="if (window.sentryOnLoad) window.sentryOnLoad();"></script>

<!-- WatchdogClientV2 Script -->
<script src="./watchdogClientV2.js"></script>
<script>
  // Initialize Sentry first
  window.sentryOnLoad = (function(orig) {
    return function() {
      if (orig) orig();
      // Initialize WatchdogClientV2 with your DSN after Sentry is ready
      window.initWatchdogV2 && window.initWatchdogV2('https://YOUR_PUBLIC_KEY@oXXXX.ingest.sentry.io/PROJECT_ID');
    };
  })(window.sentryOnLoad);
</script>
```
- **Order matters:** Sentry must be initialized before the watchdog client.
- Replace `YOUR_PUBLIC_KEY` and `PROJECT_ID` with your Sentry project values.

## 4. SPA Usage (React, Vue, Angular, etc.)

### **Initialization**
- Call `window.initWatchdogV2(dsn)` **as early as possible** in your app's startup (e.g., in your main entry file or root component).
- This ensures all tab visibility and unload events are tracked from the start of the session.

### **Client-Side Routing**
- For most SPAs, you only need to initialize the watchdog **once** at app startup.
- The watchdog is designed to persist across client-side route changes.


**Questions or issues?**
Open an issue or PR on this repo!

To start the demo, run `python3 -m http.server` in this directory and open http://localhost:8000 in your browser.

**Compatibility:** Compatible with Sentry JavaScript SDK Loader and npm packages version 8.55.0 and above.

## TODOs
- Add cleanup logic for localStorage
- Stress test across browsers
- Package via npm
- Pull scope from crashed sessions eagerly to attach post crash
- Evaluate listener cleanup strategy if necessary
- Assess heap or other memory APIs to add breadcrumbs or context dynamically that can be helpful


``` 