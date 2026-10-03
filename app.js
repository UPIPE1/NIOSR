(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CFG = self.NIOS_CONFIG || {};
  const KEY_ALARM = 'nios.alarm';          // "off" when the user disabled the alarm
  const KEY_ACK = 'nios.alarmStoppedFor';  // found_at value the user already stopped
  const POLL_MS = 60_000;

  let status = null;
  let vapidKey = '';
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

  function fmtTime(iso) {
    return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }

  function fmtAgo(iso) {
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const h = Math.round(mins / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }

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
    const found = status.status === 'FOUND';
    document.body.classList.toggle('is-found', found);
    $('waitingView').hidden = found;
    $('foundView').hidden = !found;

    if (found) {
      $('matchedText').textContent = status.matched_text || 'The announcement you were waiting for is live.';
      $('foundAt').textContent = status.found_at ? `Detected ${fmtTime(status.found_at)}` : '';
    } else {
      $('lastChecked').textContent = status.last_checked_at
        ? `${fmtTime(status.last_checked_at)} (${fmtAgo(status.last_checked_at)})`
        : 'Not checked yet';

      const warn = $('checkWarning');
      if (status.last_check_ok === false) {
        warn.hidden = false;
        warn.textContent =
          'The last check could not read the NIOS site' +
          (status.last_error ? ` (${status.last_error})` : '') +
          '. This is not a result; the next check will try again.';
      } else {
        warn.hidden = true;
      }
    }
    syncAlarm();
  }

  async function refresh() {
    try {
      const data = await api('status');
      status = data.status;
      if (data.vapidPublicKey) vapidKey = data.vapidPublicKey;
      render();
    } catch (e) {
      if (!status) $('lastChecked').textContent = 'Could not load';
      say(e.message, true);
    }
  }

  /* --------------------------------------------------------------- alarm -- */
  const alarmEnabled = () => localStorage.getItem(KEY_ALARM) !== 'off';
  const alarmNeeded = () =>
    !!status && status.status === 'FOUND' && alarmEnabled() && localStorage.getItem(KEY_ACK) !== String(status.found_at);

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

  /* ---------------------------------------------------------------- push -- */
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

  async function updatePushUI() {
    const btn = $('pushBtn');
    const note = $('pushNote');
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
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        say('Notifications were not allowed.', true);
      } else {
        await subscribePush();
        say('Notifications are on for this device.');
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
      if (!pushSupported() || Notification.permission !== 'granted') {
        throw new Error('Turn on phone alerts first.');
      }
      const sub = (await currentSub()) || (await subscribePush());
      await api('test', { endpoint: sub.endpoint });
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
      else if (r.ok === false) say('Could not read the NIOS site. Still waiting.', true);
      else if (status.status !== 'FOUND') say('Checked. Not declared yet.');
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
      if (status && status.found_at) localStorage.setItem(KEY_ACK, String(status.found_at));
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

    await refresh();
    await updatePushUI();

    // Keep the server's copy of this device's subscription fresh.
    if (pushSupported() && Notification.permission === 'granted') {
      subscribePush().then(updatePushUI).catch(() => {});
    }
  }

  init();
})();
