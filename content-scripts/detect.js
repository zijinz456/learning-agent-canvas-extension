// Learning Agent — Canvas LMS DOM Detection
// Tiny script injected on all HTTPS pages via content_scripts.
// Checks for Canvas-specific DOM elements and notifies the service worker.
(function () {
  'use strict';

  // Canvas LMS pages have <div id="application" class="ic-app">
  const app = document.getElementById('application');
  if (!app || !app.classList.contains('ic-app')) return;

  // This is a Canvas page — tell the service worker.
  chrome.runtime.sendMessage({
    type: 'CANVAS_DETECTED',
    url: window.location.origin,
  }).catch(() => {
    // Extension context may be invalidated (e.g. during update). Ignore.
  });
})();
