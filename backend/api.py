import os
from dotenv import load_dotenv

load_dotenv()


class API:

    def saludar(self, nombre):
        return {
            "success": True,
            "mensaje": f"Hola {nombre}, esto viene desde Python"
        }

    def obtener_configuracion(self):
        api_url = os.getenv("API_URL")

        return {
            "api_url": api_url
        }