// watchdogClientV2.js
// Clean, minimal watchdog client for tab crash/trace tracking

(function () {
  const SENTRY_RETRY_LIMIT = 1; // Only retry once
  let sentryRetryCount = 0;
  const TAB_STORAGE_PREFIX = 'watchdog_tab_';
  const TRACE_STORAGE_PREFIX = 'watchdog_trace_';
  const PRIMARY_VISIBLE_CRASH_MINUTES = 30; // Adjustable threshold for primary visible crash rule

  // Utility: Generate unique tab ID
  function generateTabId() {
    return `tab_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Utility: Get or create tab ID for this session
  function getTabId() {
    let tabId = localStorage.getItem('watchdog_tab_id');
    if (!tabId) {
      tabId = generateTabId();
      localStorage.setItem('watchdog_tab_id', tabId);
    }
    return tabId;
  }

  // Utility: Get Sentry trace id (if available)
  function getSentryTraceId() {
    if (window.Sentry && typeof window.Sentry.getActiveSpan === 'function' && typeof window.Sentry.spanToJSON === 'function') {
      try {
        const span = window.Sentry.getActiveSpan();
        if (span) {
          const spanJson = window.Sentry.spanToJSON(span);
          if (spanJson && spanJson.trace_id) {
            return spanJson.trace_id;
          }
        }
      } catch (e) {
        console.warn('[WatchdogV2] Error extracting trace id:', e);
      }
    }
    return 'no_trace_id_found';
  }

  // Store visibility/crash context
  function storeTabContext(context) {
    const tabId = getTabId();
    localStorage.setItem(`${TAB_STORAGE_PREFIX}${tabId}`, JSON.stringify(context));
  }

  // Store trace id
  function storeTraceId(traceId) {
    const tabId = getTabId();
    localStorage.setItem(`${TRACE_STORAGE_PREFIX}${tabId}`, JSON.stringify({ trace_id: traceId, tabSessionStart: Date.now() }));
  }

  // Utility: Send event directly to Sentry envelope endpoint
  function sendDirectToSentryEnvelope(event, dsn) {
    // Parse DSN
    const dsnMatch = dsn.match(/^https?:\/\/([^@]+)@([^/]+)\/(\d+)/);
    if (!dsnMatch) {
      console.error('[WatchdogV2] Invalid DSN:', dsn);
      return;
    }
    const [, publicKey, host, projectId] = dsnMatch;
    const url = `https://${host}/api/${projectId}/envelope/`;

    // Envelope headers
    const envelopeHeader = JSON.stringify({
      dsn: dsn,
      sent_at: new Date().toISOString()
    });
    // Item headers
    const itemHeader = JSON.stringify({
      type: 'event'
    });
    // Envelope body
    const envelope = [
      envelopeHeader,
      itemHeader,
      JSON.stringify(event)
    ].join('\n');

    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope'
      },
      body: envelope
    }).then(res => {
      if (res.ok) {
        console.log('[WatchdogV2] Sent event directly to Sentry envelope endpoint');
      } else {
        console.error('[WatchdogV2] Failed to send event to Sentry:', res.status, res.statusText);
      }
    });
  }

  // Review and report unreviewed entries
  function reviewAndReportUnreviewedEntries(dsn) {
    const now = Date.now();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('watchdog_tab_')) {
        try {
          const data = JSON.parse(localStorage.getItem(key));
          if (data && !data.reviewed && data.cleanClose === false) {
            // Skip and remove entries with hidden visibility state if older than 10 minutes
            if (data.lastVisibilityState === 'hidden') {
              const ageMinutes = (now - data.lastVisibilityUpdate) / 60000;
              if (ageMinutes > 10) {
                localStorage.removeItem(key);
                console.log('[WatchdogV2] Skipped and removed hidden state entry older than 10 minutes:', data);
              } else {
                console.log('[WatchdogV2] Skipped hidden state entry (not removed, age < 10 min):', data);
              }
              continue;
            }
            // Mark as reviewed
            data.reviewed = true;
            localStorage.setItem(key, JSON.stringify(data));

            // Try to get trace data for this tab
            const traceKey = `watchdog_trace_${data.tabId}`;
            let traceData = null;
            const storedTrace = localStorage.getItem(traceKey);
            if (storedTrace) {
              traceData = JSON.parse(storedTrace);
            }

            // Compute minutes from session start to last viewed
            const minutesSessionStartToTabLastViewed =
              typeof data.tabSessionStart === 'number' && typeof data.lastVisibilityUpdate === 'number'
                ? Math.floor((data.lastVisibilityUpdate - data.tabSessionStart) / 60000)
                : null;

            // Crash classification rule cascade
            let crashType = 'other';
            if (
              data.lastVisibilityState === 'visible' &&
              data.lastVisibilityUpdate === data.tabSessionStart &&
              data.unloadFired === false
            ) {
              crashType = 'classic_fresh_visible_crash';
            } else if (
              data.lastVisibilityState === 'visible' &&
              typeof data.tabSessionStart === 'number' &&
              typeof data.lastVisibilityUpdate === 'number' &&
              (data.lastVisibilityUpdate - data.tabSessionStart) < PRIMARY_VISIBLE_CRASH_MINUTES * 60000 &&
              data.unloadFired === false
            ) {
              crashType = 'recent_visible_crash';
            }

            // Build Sentry event
            const event = {
              message: '[WatchdogV2] Unclean session detected',
              level: 'warning',
              timestamp: Math.floor(now / 1000),
              extra: {
                watchdog: data,
                traceData: traceData || {},
                minutesSessionStartToTabLastViewed: minutesSessionStartToTabLastViewed
              },
              contexts: {
                trace: {
                  trace_id: traceData && traceData.trace_id ? traceData.trace_id : 'no_trace_id_found'
                }
              },
              tags: {
                watchdog: 'unclean_session',
                crash_type: crashType
              }
            };
            sendDirectToSentryEnvelope(event, dsn);
            console.log('[WatchdogV2] Sent direct Sentry envelope for unclean session:', event);
          }
        } catch (e) {
          // Invalid JSON, remove the entry
          localStorage.removeItem(key);
        }
      }
    }
  }

  // Retry logic for getting trace id
  function tryGetTraceIdWithRetry(retries, delay, onResult) {
    let attempts = 0;
    function attempt() {
      const traceId = getSentryTraceId();
      if (traceId && traceId !== 'no_trace_id_found') {
        onResult(traceId);
      } else if (attempts < retries) {
        attempts++;
        setTimeout(attempt, delay);
      } else {
        onResult(null); // Fallback: no trace id available
      }
    }
    attempt();
  }

  // Main initialization
  function initWatchdog(dsn) {
    if (!window.Sentry) {
      if (sentryRetryCount < SENTRY_RETRY_LIMIT) {
        sentryRetryCount++;
        console.warn('[WatchdogV2] Sentry not found, retrying in 2s...');
        setTimeout(() => initWatchdog(dsn), 2000);
      } else {
        console.warn('[WatchdogV2] Sentry not found after retry, shutting down watchdog.');
      }
      return;
    }

    if (!dsn) {
      console.warn('[WatchdogV2] No DSN provided, cannot send direct envelope events.');
    } else {
      reviewAndReportUnreviewedEntries(dsn);
    }

    const tabId = getTabId();
    const tabSessionStart = Date.now();
    tryGetTraceIdWithRetry(3, 1000, (traceId) => {
      if (traceId) {
        storeTraceId(traceId);
        console.log('[WatchdogV2] Trace ID obtained and stored:', traceId);
      } else {
        storeTraceId('no_trace_id_found');
        console.warn('[WatchdogV2] Could not obtain trace id after retries, proceeding without trace linking.');
      }

      // Track visibility changes
      function handleVisibilityChange() {
        const now = Date.now();
        const minutesSessionStartToTabLastViewed = Math.floor((now - tabSessionStart) / 60000);
        const context = {
          tabId: tabId,
          sessionId: {}, // You can fill this in as needed
          cleanClose: false,
          unloadFired: false,
          reviewed: false,
          tabSessionStart: tabSessionStart,
          lastVisibilityState: document.visibilityState,
          lastVisibilityUpdate: now,
          minutesSessionStartToTabLastViewed: minutesSessionStartToTabLastViewed
        };
        storeTabContext(context);
        console.log('[WatchdogV2] Stored tab context:', context);
      }
      document.addEventListener('visibilitychange', handleVisibilityChange);

      // Safe beforeunload handler management
      function handleBeforeUnload() {
        const now = Date.now();
        const minutesSessionStartToTabLastViewed = Math.floor((now - tabSessionStart) / 60000);
        const context = {
          tabId: tabId,
          sessionId: {},
          cleanClose: true,
          unloadFired: true,
          reviewed: false,
          tabSessionStart: tabSessionStart,
          lastVisibilityState: document.visibilityState,
          lastVisibilityUpdate: now,
          minutesSessionStartToTabLastViewed: minutesSessionStartToTabLastViewed
        };
        storeTabContext(context);
        console.log('[WatchdogV2] Marked clean close:', context);
      }
      // Remove any existing beforeunload handler for this function, then add
      window.removeEventListener('beforeunload', handleBeforeUnload);
      window.addEventListener('beforeunload', handleBeforeUnload);

      // Initial context store
      handleVisibilityChange();
      console.log('[WatchdogV2] Watchdog initialized for tab:', tabId, 'traceId:', traceId || 'no_trace_id_found');

      // Expose cleanup for SPAs or manual teardown
      window.cleanupWatchdogV2 = function() {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
        window.removeEventListener('beforeunload', handleBeforeUnload);
        console.log('[WatchdogV2] Cleaned up event listeners.');
      };
    });
  }

  // Expose init function globally for explicit DSN usage
  window.initWatchdogV2 = initWatchdog;
})(); 