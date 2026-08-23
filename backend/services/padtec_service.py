"""
Cliente de la API real de PADTEC.

Es la evolucion de `obtener_token()` / `consultar_card()` / `consultar_stage()`
de import_requests.py e import_requests_HOA.py: mismo login, mismos endpoints
(/card/card/{id} y /card/card/{id}/stage/), pero encapsulado en una clase que
guarda el token en memoria y lo renueva solo cuando la API responde 403,
para que el monitor en background no tenga que preocuparse por eso.
"""
import requests

from backend.config.settings import settings


class PadtecAuthError(Exception):
    """No fue posible autenticar contra la API de PADTEC."""


class PadtecService:
    def __init__(self):
        self._token = None
        self.token_renewed_last_call = False

    # ---------------- auth ----------------
    def _login(self) -> str:
        login_url = f"{settings.API_URL}/api/auth/login/"
        payload = {"username": settings.PADTEC_USERNAME, "password": settings.PADTEC_PASSWORD}
        resp = requests.post(login_url, json=payload, timeout=settings.PADTEC_TIMEOUT)
        resp.raise_for_status()
        token = resp.json().get("token")
        if not token:
            raise PadtecAuthError("La API de PADTEC no devolvio token en el login")
        return token

    def _ensure_token(self):
        if not self._token:
            self._token = self._login()

    def _headers(self):
        return {"Authorization": f"Token {self._token}", "Content-Type": "application/json"}

    def _get(self, url: str):
        """GET con reintento automatico: si el token vencio (403), relogin + 1 reintento."""
        self._ensure_token()
        resp = requests.get(url, headers=self._headers(), timeout=settings.PADTEC_TIMEOUT)

        if resp.status_code == 403:
            self._token = self._login()
            self.token_renewed_last_call = True
            resp = requests.get(url, headers=self._headers(), timeout=settings.PADTEC_TIMEOUT)

        resp.raise_for_status()
        return resp.json()

    # ---------------- endpoints ----------------
    def get_card(self, card_id: str) -> dict:
        return self._get(f"{settings.API_URL}/card/card/{card_id}")

    def get_stage(self, card_id: str, stage_id: int = 0) -> dict:
        data = self._get(f"{settings.API_URL}/card/card/{card_id}/stage/")
        stage = data.get(str(stage_id), {})
        return stage.get("state", {})
