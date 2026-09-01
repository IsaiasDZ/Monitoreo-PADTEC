"""
Persistencia simple en JSON de los tramos de fibra (6 por defecto, igual que
la ruta fisica monitoreada) y sus EOA Working/Protection.

Reemplaza las constantes WORKING_CARD_ID / PROTECTION_CARD_ID hardcodeadas en
import_requests_HOA.py por un CRUD editable desde el dashboard (boton
"Editar" de cada EOA + panel de administracion para crear/eliminar tramos).
"""
import json
import os
import sys
import threading
from pathlib import Path


def _user_data_dir() -> Path:
    """
    Carpeta donde vive links.json en tiempo de ejecucion.

    - Empaquetado con PyInstaller (.exe): NO se guarda dentro de la carpeta
      del programa (dist/MonitoreoPADTEC/...), porque esa carpeta se
      sobrescribe cada vez que se reinstala/actualiza el .exe, y ademas
      puede no ser escribible si el programa esta instalado en
      "C:\\Program Files". En su lugar se usa la carpeta de datos del
      usuario de Windows (%LOCALAPPDATA%\\MonitoreoPADTEC\\), que siempre
      es escribible y nunca se toca al reinstalar.
    - Corriendo con `python app.py` / `python desktop.py` en desarrollo:
      se sigue usando backend/data/ (junto al codigo), para no ensuciar
      %LOCALAPPDATA% mientras se programa.
    """
    if getattr(sys, "frozen", False):
        base = os.getenv("LOCALAPPDATA") or os.getenv("APPDATA") or str(Path.home())
        data_dir = Path(base) / "MonitoreoPADTEC"
    else:
        data_dir = Path(__file__).resolve().parent
    data_dir.mkdir(parents=True, exist_ok=True)
    return data_dir


DATA_FILE = _user_data_dir() / "links.json"

_DEFAULT_SEGMENTS = [
    {
        "id": 1,
        "title": "NODO CENTRAL ⟷ REPETIDORA NORTE",
        "km": 18.4,
        "warning_at": -18.0,
        "critical_at": -23.0,
        "site_a": {
            "name": "Nodo Central",
            "working": {"card_id": "2538-78", "stage_id": 0, "label": "W"},
            "protection": {"card_id": "2538-304", "stage_id": 0, "label": "P"},
        },
        "site_b": {
            "name": "Repetidora Norte",
            "working": {"card_id": "2335-453", "stage_id": 0, "label": "W"},
            "protection": {"card_id": "2335-454", "stage_id": 0, "label": "P"},
        },
    },
]


def _make_default_segment(i: int) -> dict:
    base = 1000 + i * 10
    return {
        "id": i,
        "title": f"TRAMO {i:02d}",
        "km": 12.0,
        "warning_at": -18.0,
        "critical_at": -23.0,
        "site_a": {
            "name": f"Sitio {i}A",
            "working": {"card_id": f"{base}-000", "stage_id": 0, "label": "W"},
            "protection": {"card_id": f"{base}-001", "stage_id": 0, "label": "P"},
        },
        "site_b": {
            "name": f"Sitio {i}B",
            "working": {"card_id": f"{base}-002", "stage_id": 0, "label": "W"},
            "protection": {"card_id": f"{base}-003", "stage_id": 0, "label": "P"},
        },
    }


DEFAULT_SEGMENTS = _DEFAULT_SEGMENTS + [_make_default_segment(i) for i in range(2, 7)]


class LinksStore:
    _lock = threading.Lock()

    def __init__(self):
        if not DATA_FILE.exists():
            self._write(DEFAULT_SEGMENTS)

    # ---------------- io ----------------
    def _read(self) -> list:
        with self._lock:
            if not DATA_FILE.exists():
                return []
            with open(DATA_FILE, "r", encoding="utf-8") as f:
                return json.load(f)

    def _write(self, segments: list):
        with self._lock:
            DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(DATA_FILE, "w", encoding="utf-8") as f:
                json.dump(segments, f, indent=2, ensure_ascii=False)

    # ---------------- CRUD ----------------
    def get_all(self) -> list:
        return self._read()

    def get_one(self, segment_id: int) -> dict | None:
        return next((s for s in self._read() if s["id"] == segment_id), None)

    def create(self, data: dict) -> dict:
        segments = self._read()
        next_id = (max((s["id"] for s in segments), default=0)) + 1
        new_segment = {"id": next_id, **data}
        segments.append(new_segment)
        self._write(segments)
        return new_segment

    def update(self, segment_id: int, data: dict) -> dict | None:
        segments = self._read()
        for i, s in enumerate(segments):
            if s["id"] == segment_id:
                segments[i] = {"id": segment_id, **data}
                self._write(segments)
                return segments[i]
        return None

    def update_site(self, segment_id: int, site_key: str, data: dict) -> dict | None:
        segments = self._read()
        for s in segments:
            if s["id"] == segment_id:
                if site_key not in s:
                    return None
                s[site_key]["name"] = data["name"].strip()
                if data.get("title") is not None and data["title"].strip():
                    s["title"] = data["title"].strip()
                s[site_key]["working"] = data["working"]
                s[site_key]["protection"] = data["protection"]
                if data.get("ops") is not None:
                    s[site_key]["ops"] = data["ops"]
                self._write(segments)
                return s
        return None

    def delete(self, segment_id: int) -> bool:
        segments = self._read()
        filtered = [s for s in segments if s["id"] != segment_id]
        if len(filtered) == len(segments):
            return False
        self._write(filtered)
        return True

    def update_site_stage(self, segment_id: int, site_key: str, stage_id: int) -> dict | None:
        segments = self._read()
        for segment in segments:
            if segment["id"] == segment_id and site_key in segment:
                segment[site_key]["working"]["stage_id"] = stage_id
                segment[site_key]["protection"]["stage_id"] = stage_id
                self._write(segments)
                return segment
        return None

    def replace_all(self, segments: list) -> None:
        """Valida la forma minima antes de reemplazar la configuracion."""
        normalized = []
        ids = set()
        for segment in segments:
            if not isinstance(segment, dict):
                raise ValueError("cada tramo debe ser un objeto")
            segment_id = int(segment["id"])
            if segment_id in ids:
                raise ValueError("los ids de tramo deben ser unicos")
            for site_key in ("site_a", "site_b"):
                site = segment[site_key]
                if not site.get("name", "").strip():
                    raise ValueError("cada sitio debe tener nombre")
                for path_key in ("working", "protection"):
                    if not site[path_key].get("card_id"):
                        raise ValueError("cada endpoint debe tener card_id")
                ops = site.get("ops")
                if ops is not None and ops.get("card_id") is not None and not str(ops.get("card_id", "")).strip():
                    raise ValueError("el card_id de OPS no puede quedar vacio")
            ids.add(segment_id)
            normalized.append({**segment, "id": segment_id})
        self._write(normalized)