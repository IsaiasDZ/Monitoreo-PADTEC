const REFRESH_MS = 20000; // igual al POLL_INTERVAL_SECONDS por defecto del backend

const grid = document.getElementById('grid');
const trailEl = document.getElementById('trail');
const footUpdated = document.getElementById('footUpdated');

let currentSegments = []; // ultimo snapshot recibido, usado para prellenar el modal
let routeRequestInFlight = false;
const pendingStages = new Map();

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
  const loading = site.stageLoading === true;
  const value = reading => loading ? '<span class="reading-spinner" aria-label="Cargando dato"></span>' : fmt(reading);
  return `
    <div class="site__table">
      <span class="col-h"></span><span class="col-h">RX</span><span class="col-h">TX</span>
      <span class="path-tag" data-path="working">W<button class="path-info" data-card="${escapeHtml(w.card_id)}" data-stage="${w.stage_id ?? 0}" data-name="${escapeHtml(w.name || 'Working')}" aria-label="Información de ${escapeHtml(w.name || 'Working')}" title="Información detallada">ⓘ</button></span>
      <span class="val rx" data-status="${statusLabel(w.status)}">${value(w.rx)}</span>
      <span class="val tx">${value(w.tx)}</span>
      <span class="path-tag" data-path="protection">P<button class="path-info" data-card="${escapeHtml(p.card_id)}" data-stage="${p.stage_id ?? 0}" data-name="${escapeHtml(p.name || 'Protection')}" aria-label="Información de ${escapeHtml(p.name || 'Protection')}" title="Información detallada">ⓘ</button></span>
      <span class="val rx" data-status="${statusLabel(p.status)}">${value(p.rx)}</span>
      <span class="val tx">${value(p.tx)}</span>
    </div>`;
}

function siteUpdateLine(site) {
  const readings = [
    { path: 'W', date: site.working.device_update },
    { path: 'P', date: site.protection.device_update },
  ].filter(reading => reading.date).sort((a, b) => parseCardDate(b.date) - parseCardDate(a.date));
  const latest = readings[0];
  if (!latest) {
    return `<div class="site__update"><span class="u-icon">◷</span>sin fecha de actualización</div>`;
  }
  return `<div class="site__update"><span class="u-icon">◷</span>última actualización · <b>${latest.path}</b> ${escapeHtml(formatHondurasDate(latest.date))}</div>`;
}

function parseCardDate(value) {
  const match = String(value).match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  return match ? Date.UTC(match[3], match[2] - 1, match[1], match[4], match[5], match[6]) : 0;
}

function formatHondurasDate(value) {
  const timestamp = parseCardDate(value);
  if (!timestamp) return value;
  const date = new Date(timestamp - (3 * 60 * 60 * 1000));
  const parts = [date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear()]
    .map((part, index) => index < 2 ? String(part).padStart(2, '0') : String(part));
  return `${parts[0]}/${parts[1]}/${parts[2]} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

function siteBlock(seg, side, site) {
  const stage = site.working.stage_id ?? site.protection.stage_id ?? 0;
  const stageLoading = site.stageLoading === true;
  return `
    <div class="site" data-side="${side === 'site_a' ? 'a' : 'b'}" data-status="${statusLabel(site.status)}">
      <div class="site__head">
        <span class="site__city">${escapeHtml(site.name)}</span>
        <div class="site__actions">
          <div class="site__labels">
            <span class="site__tag site__tag--working" title="${escapeHtml(site.working.name || 'Sin nombre')}" >W · ${escapeHtml(site.working.name || 'Sin nombre')}</span>
            <span class="site__tag site__tag--protection" title="${escapeHtml(site.protection.name || 'Sin nombre')}" >P · ${escapeHtml(site.protection.name || 'Sin nombre')}</span>
          </div>
          <button class="stage-switch ${stage === 1 ? 'is-stage-1' : ''} ${stageLoading ? 'is-loading' : ''}" data-seg="${seg.id}" data-side="${side}" data-stage="${stage}" role="switch" aria-checked="${stage === 1}" aria-label="${stageLoading ? 'Cambiando stage' : 'Cambiar entre stage 0 y stage 1'}" title="Cambiar stage" ${stageLoading ? 'disabled' : ''}>${stageLoading ? '<span class="stage-spinner" aria-hidden="true"></span><span>Cargando</span>' : `⇄<span>Stage ${stage}</span>`}</button>
          <button class="site__edit" data-seg="${seg.id}" data-side="${side}" aria-label="Editar configuración" title="Editar configuración">✎</button>
        </div>
      </div>
      ${siteTable(site)}
      ${siteUpdateLine(site)}
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
        <span class="seg__title">${escapeHtml(seg.title).replace(' ⟷ ', ' <small>⟷</small> ')}</span>
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
  grid.querySelectorAll('.stage-switch').forEach(btn => {
    btn.addEventListener('click', () => toggleStage(btn));
  });
  grid.querySelectorAll('.path-info').forEach(btn => {
    btn.addEventListener('click', () => openInfo(btn.dataset.card, btn.dataset.stage, '', '', btn.dataset.name));
  });
}

