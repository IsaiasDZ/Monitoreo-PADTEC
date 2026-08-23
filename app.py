import webview
from backend.api import API


api = API()


if __name__ == "__main__":

    ventana = webview.create_window(
        title="Mi Programa",
        url="frontend/index.html",
        js_api=api,
        width=1200,
        height=700,
        min_size=(800, 500)
    )

    webview.start()