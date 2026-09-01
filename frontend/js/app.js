const REFRESH_MS = 20000; // igual al POLL_INTERVAL_SECONDS por defecto del backend

const grid = document.getElementById('grid');
const trailEl = document.getElementById('trail');
const footUpdated = document.getElementById('footUpdated');

let currentSegments = []; // ultimo snapshot recibido, usado para prellenar el modal
let routeRequestInFlight = false;
const pendingStages = new Map();
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingMessage = document.getElementById('loadingMessage');

function setLoading(active, message = 'Procesando…') {
  loadingMessage.textContent = message;
  loadingOverlay.hidden = !active;
  loadingOverlay.setAttribute('aria-busy', String(active));
}

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

function formatReportNumber(value, unit = '') {
  if (value === null || value === undefined || value === '') return 'No disponible';
  const number = Number(value);
  if (!Number.isFinite(number)) return `${escapeHtml(String(value))}${unit}`;
  return `${number.toFixed(2)}${unit}`;
}

function reportLedState(value) {
  const v = String(value || 'DISABLE').toUpperCase();
  if (v === 'GREEN') return { text: 'GREEN', className: 'green' };
  if (v === 'ORANGE') return { text: 'ORANGE', className: 'orange' };
  if (v === 'RED') return { text: 'RED', className: 'red' };
  return { text: 'DISABLE', className: 'disabled' };
}

function buildOpsLedGrid(ops) {
  if (!ops || !ops.card_id) {
    return '<div class="report-ops-empty">No hay OPS en este lugar.</div>';
  }

  const leds = ops.leds || {};
  const slots = [
    ['working1', 'WORKING 1'],
    ['working2', 'WORKING 2'],
    ['protection1', 'PROTECTION 1'],
    ['protection2', 'PROTECTION 2'],
  ];

  const rows = slots.map(([key, label]) => {
    const value = reportLedState(leds[key]);
    return `
      <div class="report-led">
        <span class="report-led__label">${label}</span>
        <span class="report-led__value"><i class="report-led__dot ${value.className}"></i>${value.text}</span>
      </div>
    `;
  }).join('');

  const hasAnyLed = slots.some(([key]) => String(leds[key] || '').trim() !== '');
  if (!hasAnyLed) {
    return `<div class="report-ops-empty">No hay OPS en este lugar.</div><div class="report-led-grid">${rows}</div>`;
  }

  return `<div class="report-led-grid">${rows}</div>`;
}