function applyPendingStages(segments) {
  return segments.map(segment => {
    const updated = { ...segment };
    for (const side of ['site_a', 'site_b']) {
      const site = { ...updated[side], working: { ...updated[side].working }, protection: { ...updated[side].protection } };
      const key = `${segment.id}:${side}`;
      const pending = pendingStages.get(key);
      if (pending === undefined) {
        updated[side] = site;
        continue;
      }
      const receivedStage = site.working.stage_id ?? site.protection.stage_id ?? 0;
      if (receivedStage === pending) {
        pendingStages.delete(key);
      } else {
        site.working.stage_id = pending;
        site.protection.stage_id = pending;
        site.stageLoading = true;
      }
      updated[side] = site;
    }
    return updated;
  });
}

// ---------------------------------------------------------------
// Carga de datos en vivo
// ---------------------------------------------------------------
async function loadRoute() {
  if (routeRequestInFlight) return;
  routeRequestInFlight = true;
  try {
    const data = await api('/route');
    currentSegments = applyPendingStages(data.segments || []);
    renderTrail(currentSegments);
    renderGrid(currentSegments);

    const c = data.summary || {};
    document.getElementById('cGood').textContent = c.good || 0;
    document.getElementById('cWarn').textContent = c.warning || 0;
    document.getElementById('cCrit').textContent = c.critical || 0;
    footUpdated.textContent = `PADTEC · última actualización del sondeo: ${data.updated_at || '—'}`;
  } catch (err) {
    footUpdated.textContent = `PADTEC · error consultando /api/route (${err.message})`;
  } finally {
    routeRequestInFlight = false;
  }
}

