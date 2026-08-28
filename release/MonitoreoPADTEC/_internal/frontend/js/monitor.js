const POLL_MS = 3000;

const kindLabel = { info: 'INFO', change: 'CAMBIO', token: 'TOKEN', warn: 'ADVERTENCIA', error: 'ERROR' };

async function loadStatus() {
  try {
    const res = await fetch('/api/monitor');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    document.getElementById('mLast').textContent = data.last_poll || '—';
    updateCountdown(data);
    document.getElementById('mMode').textContent = 'API REAL';
    document.getElementById('mToken').textContent = data.token_preview || '(sin token todavía)';

    const logEl = document.getElementById('mLog');
    const events = data.events || [];
    document.getElementById('mCount').textContent = `${events.length} eventos`;

    if (!events.length) {
      logEl.innerHTML = '<div class="mon-empty">Sin eventos registrados todavía.</div>';
      return;
    }

    logEl.innerHTML = events.map(ev => `
      <div class="mon-log__row" data-kind="${ev.kind}">
        <span class="mon-log__ts">${ev.ts}</span>
        <span class="mon-log__kind">${kindLabel[ev.kind] || ev.kind.toUpperCase()}</span>
        <span class="mon-log__msg">${ev.msg}</span>
      </div>
    `).join('');
  } catch (err) {
    document.getElementById('mLog').innerHTML =
      `<div class="mon-empty">Error consultando /api/monitor: ${err.message}</div>`;
  }
}

loadStatus();
setInterval(loadStatus, POLL_MS);
setInterval(() => {
  const el = document.getElementById('mInterval');
  if (window.nextPollAt) {
    el.textContent = `actualiza en ${Math.max(0, Math.ceil(window.nextPollAt - Date.now() / 1000))} s`;
  }
}, 1000);

function updateCountdown(data) {
  window.nextPollAt = data.next_poll_at || (Date.now() / 1000 + data.poll_interval);
  const remaining = Math.max(0, Math.ceil(window.nextPollAt - Date.now() / 1000));
  document.getElementById('mInterval').textContent = `actualiza en ${remaining} s`;
}