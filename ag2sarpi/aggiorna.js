/* ag2sarpi.com — il pulsante «Aggiorna».
 *
 * Il sito si puo' aggiungere alla schermata Home di iPhone e Mac: quando si apre
 * da li' non c'e' la barra del browser, quindi non c'e' ne' l'indirizzo ne' il
 * tasto di ricaricamento. Senza questo pulsante, dopo una correzione il telefono
 * puo' continuare a mostrare la versione vecchia per ore.
 *
 * Cosa fa: butta via le copie che il dispositivo tiene da parte, riscarica dal
 * server la pagina con il suo foglio di stile e i suoi programmi, e riapre la
 * stessa schermata. Non tocca nessun dato inserito nei moduli.
 */
(function () {
  'use strict';

  var bottone = document.getElementById('btnAggiorna');
  if (!bottone) return;

  function svuotaCache() {
    var lavori = [];
    try {
      if (window.caches && caches.keys) {
        lavori.push(caches.keys().then(function (nomi) {
          return Promise.all(nomi.map(function (n) { return caches.delete(n); }));
        }));
      }
    } catch (e) { /* niente cache da svuotare */ }
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        lavori.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        }));
      }
    } catch (e) { /* nessun service worker */ }
    return Promise.all(lavori).catch(function () { });
  }

  /* Riscarica dal server anche stile e programmi: cosi' il ricaricamento
     successivo trova gia' pronta la versione nuova, anche su iPhone. */
  function riscaricaRisorse() {
    var indirizzi = [location.href];
    Array.prototype.forEach.call(
      document.querySelectorAll('script[src], link[rel=stylesheet]'),
      function (n) { indirizzi.push(n.src || n.href); }
    );
    return Promise.all(indirizzi.map(function (u) {
      return fetch(u, { cache: 'reload' }).catch(function () { });
    }));
  }

  bottone.addEventListener('click', function () {
    if (bottone.disabled) return;
    bottone.disabled = true;
    bottone.classList.add('gira');
    svuotaCache()
      .then(riscaricaRisorse)
      .then(function () { location.reload(); })
      .catch(function () {
        bottone.disabled = false;
        bottone.classList.remove('gira');
      });
  });
})();
