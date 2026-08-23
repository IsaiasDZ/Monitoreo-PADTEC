"""
Datos simulados de PADTEC.

Replica el shape REAL que devuelve la API (verificado contra respuestas
reales de /card/card/{id} y /card/card/{id}/stage/) para que
PadtecService/MonitorService no tengan que distinguir entre real y mock:
mismo anidado state/config/capability, mismos nombres de campo
("power-rx", "power-tx", "last-update", stages indexados como "0", "1"...).

Los valores de power-rx "caminan" levemente en cada consulta para poder ver
en el dashboard cambios de estado (good/warning/critical) y la fecha de
"ultima actualizacion" moviendose, sin depender de la red de PADTEC.
"""
import random
from datetime import datetime

_rx_state = {}  # card_id -> ultimo power-rx simulado
_BASE_RX = {}  # card_id -> nivel base (se completa perezosamente)

# Tipos de tarjeta que existen en la red real (EOA/HOA = amplificador con
# stage de potencia; OPS-HA = switch de proteccion optica). Se elige uno
# por card_id de forma determinista solo para que "name"/"type" luzcan
# realistas; el dato que realmente usa el dashboard (power-rx/power-tx)
# se simula igual para todos.
_TYPES = ["EOA", "HOA", "EDFA"]


def _seed_rnd(card_id: str) -> random.Random:
    seed = sum(ord(c) for c in card_id)
    return random.Random(seed)


def _rx_for(card_id: str) -> float:
    if card_id not in _BASE_RX:
        # semilla estable por card_id para que cada EOA tenga un nivel propio
        _BASE_RX[card_id] = _seed_rnd(card_id).uniform(-22.0, -12.0)
    base = _BASE_RX[card_id]

    prev = _rx_state.get(card_id, base)
    drift = random.uniform(-0.6, 0.6)
    new_rx = max(-30.0, min(-8.0, prev + drift))
    _rx_state[card_id] = new_rx
    return new_rx


def _card_type(card_id: str) -> str:
    return _TYPES[_seed_rnd(card_id).randrange(len(_TYPES))]


def get_card(card_id: str) -> dict:
    """Simula GET /card/card/{id} (misma forma que la respuesta real:
    id / state / config / capability)."""
    card_type = _card_type(card_id)
    now = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    return {
        "id": card_id,
        "state": {
            "name": f"{card_type} {card_id}",
            "location": "Simulado",
            "map": "Simulado",
            "last-update": now,
            "card-state": True,
            "is-up": True,
            "type": card_type,
            "model": card_type,
            "collector-state": "STATUS_OK",
        },
        "config": {
            "name": f"{card_type} {card_id}",
            "card-state": True,
        },
        "capability": {
            "name": {"type": "string"},
            "card-state": {"type": "boolean", "options": ["True", "False"]},
        },
    }


def get_stage(card_id: str, stage_id: int = 0) -> dict:
    """Simula GET /card/card/{id}/stage/: un dict indexado por stage
    ("0", "1", ...), cada uno con id/state/config/capability, igual que
    la API real. PadtecService.get_stage hace
    data[str(stage_id)]["state"], asi que replicamos exactamente eso."""
    stages = _all_stages(card_id)
    stage = stages.get(str(stage_id), {})
    return stage.get("state", {})


def _all_stages(card_id: str) -> dict:
    rx = round(_rx_for(card_id), 2)
    tx = round(rx + random.uniform(4.0, 6.0), 2)
    card_type = _card_type(card_id)
    return {
        "0": {
            "id": "0",
            "state": {
                "name": f"{card_type} Rx",
                "type": card_type,
                "power-rx": rx,
                "power-tx": tx,
                "gain": round(25.0 + random.uniform(-0.3, 0.3), 2),
                "temperature": 27.0,
                "integrityTest": True,
                "status-laser-los-in": False,
                "currentOperationModeEdfa": "AGC",
            },
            "config": {
                "target-gain": 25.0,
                "operation-mode": "MANUAL (PUMP/AGC)",
            },
            "capability": {
                "operation-mode": '[ "MANUAL (PUMP/AGC)", "AGC_ON_OFF (AGC)"]'
            },
        }
    }