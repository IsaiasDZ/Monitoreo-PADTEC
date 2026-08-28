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
from concurrent.futures import ThreadPoolExecutor
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

        self.last_poll = None
        self.next_poll_at = None
        self.events = []  # log para la pantalla externa (mas reciente al final)
        self.route_cache = {"segments": [], "summary": {"good": 0, "warning": 0, "critical": 0}, "updated_at": None}

        self._prev_rx = {}      # (endpoint, stage_id) -> ultimo power-rx visto
        self._last_change = {}  # (endpoint, stage_id) -> {from, to, ts, path}
        self._last_stage = {}   # endpoint -> stage_id activo
        self._lock = threading.Lock()
        self._poll_lock = threading.Lock()  # evita que el loop y un poll manual corran a la vez
        self._thread = None
        self._executor = ThreadPoolExecutor(max_workers=16, thread_name_prefix="padtec-fetch")

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
        el proximo tick del hilo en background.

        Corre en un hilo aparte (no bloquea la respuesta HTTP del guardado)
        y usa el mismo _poll_lock que el loop principal, para que nunca haya
        dos sondeos escribiendo route_cache/last_poll al mismo tiempo (eso
        causaba que a veces la fecha "retrocediera" si un poll viejo mas
        lento terminaba despues de uno mas nuevo).
        """
        threading.Thread(target=self._poll_now_bg, daemon=True).start()

    def _poll_now_bg(self):
        try:
            with self._poll_lock:
                self._poll_once()
                self.last_poll = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                self.next_poll_at = time.time() + settings.POLL_INTERVAL_SECONDS
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

    def _track_change(self, endpoint_key, stage_id: int, path_label: str, seg_title: str, site_name: str, reading: dict):
        rx = reading["rx"]
        stage_key = (endpoint_key, stage_id)
        previous_stage = self._last_stage.get(endpoint_key)
        if previous_stage != stage_id:
            self._last_stage[endpoint_key] = stage_id
            self._prev_rx.pop(stage_key, None)
            reading["last_change"] = self._last_change.get(stage_key)
            if rx is not None:
                self._prev_rx[stage_key] = rx
            return

        prev = self._prev_rx.get(stage_key)
        if rx is not None:
            if prev is not None and abs(prev - rx) >= 0.05:
                change = {
                    "from": prev,
                    "to": rx,
                    "ts": datetime.now().strftime("%d/%m %H:%M:%S"),
                    "path": path_label,
                }
                self._last_change[stage_key] = change
                self._log(
                    f"Cambio RX en {seg_title} · {site_name} ({path_label}): "
                    f"{prev:.2f} dBm -> {rx:.2f} dBm",
                    "change",
                )
            self._prev_rx[stage_key] = rx
        reading["last_change"] = self._last_change.get(stage_key)

    # ---------------- ciclo principal ----------------
    def _poll_once(self):
        segments_in = self.store.get_all()

        # 1) Recolectar TODOS los endpoints a consultar (working + protection
        #    de ambos extremos, de todos los tramos) y dispararlos EN
        #    PARALELO. Antes se consultaban uno por uno: con varios tramos y
        #    la API real caida/lenta, cada endpoint podia tardar hasta
        #    PADTEC_TIMEOUT en fallar, y esa espera se acumulaba (7 tramos x
        #    2 sitios x 2 caminos = 28 peticiones secuenciales), haciendo que
        #    una sola iteracion durara mucho mas que POLL_INTERVAL_SECONDS y
        #    de forma muy variable (de ahi los saltos de fecha/contador y los
        #    logs con hasta 5s de diferencia entre si).
        fetch_keys = [
            (seg["id"], side_key, path_key, seg[side_key][path_key]["card_id"], seg[side_key][path_key].get("stage_id", 0))
            for seg in segments_in
            for side_key in ("site_a", "site_b")
            for path_key in ("working", "protection")
        ]
        unique_keys = list(dict.fromkeys((k[3], k[4]) for k in fetch_keys))
        results = list(self._executor.map(lambda k: self._fetch_endpoint(k[0], k[1]), unique_keys)) if unique_keys else []
        result_by_endpoint = dict(zip(unique_keys, results))
        readings = {(k[0], k[1], k[2]): result_by_endpoint[(k[3], k[4])] for k in fetch_keys}

        segments_out = []
        counts = {"good": 0, "warning": 0, "critical": 0}

        for seg in segments_in:
            warn_at = seg.get("warning_at", WARN_DEFAULT)
            crit_at = seg.get("critical_at", CRIT_DEFAULT)

            sites_out = {}
            for side_key in ("site_a", "site_b"):
                site = seg[side_key]
                w_ep, p_ep = site["working"], site["protection"]

                w = readings[(seg["id"], side_key, "working")]
                p = readings[(seg["id"], side_key, "protection")]

                self._track_change((seg["id"], side_key, "working"), w_ep.get("stage_id", 0), "W", seg["title"], site["name"], w)
                self._track_change((seg["id"], side_key, "protection"), p_ep.get("stage_id", 0), "P", seg["title"], site["name"], p)

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
            tick_start = time.monotonic()
            try:
                with self._poll_lock:  # nunca corre a la vez que un poll_now() manual
                    self._poll_once()
                self.last_poll = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            except Exception as exc:
                self._log(f"Error en iteracion #{self.iteration}: {exc}", "error")

            elapsed = time.monotonic() - tick_start
            if elapsed > settings.POLL_INTERVAL_SECONDS:
                self._log(
                    f"Sondeo tardo {elapsed:.1f}s, mas que el intervalo "
                    f"configurado ({settings.POLL_INTERVAL_SECONDS}s) -> revisar conectividad "
                    f"con la API de PADTEC (cards inalcanzables/timeout)",
                    "warn",
                )
            # se descuenta lo que tardo el sondeo para que el PRÓXIMO tick
            # arranque lo mas cerca posible de POLL_INTERVAL_SECONDS desde el
            # inicio del anterior, en vez de sumarse siempre al final.
            sleep_for = max(1.0, settings.POLL_INTERVAL_SECONDS - elapsed)
            self.next_poll_at = time.time() + sleep_for
            time.sleep(sleep_for)

    # ---------------- lectura para la API ----------------
    def get_route(self):
        with self._lock:
            return self.route_cache

    def get_status(self):
        with self._lock:
            events = list(reversed(self.events[-80:]))
        return {
            "last_poll": self.last_poll,
            "next_poll_at": self.next_poll_at,
            "mode": "live",
            "poll_interval": settings.POLL_INTERVAL_SECONDS,
            "token_preview": (self.client._token[:24] + "...") if self.client._token else None,
            "events": events,
        }


monitor = MonitorService()