function setReportPrintWindow(html) {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', 'Reporte PADTEC');
  iframe.style.position = 'fixed';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Reporte PADTEC</title><style>
    body{margin:0;background:#fff;font-family:ui-sans-serif,Segoe UI,Arial,sans-serif;}
    *{box-sizing:border-box;}
    .report-page{padding:28px 30px 20px;color:#14181D;}
    .report-header{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #f2b980;padding-bottom:12px;margin-bottom:16px;}
    .report-header__title{font-size:24px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;}
    .report-header__meta{font-size:11px;color:#5B6672;text-align:right;}
    .report-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:18px;}
    .report-chip{background:#F5F6F8;border:1px solid #D7DCE2;border-radius:8px;padding:8px 10px;}
    .report-chip__label{display:block;font-size:10px;letter-spacing:.06em;color:#99A3AD;text-transform:uppercase;}
    .report-chip__value{font-size:14px;font-weight:700;}
    .report-segment{border:1px solid #D7DCE2;border-radius:8px;overflow:hidden;margin-bottom:16px;}
    .report-segment__head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 12px;background:#fff7ef;border-bottom:1px solid #D7DCE2;}
    .report-segment__title{font-size:15px;font-weight:800;}
    .report-segment__meta{font-size:11px;color:#5B6672;}
    .report-site-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;padding:12px;}
    .report-site{border:1px solid #E4E8EC;border-radius:6px;background:#fff;padding:10px 12px;}
    .report-site__head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px;}
    .report-site__name{font-size:15px;font-weight:800;}
    .report-side-tag{font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:999px;border:1px solid #D7DCE2;}
    .report-side-tag.working{background:#E4F4F2;border-color:#0e7c7455;color:#0E7C74;}
    .report-side-tag.protection{background:#FFF1E4;border-color:#e8720c55;color:#E8720C;}
    .report-card{border:1px solid #E4E8EC;background:#F5F6F8;border-radius:6px;padding:8px 10px;margin-bottom:8px;}
    .report-card__title{display:flex;justify-content:space-between;gap:8px;font-size:12px;font-weight:800;margin-bottom:6px;}
    .report-card__title span:last-child{color:#99A3AD;font-weight:700;}
    .report-card__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;font-size:11px;}
    .report-card__grid div{display:flex;flex-direction:column;gap:2px;}
    .report-card__grid span{color:#99A3AD;letter-spacing:.03em;text-transform:uppercase;font-size:9px;}
    .report-card__grid strong{color:#14181D;font-size:11px;}
    .report-led-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin-top:8px;}
    .report-led{border:1px solid #D7DCE2;border-radius:4px;padding:5px 6px;background:#fff;font-size:10px;}
    .report-led__label{display:block;color:#99A3AD;margin-bottom:3px;}
    .report-led__value{display:inline-flex;align-items:center;gap:6px;font-weight:800;}
    .report-led__dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#9AA3AD;}
    .report-led__dot.green{background:#1B8A54;}
    .report-led__dot.orange{background:#E8720C;}
    .report-led__dot.red{background:#D92B2B;}
    .report-led__dot.disabled{background:#9AA3AD;}
    .report-ops-empty{margin-top:8px;font-size:11px;color:#5B6672;font-weight:700;}
    .report-foot{margin-top:18px;border-top:1px solid #D7DCE2;padding-top:10px;font-size:10px;color:#5B6672;text-align:right;}
    @media print { body{margin:0;} @page{size:A4 portrait; margin:12mm;} }
  </style></head><body>${html}</body></html>`);
  doc.close();
  setTimeout(() => {
    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } finally {
      setTimeout(() => iframe.remove(), 700);
    }
  }, 300);
}

async function exportRoutePdf() {
  setLoading(true, 'Generando reporte PDF…');
  try {
    const segments = currentSegments || [];
    if (!segments.length) {
      throw new Error('No hay tramos para exportar.');
    }

    const uniqueCards = [];
    const seen = new Set();
    for (const seg of segments) {
      for (const sideKey of ['site_a', 'site_b']) {
        const site = seg[sideKey] || {};
        const paths = [
          ['working', site.working],
          ['protection', site.protection],
        ];
        for (const [pathKey, entry] of paths) {
          if (!entry?.card_id) continue;
          const key = `${entry.card_id}|${entry.stage_id ?? 0}`;
          if (!seen.has(key)) {
            seen.add(key);
            uniqueCards.push({ cardId: entry.card_id, stageId: entry.stage_id ?? 0, path: pathKey, segmentId: seg.id, siteName: site.name, sideKey });
          }
        }
        const ops = site.ops || {};
        if (ops.card_id) {
          const key = `${ops.card_id}|${ops.stage_id ?? 0}|ops`;
          if (!seen.has(key)) {
            seen.add(key);
            uniqueCards.push({ cardId: ops.card_id, stageId: ops.stage_id ?? 0, path: 'OPS', segmentId: seg.id, siteName: site.name, sideKey });
          }
        }
      }
    }

    const cardDetails = await Promise.all(uniqueCards.map(async (item) => {
      const detail = await api(`/cards/${encodeURIComponent(item.cardId)}?stage_id=${item.stageId}`);
      return { ...item, detail };
    }));

    const detailMap = new Map(cardDetails.map(item => [`${item.cardId}|${item.stageId}|${item.path}`, item.detail]));
    const reportDate = new Date().toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa' });

    const html = `
      <div class="report-page">
        <header class="report-header">
          <div>
            <div class="report-header__title">Monitoreo PADTEC</div>
            <div class="report-header__meta">Reporte generado · ${escapeHtml(reportDate)}</div>
          </div>
          <div class="report-header__meta">
            <div>Ruta de fibra óptica</div>
            <div>Working / Protection + OPS</div>
          </div>
        </header>

        <section class="report-summary">
          <div class="report-chip"><span class="report-chip__label">Tramos</span><span class="report-chip__value">${segments.length}</span></div>
          <div class="report-chip"><span class="report-chip__label">Sitios</span><span class="report-chip__value">${segments.length * 2}</span></div>
          <div class="report-chip"><span class="report-chip__label">Estado general</span><span class="report-chip__value">${(segments.some(s => s.status === 'critical') ? 'CRÍTICO' : segments.some(s => s.status === 'warning') ? 'ADVERTENCIA' : 'NORMAL')}</span></div>
          <div class="report-chip"><span class="report-chip__label">Última actualización</span><span class="report-chip__value">${escapeHtml((currentSegments[0]?.site_a?.working?.device_update) || '—')}</span></div>
        </section>

        ${segments.map((seg) => {
          const renderSide = (sideKey, parentLabel) => {
            const site = seg[sideKey] || {};
            const working = site.working || {};
            const protection = site.protection || {};
            const ops = site.ops || {};
            const workingDetail = detailMap.get(`${working.card_id}|${working.stage_id ?? 0}|working`);
            const protectionDetail = detailMap.get(`${protection.card_id}|${protection.stage_id ?? 0}|protection`);
            const opsDetail = detailMap.get(`${ops.card_id}|${ops.stage_id ?? 0}|OPS`);
            const workingState = workingDetail?.card?.state || {};
            const protectionState = protectionDetail?.card?.state || {};
            const opsState = opsDetail?.card?.state || {};
            const opsLeds = ops?.leds || (opsDetail?.card?.state?.leds || {});
            const opsActive = normalizeOpsLedState({ ...ops, leds: opsLeds });

            const renderPathCard = (pathLabel, card, cardName, cardDetail, pathType) => {
              const state = cardDetail?.card?.state || {};
              const stage = cardDetail?.stage || {};
              const cardStatus = card?.status === 'critical' ? 'CRÍTICO' : card?.status === 'warning' ? 'ADVERTENCIA' : 'NORMAL';
              const isWorking = pathType === 'working';
              return `
                <div class="report-card">
                  <div class="report-card__title">
                    <span>${isWorking ? 'WORKING' : 'PROTECTION'}</span>
                    <span>${escapeHtml(cardStatus)}</span>
                  </div>
                  <div class="report-card__grid">
                    <div><span>Card ID</span><strong>${escapeHtml(card?.card_id || '—')}</strong></div>
                    <div><span>Stage</span><strong>${escapeHtml(String(card?.stage_id ?? 0))}</strong></div>
                    <div><span>RX</span><strong>${formatReportNumber(card?.rx, ' dBm')}</strong></div>
                    <div><span>TX</span><strong>${formatReportNumber(card?.tx, ' dBm')}</strong></div>
                    <div><span>Temperatura</span><strong>${formatReportNumber(stage.temperature, ' °C')}</strong></div>
                    <div><span>Ubicación</span><strong>${escapeHtml(state.location || 'No disponible')}</strong></div>
                    <div><span>Mapa</span><strong>${escapeHtml(state.map || state.location || 'No disponible')}</strong></div>
                    <div><span>Modelo</span><strong>${escapeHtml(state.model || 'No disponible')}</strong></div>
                    <div><span>Nombre</span><strong>${escapeHtml(state.name || 'No disponible')}</strong></div>
                    <div><span>Firmware</span><strong>${escapeHtml(state['firmware-version'] || 'No disponible')}</strong></div>
                    <div><span>Última act.</span><strong>${escapeHtml(state['last-update'] || card?.device_update || 'No disponible')}</strong></div>
                    <div><span>Ganancia</span><strong>${formatReportNumber(stage.gain, ' dB')}</strong></div>
                  </div>
                </div>
              `;
            };

            const opsText = ops.card_id ? `${opsActive.active_path === 'working' ? 'RUTA OPERANDO POR: WORKING' : 'RUTA OPERANDO POR: PROTECTION'} · ${String(opsActive.mode || 'unknown').toUpperCase()}` : 'NO HAY OPS EN ESTE LUGAR';

            return `
              <div class="report-site">
                <div class="report-site__head">
                  <div class="report-site__name">${escapeHtml(site.name || 'Sitio')}</div>
                  <span class="report-side-tag ${parentLabel === 'site_a' ? 'working' : 'protection'}">${parentLabel === 'site_a' ? 'Sitio A' : 'Sitio B'}</span>
                </div>
                ${renderPathCard('WORKING', working, 'Working', workingDetail, 'working')}
                ${renderPathCard('PROTECTION', protection, 'Protection', protectionDetail, 'protection')}
                <div class="report-card">
                  <div class="report-card__title"><span>OPS</span><span>${escapeHtml(ops.card_id ? 'CONFIGURADA' : 'SIN OPS')}</span></div>
                  <div class="report-card__grid">
                    <div><span>Card ID</span><strong>${escapeHtml(ops.card_id || '—')}</strong></div>
                    <div><span>Stage</span><strong>${escapeHtml(String(ops.stage_id ?? 0))}</strong></div>
                    <div><span>Working LED</span><strong>${escapeHtml(String(ops.working_slot ?? 1))}</strong></div>
                    <div><span>Protection LED</span><strong>${escapeHtml(String(ops.protection_slot ?? 1))}</strong></div>
                    <div><span>Ruta</span><strong>${escapeHtml(opsText)}</strong></div>
                    <div><span>Mapa</span><strong>${escapeHtml((opsState.map || ops.map || site.name || 'No disponible'))}</strong></div>
                  </div>
                  ${buildOpsLedGrid({ ...ops, leds: opsLeds, card_id: ops.card_id })}
                </div>
              </div>
            `;
          };

          return `
            <section class="report-segment">
              <div class="report-segment__head">
                <div class="report-segment__title">Tramo ${escapeHtml(String(seg.id))} · ${escapeHtml(seg.title || 'Sin nombre')}</div>
                <div class="report-segment__meta">Km: ${escapeHtml(String(seg.km || 0))} · Estado: ${escapeHtml(String(seg.status || 'unknown').toUpperCase())}</div>
              </div>
              <div class="report-site-grid">
                ${renderSide('site_a', 'site_a')}
                ${renderSide('site_b', 'site_b')}
              </div>
            </section>
          `;
        }).join('')}

        <div class="report-foot">Reporte PADTEC · ${escapeHtml(reportDate)}</div>
      </div>
    `;

    setReportPrintWindow(html);
    setLoading(false);
  } catch (err) {
    setLoading(false);
    alert(`Error generando PDF: ${err.message}`);
  }
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
      <span class="path-tag" data-path="working"><button class="path-info" data-card="${escapeHtml(w.card_id)}" data-stage="${w.stage_id ?? 0}" data-name="${escapeHtml(w.name || 'Working')}" aria-label="Información de ${escapeHtml(w.name || 'Working')}" title="Información detallada">ⓘ</button></span>
      <span class="val rx" data-status="${statusLabel(w.status)}">${value(w.rx)}</span>
      <span class="val tx">${value(w.tx)}</span>
      <span class="path-tag" data-path="protection"><button class="path-info" data-card="${escapeHtml(p.card_id)}" data-stage="${p.stage_id ?? 0}" data-name="${escapeHtml(p.name || 'Protection')}" aria-label="Información de ${escapeHtml(p.name || 'Protection')}" title="Información detallada">ⓘ</button></span>
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

function normalizeOpsLedState(ops) {
  const leds = ops?.leds || {};
  const workingSlot = Number(ops?.working_slot || 1);
  const protectionSlot = Number(ops?.protection_slot || 1);
  const working1 = String(leds.working1 || '').toUpperCase();
  const protection1 = String(leds.protection1 || '').toUpperCase();
  const working2 = String(leds.working2 || '').toUpperCase();
  const protection2 = String(leds.protection2 || '').toUpperCase();
  const workingValue = String(leds[`working${workingSlot}`] || (workingSlot === 1 ? working1 : working2) || 'DISABLE').toUpperCase();
  const protectionValue = String(leds[`protection${protectionSlot}`] || (protectionSlot === 1 ? protection1 : protection2) || 'DISABLE').toUpperCase();

  if (workingValue === 'GREEN' || workingValue === 'ORANGE' || workingValue === 'RED') {
    return { activePath: 'working', mode: workingValue === 'GREEN' ? 'automatic' : workingValue === 'ORANGE' ? 'manual' : 'alarm', working1, working2, protection1, protection2, workingValue, protectionValue };
  }
  if (protectionValue === 'GREEN' || protectionValue === 'ORANGE' || protectionValue === 'RED') {
    return { activePath: 'protection', mode: protectionValue === 'GREEN' ? 'automatic' : protectionValue === 'ORANGE' ? 'manual' : 'alarm', working1, working2, protection1, protection2, workingValue, protectionValue };
  }
  if (workingValue === 'DISABLE' && protectionValue === 'DISABLE') {
    return { activePath: 'working', mode: 'unknown', working1, working2, protection1, protection2, workingValue, protectionValue };
  }
  if (workingValue === 'DISABLE') return { activePath: 'protection', mode: 'unknown', working1, working2, protection1, protection2, workingValue, protectionValue };
  if (protectionValue === 'DISABLE') return { activePath: 'working', mode: 'unknown', working1, working2, protection1, protection2, workingValue, protectionValue };
  return { activePath: 'working', mode: 'unknown', working1, working2, protection1, protection2, workingValue, protectionValue };
}

function siteOpsBadge(site) {
  const ops = site?.ops || {};
  const ledState = normalizeOpsLedState(ops);
  const activePath = ledState.activePath || 'working';
  const routeText = activePath === 'working' ? 'ruta operando por: WORKING' : 'ruta operando por: PROTECTION';
  const modeText = ledState.mode === 'automatic' ? 'automático' : ledState.mode === 'manual' ? 'manual' : ledState.mode === 'alarm' ? 'alarma RX' : 'desconocido';
  const makeLed = (kind) => {
    const value = kind === 'working' ? ledState.workingValue : ledState.protectionValue;
    const state = String(value || 'DISABLE').toUpperCase();
    const active = activePath === kind;
    const css = state === 'GREEN' ? 'is-green' : state === 'ORANGE' ? 'is-orange' : state === 'RED' ? 'is-red' : 'is-disabled';
    const tooltip = `${routeText} · ${modeText}`;
    return `<button type="button" class="site__ops-led site__ops-led--${kind} ${css} ${active ? 'is-active' : ''}" title="${escapeHtml(tooltip)}" aria-label="${escapeHtml(tooltip)}"></button>`;
  };
  const info = ops?.card_id ? `<button type="button" class="site__ops-info" data-card="${escapeHtml(ops.card_id)}" data-stage="${Number(ops.stage_id || 0)}" data-name="${escapeHtml(ops.name || ops.map || site.name || 'OPS')}" title="${escapeHtml(ops.map || ops.name || site.name || 'OPS')}">ⓘ</button>` : '';

  return `
    <div class="site__ops" title="${escapeHtml(routeText)} · ${escapeHtml(ops.name || ops.map || site.name || 'OPS')}">
      <div class="site__ops-leds">
        ${makeLed('working')}
        ${makeLed('protection')}
      </div>
      ${info}
    </div>
  `;
}

function siteBlock(seg, side, site) {
  const stage = site.working.stage_id ?? site.protection.stage_id ?? 0;
  const stageLoading = site.stageLoading === true;
  return `
    <div class="site" data-side="${side === 'site_a' ? 'a' : 'b'}" data-status="${statusLabel(site.status)}">
      <div class="site__head">
        <div class="site__title-wrap">
          <span class="site__city">${escapeHtml(site.name)}</span>
          ${siteOpsBadge(site)}
        </div>
        <div class="site__actions">
          <div class="site__labels">
            <span class="site__tag site__tag--working" title="${escapeHtml(site.working.name || 'Sin nombre')}">${escapeHtml(site.working.name || '')}</span>
            <span class="site__tag site__tag--protection" title="${escapeHtml(site.protection.name || 'Sin nombre')}">${escapeHtml(site.protection.name || '')}</span>
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
  grid.querySelectorAll('.site__ops-info').forEach(btn => {
    btn.addEventListener('click', () => openInfo(btn.dataset.card, btn.dataset.stage, '', '', btn.dataset.name || 'OPS'));
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
  document.getElementById('opsCardId').value = site.ops?.card_id || '2335-000';
  document.getElementById('opsWorkingSlot').value = Number(site.ops?.working_slot || 1);
  document.getElementById('opsProtectionSlot').value = Number(site.ops?.protection_slot || 1);
  document.getElementById('opsStageId').value = site.ops?.stage_id ?? 0;

  modalTitle.textContent = `Editar tarjeta de sitio — ${site.name}`;
  modalSub.textContent = `${seg.title} · Working / Protection / OPS`;
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
    ops: {
      card_id: document.getElementById('opsCardId').value.trim(),
      stage_id: Number(document.getElementById('opsStageId').value),
      working_slot: Number(document.getElementById('opsWorkingSlot').value),
      protection_slot: Number(document.getElementById('opsProtectionSlot').value),
      label: 'OPS',
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
  setLoading(true, 'Preparando descarga…');
  try {
    const config = await api('/config/export');
    if (window.pywebview?.api?.save_config) {
      const saved = await window.pywebview.api.save_config(JSON.stringify(config, null, 2));
      if (!saved) throw new Error('No se seleccionó una ubicación de guardado');
      setLoading(false);
      return;
    }
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `padtec-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
      setLoading(false);
    }, 900);
  } catch (err) {
    setLoading(false);
    alert(`Error exportando configuración: ${err.message}`);
  }
});

document.getElementById('exportPdfReport').addEventListener('click', () => {
  exportRoutePdf();
});

document.getElementById('importConfig').addEventListener('click', () => document.getElementById('configFile').click());
document.getElementById('configFile').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  setLoading(true, 'Cargando configuración…');
  try {
    const config = JSON.parse(await file.text());
    await api('/config/import', { method: 'PUT', body: JSON.stringify(config) });
    await loadAdminList();
    await loadRoute();
    alert('Configuración importada correctamente.');
  } catch (err) { alert(`Error importando configuración: ${err.message}`); }
  finally { setLoading(false); }
  e.target.value = '';
});

let readingScale = Number(sessionStorage.getItem('padtecReadingScale') || '1');
function applyReadingScale() {
  readingScale = Math.min(1.8, Math.max(0.7, readingScale));
  document.documentElement.style.setProperty('--reading-scale', readingScale);
  document.getElementById('readingSizeValue').textContent = `${Math.round(readingScale * 100)}%`;
  sessionStorage.setItem('padtecReadingScale', String(readingScale));
}
document.getElementById('decreaseReadingSize').addEventListener('click', () => { readingScale -= 0.1; applyReadingScale(); });
document.getElementById('increaseReadingSize').addEventListener('click', () => { readingScale += 0.1; applyReadingScale(); });
applyReadingScale();

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