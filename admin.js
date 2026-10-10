(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const CFG = self.NIOS_CONFIG || {};
  const KEY_PW = 'nios.adminpw';           // kept only for this app session, never stored on disk
  const MAX = 8;

  let password = sessionStorage.getItem(KEY_PW) || '';
  let defaults = [];
  let status = null;
  let pendingConfirm = false;
  let msgTimer = null;
  let rearmTimer = null;
  let baselineTimer = null;
  let defaultAnchor = 'On Demand Examination Result';

  const IST = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  const fmt = (iso) => `${IST.format(new Date(iso))} IST`;

  function say(text, isError = false) {
    const el = $('msg');
    el.textContent = text;
    el.classList.toggle('error', isError);
    clearTimeout(msgTimer);
    if (text) msgTimer = setTimeout(() => (el.textContent = ''), 9000);
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
        body: JSON.stringify({ action, password, ...extra }),
      });
    } catch {
      throw new Error('No connection. Check your internet and try again.');
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ------------------------------------------------------------ keyword rows -- */
  function rows() { return [...document.querySelectorAll('#kwList .kw-input')]; }
  function values() { return rows().map((i) => i.value); }

  function addRow(value = '') {
    if (rows().length >= MAX) { say(`You can use at most ${MAX} texts.`, true); return; }
    const li = document.createElement('li');
    li.className = 'kw-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field kw-input';
    input.value = value;
    input.maxLength = 80;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', onEdit);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.addEventListener('click', () => { li.remove(); relabel(); onEdit(); });
    li.append(input, del);
    $('kwList').append(li);
    relabel();
  }

  function relabel() {
    rows().forEach((input, i) => input.setAttribute('aria-label', `Text ${i + 1}`));
    document.querySelectorAll('#kwList .icon-btn').forEach((b, i) => b.setAttribute('aria-label', `Remove text ${i + 1}`));
    $('addBtn').disabled = rows().length >= MAX;
  }

  function setRows(list) {
    $('kwList').textContent = '';
    (list.length ? list : ['', '']).forEach((v) => addRow(v));
  }

  // Gentle advice while typing (the server still enforces the real rules).
  function onEdit() {
    hideResults();
    const list = values().map((v) => v.trim()).filter(Boolean);
    const hint = $('kwHint');
    if (list.length < 2) hint.textContent = 'Add at least 2 texts so one common word cannot trigger a false alarm.';
    else if (!list.some((v) => /\d/.test(v))) hint.textContent = 'Tip: include a date or session name so older announcements do not match.';
    else hint.textContent = '';
  }

  function hideResults() {
    $('testResult').hidden = true;
    $('confirmBox').hidden = true;
    pendingConfirm = false;
  }

  /* ----------------------------------------------------------------- render -- */
  function renderStatus() {
    if (!status) return;
    const found = status.result_found === true;
    $('adminStatus').textContent = found ? '🟢 RESULT DECLARED' : '🟡 Not Declared Yet';
    $('resetRow').hidden = !found;
    $('rearmBtn').hidden = !found;
  }

  function renderChecks(list) {
    const ul = $('checks');
    ul.textContent = '';
    if (!list || !list.length) {
      const li = document.createElement('li');
      li.className = 'chk-empty';
      li.textContent = 'No checks yet.';
      ul.append(li);
      return;
    }
    for (const c of list) {
      const li = document.createElement('li');
      li.className = 'chk ' + (c.ok ? 'ok' : 'bad');
      const when = document.createElement('span');
      when.textContent = fmt(c.checked_at);
      const what = document.createElement('strong');
      what.textContent = !c.ok ? 'Check Failed' : c.found ? 'Result found' : 'OK, not declared';
      li.append(when, what);
      if (!c.ok && c.error) {
        const why = document.createElement('small');
        why.textContent = c.error;
        li.append(why);
      }
      ul.append(li);
    }
  }

  function renderSeen(list) {
    const ul = $('seenList');
    ul.textContent = '';
    if (!list || !list.length) {
      const li = document.createElement('li');
      li.className = 'chk-empty';
      li.textContent = 'Nothing recorded yet. The next check records the paragraph.';
      ul.append(li);
      return;
    }
    for (const it of list) {
      const li = document.createElement('li');
      li.className = 'chk ok';
      const text = document.createElement('span');
      text.textContent = it.item_text;
      const when = document.createElement('strong');
      when.textContent = it.baseline ? 'Already there' : `New ${fmt(it.first_seen_at)}`;
      li.append(text, when);
      ul.append(li);
    }
  }

  function renderWatch(data) {
    const w = data.watch || {};
    defaultAnchor = w.default_anchor || defaultAnchor;
    $('watchOn').checked = w.enabled !== false;
    $('anchor').value = w.anchor || defaultAnchor;
    $('watchNote').textContent = (data.status && data.status.watch_note) || '';
    renderSeen(data.seen_items);
  }

  const SOURCE = { admin: 'This admin panel', env: 'Server setting (KEYWORDS)', default: 'Built-in defaults' };

  function enterPanel(data) {
    defaults = data.defaults || [];
    status = data.status;
    $('lockedView').hidden = true;
    $('panelView').hidden = false;
    setRows(data.keywords || []);
    $('adminSource').textContent = SOURCE[data.source] || data.source;
    renderStatus();
    renderChecks(data.recent_checks);
    renderWatch(data);
    onEdit();
  }

  function leavePanel(note) {
    password = '';
    sessionStorage.removeItem(KEY_PW);
    $('panelView').hidden = true;
    $('lockedView').hidden = false;
    $('pw').value = '';
    hideResults();
    if (note) say(note);
  }

  /* ---------------------------------------------------------------- actions -- */
  async function unlock() {
    const btn = $('unlockBtn');
    password = $('pw').value;
    if (!password) { say('Enter the password.', true); return; }
    btn.disabled = true;
    try {
      const data = await api('admin_login');
      sessionStorage.setItem(KEY_PW, password);
      enterPanel(data);
      say('');
    } catch (e) {
      password = '';
      say(e.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function runTest() {
    const btn = $('testBtn');
    btn.disabled = true;
    btn.textContent = 'Testing…';
    $('confirmBox').hidden = true;
    try {
      const anchor = $('anchor').value.trim() || defaultAnchor;
      const r = await api('admin_test', { keywords: values(), watch_anchor: anchor });
      const box = $('testResult');
      box.hidden = false;
      box.className = 'result-box';
      box.textContent = '';
      const line = document.createElement('span');
      box.append(line);
      if (!r.read_ok) {
        box.classList.add('warn');
        line.textContent = `Could not read the NIOS site (${r.error}). Try again in a moment.`;
      } else {
        if (r.matched) {
          box.classList.add('warn');
          line.textContent = `These texts match the live page right now: "${r.matched}". Saving them will trigger the alarm at the next check.`;
        } else {
          box.classList.add('good');
          line.textContent = 'No match on the live page right now. That is what you want before the result is out.';
        }
        const info = document.createElement('span');
        info.textContent = r.anchor_found
          ? `The paragraph under "${anchor}" has ${r.items.length} item${r.items.length === 1 ? '' : 's'} right now:`
          : `The heading "${anchor}" was not found on the page, so new announcements cannot be tracked.`;
        box.append(info);
        if (r.anchor_found && r.items.length) {
          const ul = document.createElement('ul');
          for (const t of r.items) { const li = document.createElement('li'); li.textContent = t; ul.append(li); }
          box.append(ul);
        }
      }
    } catch (e) {
      handleError(e);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test on the live NIOS page';
    }
  }

  async function save(confirmMatch) {
    const btn = $('saveBtn');
    btn.disabled = true;
    try {
      const r = await api('admin_save_keywords', {
        keywords: values(),
        reset_found: !$('resetRow').hidden && $('resetFound').checked,
        confirm_match: confirmMatch === true,
      });
      if (r.needs_confirm) {
        $('testResult').hidden = true;
        $('confirmText').textContent = `Matched: "${r.matched}".`;
        $('confirmBox').hidden = false;
        pendingConfirm = true;
        return;
      }
      $('confirmBox').hidden = true;
      setRows(r.keywords);
      $('adminSource').textContent = SOURCE.admin;
      const fresh = await api('admin_login');
      status = fresh.status;
      renderStatus();
      renderChecks(fresh.recent_checks);
      say(r.rearmed ? 'Saved. Watching again with the new texts.' : 'Saved. The next check uses the new texts.');
    } catch (e) {
      handleError(e);
    } finally {
      btn.disabled = false;
    }
  }

  async function saveWatch() {
    const btn = $('saveWatchBtn');
    btn.disabled = true;
    try {
      const r = await api('admin_save_watch', {
        watch_changes: $('watchOn').checked,
        watch_anchor: $('anchor').value.trim(),
      });
      $('anchor').value = r.watch.anchor;
      say(r.watch.enabled ? 'Saved. New announcements will raise the alarm.' : 'Saved. New-announcement alerts are off.');
    } catch (e) {
      handleError(e);
    } finally {
      btn.disabled = false;
    }
  }

  async function resetBaseline() {
    const btn = $('baselineBtn');
    if (btn.dataset.armed !== '1') {           // first tap asks for a second tap
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to confirm';
      clearTimeout(baselineTimer);
      baselineTimer = setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Forget history (start fresh)'; }, 4000);
      return;
    }
    btn.dataset.armed = '';
    btn.textContent = 'Forget history (start fresh)';
    try {
      await api('admin_reset_baseline');
      renderSeen([]);
      say('History cleared. The next check records the paragraph again without an alert.');
    } catch (e) {
      handleError(e);
    }
  }

  async function rearm() {
    const btn = $('rearmBtn');
    if (btn.dataset.armed !== '1') {           // first tap asks for a second tap
      btn.dataset.armed = '1';
      btn.textContent = 'Tap again to confirm';
      clearTimeout(rearmTimer);
      rearmTimer = setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Reset found status'; }, 4000);
      return;
    }
    btn.dataset.armed = '';
    btn.textContent = 'Reset found status';
    try {
      const r = await api('admin_rearm');
      status = r.status;
      renderStatus();
      say('Status reset. The watcher is looking again.');
    } catch (e) {
      handleError(e);
    }
  }

  function handleError(e) {
    if (e.status === 403 || e.status === 429) leavePanel();
    say(e.message, true);
  }

  /* ------------------------------------------------------------------- init -- */
  function wire() {
    $('unlockBtn').addEventListener('click', unlock);
    $('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
    $('addBtn').addEventListener('click', () => { addRow(''); const r = rows(); r[r.length - 1].focus(); onEdit(); });
    $('defaultsBtn').addEventListener('click', () => { setRows(defaults); onEdit(); });
    $('testBtn').addEventListener('click', runTest);
    $('saveBtn').addEventListener('click', () => save(false));
    $('confirmSave').addEventListener('click', () => save(true));
    $('confirmCancel').addEventListener('click', hideResults);
    $('rearmBtn').addEventListener('click', rearm);
    $('saveWatchBtn').addEventListener('click', saveWatch);
    $('baselineBtn').addEventListener('click', resetBaseline);
    $('lockBtn').addEventListener('click', () => leavePanel('Locked.'));
  }

  async function init() {
    wire();
    if (password) {                                  // reopened within the same session
      try {
        enterPanel(await api('admin_login'));
        return;
      } catch (e) {
        leavePanel();
        if (e.status === 429) say(e.message, true);
      }
    }
  }

  init();
})();
