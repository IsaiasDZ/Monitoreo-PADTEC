const REFRESH_MS = 20000; // igual al POLL_INTERVAL_SECONDS por defecto del backend

const grid = document.getElementById('grid');
const trailEl = document.getElementById('trail');
const footUpdated = document.getElementById('footUpdated');
const modeBadge = document.getElementById('modeBadge');

let currentSegments = []; // ultimo snapshot recibido, usado para prellenar el modal

// ---------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------
function fmt(v, unit = 'dBm') {
  if (v === null || v === undefined) return `---`;
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(1)}<span class="val__unit">${unit}</span>`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function statusLabel(s) {
  return { good: 'good', warning: 'warning', critical: 'critical', unknown: 'warning' }[s] || 'warning';
}

async function api(path, opts) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Error ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------
// Render: trail (ruta lineal arriba)
// ---------------------------------------------------------------
function renderTrail(segments) {
  if (!segments.length) { trailEl.innerHTML = ''; return; }
  let html = `<span class="trail__node" data-status="${statusLabel(segments[0].site_a.status)}">${segments[0].site_a.name.toUpperCase()}</span>`;
  segments.forEach(seg => {
    html += `<span class="trail__seg" data-status="${statusLabel(seg.status)}"></span>`;
    html += `<span class="trail__node" data-status="${statusLabel(seg.site_b.status)}">${seg.site_b.name.toUpperCase()}</span>`;
  });
  trailEl.innerHTML = html;
}

// ---------------------------------------------------------------
// Render: tabla RX/TX de un sitio (W + P)
// ---------------------------------------------------------------
function siteTable(site) {
  const w = site.working, p = site.protection;
  return `
    <div class="site__table">
      <span class="col-h"></span><span class="col-h">RX</span><span class="col-h">TX</span>
      <span class="path-tag" data-path="working">W</span>
      <span class="val rx" data-status="${statusLabel(w.status)}">${fmt(w.rx)}</span>
      <span class="val tx">${fmt(w.tx)}</span>
      <span class="path-tag" data-path="protection">P</span>
      <span class="val rx" data-status="${statusLabel(p.status)}">${fmt(p.rx)}</span>
      <span class="val tx">${fmt(p.tx)}</span>
    </div>`;
}

function siteUpdateLine(site) {
  const w = site.working.last_change, p = site.protection.last_change;
  const latest = [w, p].filter(Boolean).sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
  if (!latest) {
    return `<div class="site__update"><span class="u-icon">↻</span>sin cambios registrados aún</div>`;
  }
  const from = latest.from.toFixed(1), to = latest.to.toFixed(1);
  return `<div class="site__update"><span class="u-icon">↻</span>${latest.ts} · <b>${latest.path}</b> ${from}→${to} dBm</div>`;
}

function siteBlock(seg, side, site) {
  const src = site.working.source || site.protection.source || 'empty';
  const eoaName = site.working.name || site.protection.name || 'EOA';
  const srcLabel = src === 'live' ? 'API real' : 'sin datos (revisar ID de tarjeta)';
  return `
    <div class="site" data-side="${side === 'site_a' ? 'a' : 'b'}" data-status="${statusLabel(site.status)}">
      <div class="site__head">
        <span class="site__city">${site.name}</span>
        <div class="site__actions">
          <span class="site__tag" title="${escapeHtml(eoaName)}">${escapeHtml(eoaName)}</span>
          <button class="site__edit" data-seg="${seg.id}" data-side="${side}">✎ Editar</button>
        </div>
      </div>
      ${siteTable(site)}
      ${siteUpdateLine(site)}
      <div class="site__source">fuente: ${srcLabel}</div>
    </div>`;
}

// ---------------------------------------------------------------
// Render: grid de tramos
// ---------------------------------------------------------------
function renderGrid(segments) {
  grid.innerHTML = segments.map((seg, i) => `
    <div class="seg seg--${statusLabel(seg.status)}">
      <div class="seg__head">
        <span class="seg__num">${String(i + 1).padStart(2, '0')}</span>
        <span class="seg__title">${seg.title.replace(' ⟷ ', ' <small>⟷</small> ')}</span>
        <span class="seg__active" data-active="${seg.active_path}">
          <span class="active-dot"></span>${seg.active_path === 'working' ? 'WORKING' : 'PROTECTION'}
        </span>
      </div>
      <div class="seg__body">
        ${siteBlock(seg, 'site_a', seg.site_a)}
        <div class="fiber">
          <span class="fiber__arrow fiber__arrow--l">←</span>
          <span class="fiber__km">${seg.km} km</span>
          <span class="fiber__arrow fiber__arrow--r">→</span>
        </div>
        ${siteBlock(seg, 'site_b', seg.site_b)}
      </div>
    </div>
  `).join('');

  grid.querySelectorAll('.site__edit').forEach(btn => {
    btn.addEventListener('click', () => openModal(Number(btn.dataset.seg), btn.dataset.side));
  });
}

// ---------------------------------------------------------------
// Carga de datos en vivo
// ---------------------------------------------------------------
async function loadRoute() {
  try {
    const data = await api('/route');
    currentSegments = data.segments || [];
    renderTrail(currentSegments);
    renderGrid(currentSegments);

    const c = data.summary || {};
    document.getElementById('cGood').textContent = c.good || 0;
    document.getElementById('cWarn').textContent = c.warning || 0;
    document.getElementById('cCrit').textContent = c.critical || 0;
    footUpdated.textContent = `PADTEC · última actualización del sondeo: ${data.updated_at || '—'}`;
  } catch (err) {
    footUpdated.textContent = `PADTEC · error consultando /api/route (${err.message})`;
  }
}

async function loadMode() {
  try {
    const status = await api('/monitor');
    modeBadge.textContent = status.mode === 'live' ? 'API REAL' : 'MODO MOCK';
    modeBadge.dataset.mode = status.mode;
  } catch { /* silencioso */ }
}

// ---------------------------------------------------------------
// Modal CRUD: editar EOA (Working + Protection) de un sitio
// ---------------------------------------------------------------
const overlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const modalSub = document.getElementById('modalSub');
const modalStatus = document.getElementById('modalStatus');
const modalForm = document.getElementById('modalForm');

function openModal(segmentId, siteKey) {
  const seg = currentSegments.find(s => s.id === segmentId);
  if (!seg) return;
  const site = seg[siteKey];

  document.getElementById('fSegmentId').value = segmentId;
  document.getElementById('fSiteKey').value = siteKey;
  document.getElementById('wCardId').value = site.working.card_id;
  document.getElementById('wStageId').value = site.working.stage_id ?? 0;
  document.getElementById('pCardId').value = site.protection.card_id;
  document.getElementById('pStageId').value = site.protection.stage_id ?? 0;

  modalTitle.textContent = `Editar EOA — ${site.name}`;
  modalSub.textContent = `${seg.title} · endpoints Working / Protection`;
  modalStatus.textContent = '';
  modalStatus.dataset.state = '';
  overlay.classList.add('open');
}

function closeModal() { overlay.classList.remove('open'); }

document.getElementById('modalClose').addEventListener('click', closeModal);
document.getElementById('modalCancel').addEventListener('click', closeModal);
overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

modalForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const segmentId = document.getElementById('fSegmentId').value;
  const siteKey = document.getElementById('fSiteKey').value;

  const payload = {
    working: {
      card_id: document.getElementById('wCardId').value.trim(),
      stage_id: Number(document.getElementById('wStageId').value),
      label: 'W',
    },
    protection: {
      card_id: document.getElementById('pCardId').value.trim(),
      stage_id: Number(document.getElementById('pStageId').value),
      label: 'P',
    },
  };

  modalStatus.textContent = 'Guardando…';
  modalStatus.dataset.state = '';
  try {
    await api(`/links/${segmentId}/site/${siteKey}`, { method: 'PATCH', body: JSON.stringify(payload) });
    modalStatus.textContent = 'Guardado. Actualizando datos…';
    modalStatus.dataset.state = 'ok';
    await loadRoute();
    setTimeout(closeModal, 600);
  } catch (err) {
    modalStatus.textContent = `Error: ${err.message}`;
    modalStatus.dataset.state = 'error';
  }
});

// ---------------------------------------------------------------
// Admin: crear / eliminar tramos completos (CRUD)
// ---------------------------------------------------------------
const adminList = document.getElementById('adminList');
const adminForm = document.getElementById('adminForm');

async function loadAdminList() {
  try {
    const links = await api('/links');
    adminList.innerHTML = links.map(seg => `
      <div class="admin__row">
        <span>#${seg.id} — ${seg.title} (${seg.km} km)</span>
        <button data-del="${seg.id}">Eliminar</button>
      </div>
    `).join('') || '<div style="font-size:10px;color:var(--ink-3)">Sin tramos configurados.</div>';

    adminList.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Eliminar este tramo? Esta acción no se puede deshacer.')) return;
        await api(`/links/${btn.dataset.del}`, { method: 'DELETE' });
        await loadAdminList();
        await loadRoute();
      });
    });
  } catch (err) {
    adminList.innerHTML = `<div style="color:var(--crit);font-size:10px;">Error cargando tramos: ${err.message}</div>`;
  }
}

adminForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(adminForm);
  const payload = {
    title: fd.get('title'),
    km: Number(fd.get('km')),
    warning_at: Number(fd.get('warning_at')),
    critical_at: Number(fd.get('critical_at')),
    site_a: {
      name: 'Sitio A',
      working: { card_id: '0000-000', stage_id: 0, label: 'W' },
      protection: { card_id: '0000-001', stage_id: 0, label: 'P' },
    },
    site_b: {
      name: 'Sitio B',
      working: { card_id: '0000-002', stage_id: 0, label: 'W' },
      protection: { card_id: '0000-003', stage_id: 0, label: 'P' },
    },
  };
  try {
    await api('/links', { method: 'POST', body: JSON.stringify(payload) });
    adminForm.reset();
    await loadAdminList();
    await loadRoute();
  } catch (err) {
    alert(`Error creando tramo: ${err.message}`);
  }
});

// ---------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------
loadRoute();
loadMode();
loadAdminList();
setInterval(loadRoute, REFRESH_MS);
setInterval(loadMode, REFRESH_MS);