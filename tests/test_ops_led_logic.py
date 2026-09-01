from pydantic import ValidationError

from backend.api import SiteEdit
from backend.data.monitor import _ops_led_state


def test_ops_led_state_prefers_working_when_protection_disabled():
    state = _ops_led_state({"protection1": "DISABLE", "working1": "GREEN"})
    assert state["active_path"] == "working"
    assert state["mode"] == "automatic"


def test_ops_led_state_prefers_protection_when_working_disabled():
    state = _ops_led_state({"working1": "DISABLE", "protection1": "ORANGE"})
    assert state["active_path"] == "protection"
    assert state["mode"] == "manual"


def test_siteedit_accepts_ops_entry():
    payload = {
        "name": "Sitio 1",
        "title": "Tramo 1",
        "working": {"card_id": "2389-101", "stage_id": 0, "label": "W"},
        "protection": {"card_id": "2389-102", "stage_id": 0, "label": "P"},
        "ops": {"card_id": "2335-438", "stage_id": 0, "label": "OPS"},
    }
    result = SiteEdit.model_validate(payload)
    assert result.ops.card_id == "2335-438"


def test_siteedit_rejects_missing_ops_card_id_if_present():
    payload = {
        "name": "Sitio 1",
        "working": {"card_id": "2389-101", "stage_id": 0, "label": "W"},
        "protection": {"card_id": "2389-102", "stage_id": 0, "label": "P"},
        "ops": {"card_id": "", "stage_id": 0, "label": "OPS"},
    }
    try:
        SiteEdit.model_validate(payload)
    except ValidationError:
        return
    raise AssertionError("Se esperaba validación de card_id OPS vacío")
