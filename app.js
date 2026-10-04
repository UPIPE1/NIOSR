(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CFG = self.NIOS_CONFIG || {};
  const KEY_ALARM = 'nios.alarm';          // "off" when the user disabled the alarm
  const KEY_ACK = 'nios.alarmStoppedFor';  // detected_at value the user already stopped
  const POLL_MS = 60_000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let status = null;
  let vapidKey = '';
  let nativeServerReady = true;
  let audioCtx = null;
  let alarmTimer = null;
  let alarmHigh = false;
  let msgTimer = null;
  let installEvent = null;

  /* ------------------------------------------------------------- helpers -- */
  function say(text, isError = false) {
    const el = $('msg');
    el.textContent = text;
    el.classList.toggle('error', isError);
    clearTimeout(msgTimer);
    if (text) msgTimer = setTimeout(() => (el.textContent = ''), 7000);
  }

  // Exact date + time, always in India time so it matches the notifications.
  const IST = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
  });
  const fmtIST = (iso) => `${IST.format(new Date(iso))} IST`;

  async function api(action, extra = {}) {
    if (!CFG.FUNCTION_URL || CFG.FUNCTION_URL.includes('YOUR-PROJECT-REF')) {
      throw new Error('Set FUNCTION_URL in config.js first.');
    }
    let res;
    try {
      res = await fetch(CFG.FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
    } catch {
      throw new Error('No connection. Check your internet and try again.');
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error body */ }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  function sameBytes(buf, bytes) {
    const a = new Uint8Array(buf);
    return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
  }

  /* -------------------------------------------------------------- render -- */
  function render() {
    if (!status) return;
    const found = status.result_found === true;
    document.body.classList.toggle('is-found', found);
    $('waitingView').hidden = found;
    $('foundView').hidden = !found;

    // "Last checked" is the last SUCCESSFUL check. A failed attempt never changes it
    // or the result status; it only adds the Check Failed notice.
    const lastOk = status.last_successful_check ? fmtIST(status.last_successful_check) : 'Not checked yet';
    const statusText = found ? '🟢 RESULT DECLARED' : '🟡 Not Declared Yet';

    $('latestStatus').textContent = statusText;
    $('lastChecked').textContent = lastOk;
    $('foundStatus').textContent = statusText;
    $('foundLastChecked').textContent = lastOk;

    if (found) {
      $('matchedText').textContent = status.matched_text || 'The announcement you were waiting for is live.';
      $('foundAt').textContent = status.detected_at ? `Detected ${fmtIST(status.detected_at)}` : '';
    }

    const warn = $('checkWarning');
    if (!found && status.last_check_ok === false) {
      warn.hidden = false;
      $('checkWarningText').textContent =
        `The attempt at ${status.last_checked ? fmtIST(status.last_checked) : 'the last check'} could not read the NIOS site` +
        (status.last_error ? ` (${status.last_error})` : '') +
        '. The status above is from the last successful check. This is not a result.';
    } else {
      warn.hidden = true;
    }
    syncAlarm();
  }

  async function refresh() {
    try {
      const data = await api('status');
      status = data.status;
      if (data.vapidPublicKey) vapidKey = data.vapidPublicKey;
      nativeServerReady = data.nativePushAvailable !== false;
      render();
    } catch (e) {
      if (!status) {
        $('latestStatus').textContent = 'Could not load';
        $('lastChecked').textContent = 'Could not load';
      }
      say(e.message, true);
    }
  }

  /* --------------------------------------------------------------- alarm -- */
  const alarmEnabled = () => localStorage.getItem(KEY_ALARM) !== 'off';
  const alarmNeeded = () =>
    !!status && status.result_found === true && alarmEnabled() &&
    localStorage.getItem(KEY_ACK) !== String(status.detected_at);

  function ensureAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    } catch { /* audio unavailable */ }
  }

  function beep(freq, seconds) {
    if (!audioCtx || audioCtx.state !== 'running') return false;
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
    return true;
  }

  // Vibration is only allowed after the user has tapped the page at least once.
  function buzz(ms) {
    const active = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    if (active && navigator.vibrate) {
      try { navigator.vibrate(ms); } catch { /* ignore */ }
    }
  }

  function alarmTick() {
    ensureAudio();
    alarmHigh = !alarmHigh;
    const played = beep(alarmHigh ? 988 : 659, 0.4);
    $('soundHint').hidden = played;
    if (played) buzz(300);
  }

  function startAlarm() {
    if (alarmTimer) return;
    alarmTick();
    alarmTimer = setInterval(alarmTick, 450);
  }

  function stopAlarmSound() {
    if (alarmTimer) clearInterval(alarmTimer);
    alarmTimer = null;
    buzz(0);
    $('soundHint').hidden = true;
  }

  function syncAlarm() {
    const ringing = alarmNeeded();
    $('stopAlarmBtn').hidden = !ringing;
    if (ringing) startAlarm(); else stopAlarmSound();

    const on = alarmEnabled();
    $('alarmBtn').textContent = on ? 'On' : 'Off';
    $('alarmBtn').setAttribute('aria-pressed', String(on));
  }

  /* --------------------------------------- native app (Median + OneSignal) -- */
  // Inside a Median app there is no browser Web Push. Median bridges to the
  // OneSignal SDK instead, and the server sends through OneSignal.
  const median = () => self.median || self.gonative || null;
  const nativeBridge = () => {
    const m = median();
    return m && m.onesignal ? m : null;
  };
  const isNativeApp = () => !!nativeBridge() || /\b(median|gonative)\b/i.test(navigator.userAgent);

  // Median also pushes the info to a global callback on page load; keep the latest copy.
  let pushedInfo = null;
  self.median_onesignal_info = (info) => { pushedInfo = info; };

  async function waitForBridge(ms) {
    const end = Date.now() + ms;
    while (!nativeBridge() && Date.now() < end) await sleep(150);
    return nativeBridge();
  }

  // Median's bridge calls only work after median.onReady().
  function whenMedianReady(ms) {
    return new Promise((resolve) => {
      const m = median();
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      setTimeout(fin, ms);
      if (m && typeof m.onReady === 'function') {
        try { m.onReady(fin); } catch { fin(); }
      } else {
        fin();
      }
    });
  }

  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), ms))]);

  // Describe an info object WITHOUT revealing its values (tokens stay private).
  function describe(info, depth = 0) {
    if (info === null || info === undefined) return String(info);
    if (typeof info !== 'object') return typeof info;
    return Object.keys(info).slice(0, 12).map((k) => {
      const v = info[k];
      if (typeof v === 'string') return `${k}=text(${v.length})`;
      if (v && typeof v === 'object' && depth < 1) return `${k}={${describe(v, depth + 1)}}`;
      return `${k}=${String(v)}`;
    }).join(', ') || 'empty object';
  }

  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Median's OneSignal SDK v5 bridge nests the device under `subscription`
  // ({ id, token, optedIn }); the older bridge used top-level oneSignalUserId /
  // oneSignalSubscribed. Both shapes are understood.
  function readInfo(info) {
    if (!info || typeof info !== 'object') return null;
    const sub = info.subscription && typeof info.subscription === 'object' ? info.subscription : {};
    const candidates = [
      info.oneSignalUserId, info.subscriptionId, info.pushSubscriptionId, info.playerId,
      sub.id, sub.subscriptionId, sub.pushSubscriptionId, sub.userId, sub.playerId,
    ];
    let id = candidates.map((v) => (typeof v === 'string' ? v.trim() : '')).find((v) => UUID.test(v)) || '';
    if (!id) {
      for (const v of Object.values(sub)) {
        if (typeof v === 'string' && UUID.test(v.trim())) { id = v.trim(); break; }
      }
    }
    const flags = [
      info.oneSignalSubscribed, info.subscribed,
      sub.optedIn, sub.subscribed, sub.isSubscribed, sub.enabled,
    ].filter((v) => typeof v === 'boolean');
    const subscribed = flags.length ? flags.some(Boolean) : !!id; // no flag at all: the test notification will tell
    return { id, subscribed, raw: info };
  }

  // Returns { id, subscribed, raw } or null. Never throws; remembers why in lastNativeProblem.
  let lastNativeProblem = '';
  async function nativeInfo() {
    const b = nativeBridge();
    if (!b) { lastNativeProblem = 'bridge missing'; return null; }
    const os = b.onesignal;
    const getter = os.onesignalInfo || os.info;
    if (typeof getter === 'function') {
      try {
        const info = await withTimeout(Promise.resolve(getter.call(os)), 4000);
        const r = readInfo(info);
        if (r) {
          lastNativeProblem = r.id ? '' : `the info has no device ID (${describe(info)})`;
          return r;
        }
        lastNativeProblem = `info call returned ${describe(info)}`;
      } catch (e) {
        lastNativeProblem = `info call failed (${e && e.message ? e.message : e})`;
      }
    } else {
      lastNativeProblem = `no info method; bridge has: ${Object.keys(os).slice(0, 12).join(', ') || 'nothing'}`;
    }
    const pushed = readInfo(pushedInfo);   // fall back to the page-load callback
    if (pushed) { lastNativeProblem = ''; return pushed; }
    return null;
  }

  async function registerNative() {
    const b = await waitForBridge(4000);
    if (!b) {
      throw new Error('The Median bridge is not available on this page. In Median, enable the JavaScript Bridge and make sure this site is an internal URL, then rebuild the app.');
    }
    await whenMedianReady(3000);

    // Ask for notification permission (the call name differs between Median versions).
    const os = b.onesignal;
    for (const name of ['register', 'requestPermission', 'promptForPushNotifications']) {
      if (typeof os[name] === 'function') {
        try { await withTimeout(Promise.resolve(os[name]()), 15000); } catch { /* prompt dismissed or unsupported */ }
        break;
      }
    }

    let info = null;
    const deadline = Date.now() + 12000;    // wait up to ~12 s for the prompt + registration
    while (Date.now() < deadline) {
      info = await nativeInfo();
      if (info && info.id && info.subscribed) break;
      await sleep(500);
    }
    if (!info || !info.id) {
      throw new Error(`No OneSignal device ID yet. Median said: ${lastNativeProblem || 'no answer'}. ` +
        'Check OneSignal > Audience > Subscriptions for this phone.');
    }
    if (!info.subscribed) {
      throw new Error('Notifications are off for this app. Allow them in Android Settings > Apps > this app > Notifications, then tap Turn on again.');
    }
    if (!nativeServerReady) {
      throw new Error('The server has no OneSignal keys yet. Add ONESIGNAL_APP_ID and ONESIGNAL_API_KEY in Supabase.');
    }
    await api('subscribe_native', { subscription_id: info.id });
    return info;
  }

  /* ----------------------------------------------------------- web push -- */
  const pushSupported = () =>
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function currentSub() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function subscribePush() {
    const reg = await navigator.serviceWorker.ready;
    if (!vapidKey) await refresh();
    if (!vapidKey) throw new Error('Push is not set up on the server yet (missing VAPID keys).');

    const keyBytes = b64ToBytes(vapidKey);
    let sub = await reg.pushManager.getSubscription();
    const oldKey = sub && sub.options && sub.options.applicationServerKey;
    if (sub && oldKey && !sameBytes(oldKey, keyBytes)) {
      await sub.unsubscribe(); // server key changed
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes });
    }
    await api('subscribe', { subscription: sub.toJSON() });
    return sub;
  }

  /* ------------------------------------------------------------ push UI -- */
  async function updatePushUI() {
    const btn = $('pushBtn');
    const note = $('pushNote');

    if (isNativeApp()) {
      const info = await nativeInfo().catch(() => null);
      if (info && info.id && info.subscribed) {
        btn.hidden = true;
        note.textContent = 'On for this device. You will be notified even when the app is closed.';
      } else {
        btn.hidden = false;
        note.textContent = 'Allow notifications for this app to get alerts when it is closed.';
      }
      return;
    }

    if (!pushSupported()) {
      btn.hidden = true;
      note.textContent = 'This browser cannot receive push notifications. On iPhone, add the app to your Home Screen first.';
      return;
    }
    if (Notification.permission === 'denied') {
      btn.hidden = true;
      note.textContent = 'Notifications are blocked. Allow them for this site in your browser settings, then reload.';
      return;
    }
    let sub = null;
    try { sub = await currentSub(); } catch { /* service worker not ready yet */ }
    if (Notification.permission === 'granted' && sub) {
      btn.hidden = true;
      note.textContent = 'On for this device. You will be notified even when the app is closed.';
    } else {
      btn.hidden = false;
      note.textContent = 'Get a notification even when this app is closed.';
    }
  }

  async function enablePush() {
    const btn = $('pushBtn');
    btn.disabled = true;
    try {
      if (isNativeApp()) {
        await registerNative();
        say('Notifications are on for this device.');
      } else {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          say('Notifications were not allowed.', true);
        } else {
          await subscribePush();
          say('Notifications are on for this device.');
        }
      }
    } catch (e) {
      say(e.message, true);
    } finally {
      btn.disabled = false;
      updatePushUI();
    }
  }

  async function sendTest() {
    const btn = $('testBtn');
    btn.disabled = true;
    try {
      if (isNativeApp()) {
        let info = await nativeInfo().catch(() => null);
        if (!info || !info.id || !info.subscribed) throw new Error('Turn on phone alerts first.');
        await api('subscribe_native', { subscription_id: info.id }); // make sure the server knows this device
        await api('test', { native_id: info.id });
      } else {
        if (!pushSupported() || Notification.permission !== 'granted') {
          throw new Error('Turn on phone alerts first.');
        }
        const sub = (await currentSub()) || (await subscribePush());
        await api('test', { endpoint: sub.endpoint });
      }
      say('Test sent. It should arrive in a few seconds.');
    } catch (e) {
      say(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------ check now -- */
  async function checkNow() {
    const btn = $('checkBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const r = await api('check');
      status = r.status;
      render();
      if (r.throttled) say(`Checked a moment ago. Try again in ${r.retry_after_min} min.`);
      else if (r.ok === false) say('Check Failed. Still showing the previous status.', true);
      else if (!status.result_found) say('Checked. Not declared yet.');
    } catch (e) {
      say(e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Check now';
    }
  }

  /* ----------------------------------------------------------------- init -- */
  function wire() {
    $('checkBtn').addEventListener('click', checkNow);
    $('testBtn').addEventListener('click', sendTest);
    $('pushBtn').addEventListener('click', enablePush);

    $('alarmBtn').addEventListener('click', () => {
      const turnOn = !alarmEnabled();
      localStorage.setItem(KEY_ALARM, turnOn ? 'on' : 'off');
      if (turnOn) {
        ensureAudio();
        setTimeout(() => beep(659, 0.3), 120); // short preview so you know it works
        say('Alarm sound is on.');
      } else {
        say('Alarm sound is off.');
      }
      syncAlarm();
    });

    $('stopAlarmBtn').addEventListener('click', () => {
      if (status && status.detected_at) localStorage.setItem(KEY_ACK, String(status.detected_at));
      syncAlarm();
    });

    // Browsers only allow sound after a tap, so unlock audio on any interaction.
    document.addEventListener('pointerdown', ensureAudio, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
    });
    setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, POLL_MS);

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvent = e;
      $('installBtn').hidden = false;
    });
    $('installBtn').addEventListener('click', async () => {
      if (!installEvent) return;
      installEvent.prompt();
      await installEvent.userChoice.catch(() => {});
      installEvent = null;
      $('installBtn').hidden = true;
    });
    window.addEventListener('appinstalled', () => ($('installBtn').hidden = true));
  }

  async function init() {
    wire();
    $('alarmBtn').textContent = alarmEnabled() ? 'On' : 'Off';

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data && e.data.type === 'push') refresh(); // a push arrived while the app is open
      });
      try {
        await navigator.serviceWorker.register('./sw.js', { scope: './' });
      } catch (e) {
        console.warn('Service worker registration failed', e);
      }
    }

    // The Median bridge can arrive a moment after the page loads.
    if (isNativeApp()) {
      await waitForBridge(4000);
      await whenMedianReady(3000);
    }

    await refresh();
    await updatePushUI();

    // Keep the server's copy of this device's registration fresh.
    if (isNativeApp()) {
      nativeInfo().then((info) => {
        if (info && info.id && info.subscribed && nativeServerReady) {
          return api('subscribe_native', { subscription_id: info.id });
        }
      }).catch(() => {});
    } else if (pushSupported() && Notification.permission === 'granted') {
      subscribePush().then(updatePushUI).catch(() => {});
    }
  }

  init();
})();
