from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal

from backend.services.monitor_service import monitor
from backend.data.store import LinksStore

router = APIRouter()
store = LinksStore()


# ==================== Modelos ====================

class EOAEndpoint(BaseModel):
    card_id: str = Field(..., description="ID del card en PADTEC, ej. 2538-304")
    stage_id: int = 0
    label: Literal["W", "P"] = "W"


class SiteEdit(BaseModel):
    working: EOAEndpoint
    protection: EOAEndpoint


class SiteConfig(BaseModel):
    name: str
    working: EOAEndpoint
    protection: EOAEndpoint


class SegmentConfig(BaseModel):
    title: str
    km: float
    warning_at: float = -18.0
    critical_at: float = -23.0
    site_a: SiteConfig
    site_b: SiteConfig


# ==================== Salud / monitoreo ====================

@router.get("/health")
def health():
    return {"ok": True}


@router.get("/route")
def get_route():
    """Datos en vivo del dashboard: 6 tramos, RX/TX de cada EOA W/P, estado y camino activo."""
    return monitor.get_route()


@router.get("/monitor")
def get_monitor_status():
    """Para la pantalla externa: iteraciones, ultimo sondeo, modo (mock/live) y log de eventos."""
    return monitor.get_status()


# ==================== CRUD de tramos / EOA ====================

@router.get("/links")
def list_links():
    return store.get_all()


@router.get("/links/{segment_id}")
def get_link(segment_id: int):
    seg = store.get_one(segment_id)
    if not seg:
        raise HTTPException(404, "Tramo no encontrado")
    return seg


@router.post("/links", status_code=201)
def create_link(segment: SegmentConfig):
    created = store.create(segment.model_dump())
    monitor.poll_now()
    return created


@router.put("/links/{segment_id}")
def update_link(segment_id: int, segment: SegmentConfig):
    updated = store.update(segment_id, segment.model_dump())
    if not updated:
        raise HTTPException(404, "Tramo no encontrado")
    monitor.poll_now()
    return updated


@router.patch("/links/{segment_id}/site/{site_key}")
def update_site(segment_id: int, site_key: Literal["site_a", "site_b"], payload: SiteEdit):
    """
    Endpoint que usa el boton 'Editar' de cada EOA en el dashboard: permite
    reconfigurar individualmente el card_id/stage de Working y de Protection
    de un sitio, sin tocar el resto del tramo.
    """
    updated = store.update_site(segment_id, site_key, payload.model_dump())
    if not updated:
        raise HTTPException(404, "Tramo o sitio no encontrado")
    monitor.poll_now()
    return updated


@router.delete("/links/{segment_id}", status_code=204)
def delete_link(segment_id: int):
    ok = store.delete(segment_id)
    if not ok:
        raise HTTPException(404, "Tramo no encontrado")
    monitor.poll_now()
    return None