async function toggleStage(button) {
  const segment = currentSegments.find(item => item.id === Number(button.dataset.seg));
  if (!segment) return;
  const site = segment[button.dataset.side];
  const stage = Number(button.dataset.stage) === 1 ? 0 : 1;
  const previousStage = Number(button.dataset.stage);
  site.working.stage_id = stage;
  site.protection.stage_id = stage;
  site.stageLoading = true;
  pendingStages.set(`${segment.id}:${button.dataset.side}`, stage);
  renderGrid(currentSegments);
  button.disabled = true;
  button.classList.add('is-loading');
  button.setAttribute('aria-label', 'Cambiando stage');
  button.innerHTML = '<span class="stage-spinner" aria-hidden="true"></span><span>Cargando</span>';
  try {
    await api(`/links/${segment.id}/site/${button.dataset.side}/stage`, {
      method: 'PATCH',
      body: JSON.stringify({ stage_id: stage }),
    });
  } catch (err) {
    site.working.stage_id = previousStage;
    site.protection.stage_id = previousStage;
    site.stageLoading = false;
    pendingStages.delete(`${segment.id}:${button.dataset.side}`);
    renderGrid(currentSegments);
    footUpdated.textContent = `PADTEC · error cambiando stage (${err.message})`;
    button.classList.remove('is-loading');
    button.setAttribute('aria-label', 'Cambiar entre stage 0 y stage 1');
    button.innerHTML = `⇄<span>Stage ${Number(button.dataset.stage)}</span>`;
  } finally {
    button.disabled = false;
  }
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
  document.getElementById('siteName').value = site.name;
  document.getElementById('segmentTitle').value = seg.title;
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
    name: document.getElementById('siteName').value.trim(),
    title: document.getElementById('segmentTitle').value.trim(),
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
// Información detallada bajo demanda (no se consulta durante el polling)
// ---------------------------------------------------------------
const infoOverlay = document.getElementById('infoOverlay');
async function openInfo(workingId, workingStage, protectionId, protectionStage, name) {
  const endpoints = [[workingId, workingStage, 'Working'], [protectionId, protectionStage, 'Protection']]
    .filter(([cardId], index, items) => cardId && !cardId.startsWith('0000-') && items.findIndex(item => item[0] === cardId) === index);
  document.getElementById('infoTitle').textContent = `Información · ${name}`;
  document.getElementById('infoSub').textContent = `${endpoints.length} tarjeta(s) asociada(s)`;
  document.getElementById('infoJson').textContent = 'Consultando PADTEC…';
  infoOverlay.classList.add('open');
  try {
    const details = await Promise.all(endpoints.map(async ([cardId, stageId, path]) => ({
      path, card_id: cardId, data: await api(`/cards/${encodeURIComponent(cardId)}?stage_id=${encodeURIComponent(stageId)}`),
    })));
    document.getElementById('infoJson').innerHTML = details.length ? details.map(detail => renderCardSummary(detail)).join('') : 'No hay tarjetas reales configuradas.';
  } catch (err) {
    document.getElementById('infoJson').textContent = `No fue posible cargar el detalle: ${err.message}`;
  }
}

function displayValue(value, unit = '') {
  return value === null || value === undefined || value === 'N/A' ? 'No disponible' : `${escapeHtml(value)}${unit}`;
}

function renderCardSummary(detail) {
  const state = detail.data.card?.state || {};
  const stage = detail.data.stage || {};
  const rows = [
    ['Modelo', state.model], ['Nombre', state.name], ['Ubicación', state.location],
    ['Estado de tarjeta', state['card-state'] ? 'Activa' : 'Inactiva'], ['Firmware', state['firmware-version']],
    ['Temperatura', stage.temperature, ' °C'], ['RX', stage['power-rx'], ' dBm'], ['TX', stage['power-tx'], ' dBm'],
    ['Ganancia', stage.gain, ' dB'], ['Modo', stage.currentOperationModeEdfa], ['Última actualización', state['last-update']],
  ];
  return `<section class="info-card"><header><strong>${escapeHtml(detail.path)}</strong><span>Card ${escapeHtml(detail.card_id)}</span></header><div class="info-grid">${rows.map(([label, value, unit]) => `<div><span>${label}</span><b>${displayValue(value, unit || '')}</b></div>`).join('')}</div></section>`;
}
function closeInfo() { infoOverlay.classList.remove('open'); }
document.getElementById('infoClose').addEventListener('click', closeInfo);
infoOverlay.addEventListener('click', e => { if (e.target === infoOverlay) closeInfo(); });

// ---------------------------------------------------------------
// Configuración local: exportar/importar el mismo contrato del backend
// ---------------------------------------------------------------
document.getElementById('exportConfig').addEventListener('click', async () => {
  try {
    const config = await api('/config/export');
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `padtec-config-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (err) { alert(`Error exportando configuración: ${err.message}`); }
});

document.getElementById('importConfig').addEventListener('click', () => document.getElementById('configFile').click());
document.getElementById('configFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const config = JSON.parse(await file.text());
    await api('/config/import', { method: 'PUT', body: JSON.stringify(config) });
    await loadAdminList();
    await loadRoute();
    alert('Configuración importada correctamente.');
  } catch (err) { alert(`Error importando configuración: ${err.message}`); }
  e.target.value = '';
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
        <label>#${seg.id} Línea
          <input data-field="title" value="${escapeHtml(seg.title)}">
        </label>
        <label>Km
          <input data-field="km" type="number" step="0.1" value="${seg.km}">
        </label>
        <label>Advertencia
          <input data-field="warning_at" type="number" step="0.1" value="${seg.warning_at}">
        </label>
        <label>Crítico
          <input data-field="critical_at" type="number" step="0.1" value="${seg.critical_at}">
        </label>
        <button class="admin__save" data-save="${seg.id}" title="Guardar cambios" aria-label="Guardar cambios">✓</button>
        <button data-del="${seg.id}" title="Eliminar tramo" aria-label="Eliminar tramo">×</button>
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
    adminList.querySelectorAll('[data-save]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const row = btn.closest('.admin__row');
        const segment = links.find(item => item.id === Number(btn.dataset.save));
        const value = field => row.querySelector(`[data-field="${field}"]`).value;
        const payload = {
          ...segment,
          title: value('title').trim(),
          km: Number(value('km')),
          warning_at: Number(value('warning_at')),
          critical_at: Number(value('critical_at')),
        };
        try {
          await api(`/links/${segment.id}`, { method: 'PUT', body: JSON.stringify(payload) });
          btn.textContent = '✓';
          await loadRoute();
        } catch (err) { alert(`Error guardando tramo: ${err.message}`); }
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
loadAdminList();
setInterval(loadRoute, REFRESH_MS);