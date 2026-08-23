"""
Punto de import esperado por backend/api.py y app.py.

El motor de monitoreo ya esta implementado en backend/data/monitor.py
(MonitorService + instancia `monitor`); este modulo solo lo re-expone bajo
backend.services.monitor_service para no duplicar ni reescribir esa logica.
"""
from backend.data.monitor import MonitorService, monitor  # noqa: F401
