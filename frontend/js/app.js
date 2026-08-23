async function saludar() {

    const nombre =
        document.getElementById("nombre").value;

    const respuesta =
        await window.pywebview.api.saludar(nombre);

    document.getElementById("resultado").innerText =
        respuesta.mensaje;
}