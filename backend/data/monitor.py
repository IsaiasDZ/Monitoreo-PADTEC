"""
Motor de monitoreo en background.

Es la evolucion del `while True: ... time.sleep(10)` de import_requests.py /
import_requests_HOA.py: en vez de monitorear 2 cards fijos (Working/Protection)
impresos por consola, ahora recorre TODOS los tramos configurados en el CRUD
(backend/data/links.json), cada uno con su EOA Working y Protection, y deja
el resultado en memoria para que el frontend (dashboard + pantalla externa)
lo consuma via /api/route y /api/monitor.

Se conserva el comportamiento original:
  - contador de iteraciones
  - deteccion de cambios de power-rx (para el log / "ultima actualizacion")
  - renovacion automatica de token cuando la API responde 403
  - sin datos simulados: si la API real no esta disponible (card_id
    invalido/placeholder, red caida, timeout, credenciales, etc.) el EOA
    queda con rx/tx = None ("---" en el dashboard) en vez de generar
    valores aleatorios. Solo se muestran lecturas que realmente vinieron
    de la API de PADTEC.
"""
import threading
import time
from datetime import datetime

from backend.config.settings import settings
from backend.data.store import LinksStore
from backend.services.padtec_service import PadtecService

WARN_DEFAULT = -18.0
CRIT_DEFAULT = -23.0
_STATUS_ORDER = {"good": 0, "warning": 1, "unknown": 1, "critical": 2}


def _classify(rx, warn_at, crit_at):
    if rx is None:
        return "unknown"
    if rx <= crit_at:
        return "critical"
    if rx <= warn_at:
        return "warning"
    return "good"


def _worse(a, b):
    return a if _STATUS_ORDER.get(a, 1) >= _STATUS_ORDER.get(b, 1) else b


