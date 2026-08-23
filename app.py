"""
MonitoreoPADTEC - punto de entrada.

Ejecutar con:
    uvicorn app:app --reload --host 0.0.0.0 --port 8000

o directamente:
    python app.py
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from backend.api import router as api_router
from backend.config.settings import settings
from backend.services.monitor_service import monitor

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI(title="Monitoreo PADTEC", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router, prefix="/api")


@app.on_event("startup")
def on_startup():
    monitor.start()


# El frontend estatico (index.html, monitor.html, css/, js/) se sirve al final
# para que las rutas /api/* tengan prioridad.
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)