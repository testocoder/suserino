/* Warnt, wenn die Seite direkt als Datei geöffnet wurde (file://).
   Dann blockiert der Browser die JS-Module und nichts funktioniert. */
(function () {
  if (location.protocol !== "file:") return;
  function show() {
    var box = document.createElement("div");
    box.className = "boot-warning";
    box.textContent = "Diese Seite wurde direkt als Datei geöffnet. So blockiert der Browser die Spiele-Logik. " +
      "Bitte im Projektordner „Webseite starten.bat“ doppelklicken und die Seite über http://localhost:8749 öffnen " +
      "(oder den web-Ordner auf einen Webspace hochladen).";
    document.body.prepend(box);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", show);
  } else {
    show();
  }
})();
