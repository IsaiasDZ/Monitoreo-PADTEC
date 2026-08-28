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
    name: str
    title: str | None = None
    working: EOAEndpoint
    protection: EOAEndpoint


class StageEdit(BaseModel):
    stage_id: int = Field(..., ge=0, le=1)


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


@router.get("/config/export")
def export_config():
    """Exporta todos los parametros editables del dashboard."""
    return {"version": 1, "links": store.get_all()}


@router.put("/config/import")
def import_config(payload: dict):
    """Reemplaza la configuracion editable con un export valido."""
    links = payload.get("links") if isinstance(payload, dict) else None
    if not isinstance(links, list):
        raise HTTPException(400, "El archivo no contiene una lista 'links' valida")
    try:
        store.replace_all(links)
    except (TypeError, KeyError, ValueError) as exc:
        raise HTTPException(400, f"Configuracion invalida: {exc}") from exc
    monitor.poll_now()
    return {"version": 1, "links": store.get_all()}


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


@router.patch("/links/{segment_id}/site/{site_key}/stage")
def update_stage(segment_id: int, site_key: Literal["site_a", "site_b"], payload: StageEdit):
    """Persiste el stage elegido sin lanzar un sondeo adicional."""
    updated = store.update_site_stage(segment_id, site_key, payload.stage_id)
    if not updated:
        raise HTTPException(404, "Tramo o sitio no encontrado")
    return updated


@router.get("/cards/{card_id}")
def get_card_detail(card_id: str, stage_id: int = 0):
    """Devuelve los payloads completos de tarjeta y stage de PADTEC."""
    if not card_id or card_id.startswith("0000-"):
        raise HTTPException(400, "Debe indicar un card_id real")
    try:
        card = monitor.client.get_card(card_id)
        stage = monitor.client.get_stage(card_id, stage_id)
        return {"card": card, "stage": stage, "stage_id": stage_id}
    except Exception as exc:
        raise HTTPException(502, f"No fue posible consultar la tarjeta PADTEC: {exc}") from exc


@router.delete("/links/{segment_id}", status_code=204)
def delete_link(segment_id: int):
    ok = store.delete(segment_id)
    if not ok:
        raise HTTPException(404, "Tramo no encontrado")
    monitor.poll_now()
    return None