class MonitorService:
    def __init__(self):
        self.store = LinksStore()
        self.client = PadtecService()

        self.iteration = 0
        self.last_poll = None
        self.events = []  # log para la pantalla externa (mas reciente al final)
        self.route_cache = {"segments": [], "summary": {"good": 0, "warning": 0, "critical": 0}, "updated_at": None}

        self._prev_rx = {}      # card_id -> ultimo power-rx visto
        self._last_change = {}  # card_id -> {from, to, ts, path}
        self._lock = threading.Lock()
        self._thread = None

    # ---------------- infraestructura ----------------
    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def poll_now(self):
        """Fuerza un sondeo inmediato (fuera del ciclo de POLL_INTERVAL_SECONDS).

        Se usa despues de crear/editar/eliminar un tramo o sitio desde el CRUD,
        para que /api/route refleje el cambio pronto en vez de esperar hasta
        el proximo tick del hilo en background (por defecto 10s).

        Corre en un hilo aparte (no bloquea la respuesta HTTP del guardado):
        _poll_once() recorre TODOS los tramos, y si la API real esta
        inalcanzable cada endpoint tarda hasta PADTEC_TIMEOUT en caer a mock;
        con varios tramos eso puede sumar bastantes segundos. Ejecutarlo
        sincronicamente hacia que el boton "Guardar" se quedara colgado
        esperando ese sondeo completo antes de responder.
        """
        threading.Thread(target=self._poll_now_bg, daemon=True).start()

    def _poll_now_bg(self):
        try:
            self._poll_once()
            self.last_poll = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        except Exception as exc:
            self._log(f"Error en sondeo manual: {exc}", "error")

    def _log(self, msg: str, kind: str = "info"):
        entry = {"ts": datetime.now().strftime("%Y-%m-%d %H:%M:%S"), "kind": kind, "msg": msg}
        with self._lock:
            self.events.append(entry)
            if len(self.events) > settings.MONITOR_LOG_MAX:
                self.events.pop(0)

    # ---------------- obtencion de datos: solo API real ----------------
    def _fetch_endpoint(self, card_id: str, stage_id: int = 0) -> dict:
        """Consulta la API real de PADTEC para un card_id/stage.

        Si el card_id todavia no se configuro (placeholder recien creado
        desde "Agregar tramo") o la API no responde, se devuelve una
        lectura vacia (rx/tx = None) para que el dashboard muestre "---"
        en vez de datos aleatorios. Nunca se generan valores simulados.
        """
        if not card_id or card_id.startswith("0000-"):
            # Tramo/sitio recien creado sin ID de tarjeta real todavia.
            return self._empty_reading()

        try:
            card = self.client.get_card(card_id)
            stage_state = self.client.get_stage(card_id, stage_id)

            if self.client.token_renewed_last_call:
                self._log(f"Token renovado automaticamente (detectado al consultar {card_id})", "token")
                self.client.token_renewed_last_call = False

            return {
                "name": card.get("state", {}).get("name"),
                "location": card.get("state", {}).get("location"),
                "device_update": card.get("state", {}).get("last-update"),
                "rx": stage_state.get("power-rx"),
                "tx": stage_state.get("power-tx"),
                "source": "live",
            }
        except Exception as exc:
            self._log(f"API real no disponible para {card_id} ({exc}) -> sin datos", "warn")
            return self._empty_reading()

    @staticmethod
    def _empty_reading() -> dict:
        return {
            "name": None,
            "location": None,
            "device_update": None,
            "rx": None,
            "tx": None,
            "source": "empty",
        }

    def _track_change(self, card_id: str, path_label: str, seg_title: str, site_name: str, reading: dict):
        rx = reading["rx"]
        prev = self._prev_rx.get(card_id)
        if rx is not None:
            if prev is not None and abs(prev - rx) >= 0.05:
                change = {
                    "from": prev,
                    "to": rx,
                    "ts": datetime.now().strftime("%d/%m %H:%M:%S"),
                    "path": path_label,
                }
                self._last_change[card_id] = change
                self._log(
                    f"Cambio RX en {seg_title} · {site_name} ({path_label}): "
                    f"{prev:.2f} dBm -> {rx:.2f} dBm",
                    "change",
                )
            self._prev_rx[card_id] = rx
        reading["last_change"] = self._last_change.get(card_id)

    # ---------------- ciclo principal ----------------
    def _poll_once(self):
        segments_in = self.store.get_all()
        segments_out = []
        counts = {"good": 0, "warning": 0, "critical": 0}

        for seg in segments_in:
            warn_at = seg.get("warning_at", WARN_DEFAULT)
            crit_at = seg.get("critical_at", CRIT_DEFAULT)

            sites_out = {}
            for side_key in ("site_a", "site_b"):
                site = seg[side_key]
                w_ep, p_ep = site["working"], site["protection"]

                w = self._fetch_endpoint(w_ep["card_id"], w_ep.get("stage_id", 0))
                p = self._fetch_endpoint(p_ep["card_id"], p_ep.get("stage_id", 0))

                self._track_change(w_ep["card_id"], "W", seg["title"], site["name"], w)
                self._track_change(p_ep["card_id"], "P", seg["title"], site["name"], p)

                w_status = _classify(w["rx"], warn_at, crit_at)
                p_status = _classify(p["rx"], warn_at, crit_at)
                site_status = _worse(w_status, p_status)

                sites_out[side_key] = {
                    "name": site["name"],
                    "status": site_status,
                    "working": {**w_ep, **w, "status": w_status},
                    "protection": {**p_ep, **p, "status": p_status},
                }
                counts[site_status] = counts.get(site_status, 0) + 1

            # Camino activo del tramo: heuristica -> el que tenga mejor (menos negativo)
            # RX promedio entre ambos extremos. Si tu plataforma expone un flag real de
            # "camino activo" en el futuro, reemplazar esta heuristica por ese valor.
            def _avg(path_key):
                vals = [sites_out[s][path_key]["rx"] for s in ("site_a", "site_b") if sites_out[s][path_key]["rx"] is not None]
                return sum(vals) / len(vals) if vals else None

            w_avg, p_avg = _avg("working"), _avg("protection")
            active_path = "protection" if (p_avg is not None and (w_avg is None or p_avg > w_avg)) else "working"

            seg_status = _worse(sites_out["site_a"]["status"], sites_out["site_b"]["status"])

            segments_out.append({
                "id": seg["id"],
                "title": seg["title"],
                "km": seg["km"],
                "warning_at": warn_at,
                "critical_at": crit_at,
                "status": seg_status,
                "active_path": active_path,
                "site_a": sites_out["site_a"],
                "site_b": sites_out["site_b"],
            })

        with self._lock:
            self.route_cache = {
                "segments": segments_out,
                "summary": counts,
                "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }

    def _loop(self):
        self._log(f"Monitor iniciado (solo datos reales, intervalo={settings.POLL_INTERVAL_SECONDS}s)", "info")
        while True:
            self.iteration += 1
            try:
                self._poll_once()
                self.last_poll = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            except Exception as exc:
                self._log(f"Error en iteracion #{self.iteration}: {exc}", "error")
            time.sleep(settings.POLL_INTERVAL_SECONDS)

    # ---------------- lectura para la API ----------------
    def get_route(self):
        with self._lock:
            return self.route_cache

    def get_status(self):
        with self._lock:
            events = list(reversed(self.events[-80:]))
        return {
            "iteration": self.iteration,
            "last_poll": self.last_poll,
            "mode": "live",
            "poll_interval": settings.POLL_INTERVAL_SECONDS,
            "token_preview": (self.client._token[:24] + "...") if self.client._token else None,
            "events": events,
        }


monitor = MonitorService()