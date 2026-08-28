"""
MonitoreoPADTEC - version de escritorio.

Este es el punto de entrada real de la app cuando se empaqueta con
PyInstaller: levanta el backend FastAPI (app.py) en un hilo con uvicorn,
y abre una ventana nativa de Windows con PyWebView apuntando a ese
servidor local, para que el usuario nunca vea una consola ni tenga que
abrir un navegador manualmente.

Ejecutar en desarrollo con:
    python desktop.py

Empaquetar con:
    pyinstaller MonitoreoPADTEC.spec
"""
import socket
import threading
import time
from pathlib import Path

import uvicorn
import webview

from app import app as fastapi_app

HOST = "127.0.0.1"


class DesktopApi:
    def save_config(self, config_json: str):
        """Abre el diálogo nativo y guarda la configuración elegida."""
        import webview

        window = webview.windows[0]
        result = window.create_file_dialog(
            webview.SAVE_DIALOG,
            directory=str(Path.home() / "Downloads"),
            save_filename="padtec-config.json",
            file_types=("Configuración PADTEC (*.json)", "Todos los archivos (*.*)"),
        )
        if not result:
            return None
        target = Path(result[0] if isinstance(result, (list, tuple)) else result)
        target.write_text(config_json, encoding="utf-8")
        return str(target)


def _free_port(preferred: int = 8000) -> int:
    """Usa el puerto preferido si esta libre; si no, pide uno libre al SO."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((HOST, preferred))
            return preferred
        except OSError:
            s.bind((HOST, 0))
            return s.getsockname()[1]


def _run_server(port: int):
    config = uvicorn.Config(
        fastapi_app,
        host=HOST,
        port=port,
        log_level="warning",
        reload=False,  # reload no es compatible con hilos / .exe empaquetado
    )
    server = uvicorn.Server(config)
    server.run()


def _wait_until_up(port: int, timeout: float = 10.0):
    """Espera a que uvicorn responda antes de abrir la ventana, para no
    mostrarle al usuario una pantalla en blanco / error de conexion."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((HOST, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def main():
    port = _free_port(8000)

    server_thread = threading.Thread(target=_run_server, args=(port,), daemon=True)
    server_thread.start()

    _wait_until_up(port)

    webview.create_window(
        "Monitoreo PADTEC",
        f"http://{HOST}:{port}",
        width=1280,
        height=800,
        min_size=(1024, 700),
        js_api=DesktopApi(),
    )
    webview.start()


if __name__ == "__main__":
    main()
