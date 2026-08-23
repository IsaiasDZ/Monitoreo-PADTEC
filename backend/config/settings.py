"""
Configuracion central del backend, leida desde variables de entorno (.env).

Es la version "configurable" de las constantes que estaban hardcodeadas en
import_requests.py / import_requests_HOA.py (URL, usuario, password, intervalo
de 10 segundos, etc).
"""
import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent.parent
load_dotenv(BASE_DIR / ".env")


def _bool(value: str, default: bool = False) -> bool:
    if value is None:
        return default
    return value.strip().lower() in ("1", "true", "yes", "on")


def _list(value: str, default):
    if not value:
        return default
    return [v.strip() for v in value.split(",") if v.strip()]


class Settings:
    # ---- API real PADTEC ----
    API_URL: str = os.getenv("API_URL", "http://172.18.22.147").rstrip("/")
    PADTEC_USERNAME: str = os.getenv("PADTEC_USERNAME", "adm")
    PADTEC_PASSWORD: str = os.getenv("PADTEC_PASSWORD", "padtec")
    PADTEC_TIMEOUT: float = float(os.getenv("PADTEC_TIMEOUT", "5"))

    # ---- Monitoreo en background ----
    # Solo se muestran datos reales de la API PADTEC. Si un card_id no
    # responde (placeholder recien creado, red caida, timeout), el EOA
    # queda vacio ("---") en el dashboard en vez de simular valores.
    POLL_INTERVAL_SECONDS: int = int(os.getenv("POLL_INTERVAL_SECONDS", "20"))
    MONITOR_LOG_MAX: int = int(os.getenv("MONITOR_LOG_MAX", "300"))

    # ---- Servidor / CORS ----
    DEBUG: bool = _bool(os.getenv("DEBUG"), default=False)
    CORS_ORIGINS: list = _list(os.getenv("CORS_ORIGINS"), default=["*"])


settings = Settings()