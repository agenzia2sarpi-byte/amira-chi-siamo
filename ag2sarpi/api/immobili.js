/* ag2sarpi.com — gli immobili dell'agenzia, letti dalla vostra scheda su immobiliare.it.
 *
 * Perche' esiste: il sito non deve avere una lista di immobili sua, che qualcuno debba
 * ricordarsi di aggiornare. La verita' sta su immobiliare.it: quello che c'e' li' compare
 * qui, quello che togliete da li' sparisce da qui. In tutti e due i versi, da solo.
 *
 * Come gira: e' una funzione che vive su Vercel. A ogni richiesta legge la scheda
 * dell'agenzia e restituisce l'elenco in JSON. La risposta viene tenuta dalla rete di
 * Vercel per 3 minuti (s-maxage), quindi immobiliare.it la interroghiamo pochissimo
 * anche con tanti visitatori, e il ritardo massimo fra il portale e il sito e' 3 minuti.
 * Il pulsante «Aggiorna» del sito chiama ?fresh=1 e salta la cache: quello e' immediato.
 *
 * Se un giorno immobiliare.it dovesse bloccare questa lettura, la strada definitiva e'
 * il feed XML del gestionale con cui pubblicate: stessa pagina, stessa vetrina, solo
 * un'altra sorgente da mettere qui dentro.
 */

'use strict';

/* L'indirizzo della scheda pubblica dell'agenzia su immobiliare.it.
   Si puo' cambiare senza toccare il codice: Vercel → Settings → Environment Variables. */
const SCHEDA_AGENZIA = process.env.IMMOBILIARE_AGENZIA_URL || '';

const PAGINE_MAX = 5;          // la scheda pagina a 25 annunci: 5 pagine = 125 immobili
const TIMEOUT_MS = 9000;       // oltre, rinunciamo: meglio la lista di prima che una pagina appesa

const INTESTAZIONI = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'it-IT,it;q=0.9,en;q=0.6'
};

/* ------------------------------------------------------------------ *
 * Lettura                                                             *
 * ------------------------------------------------------------------ */

async function scarica(url) {
  const stop = new AbortController();
  const t = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: INTESTAZIONI, redirect: 'follow', signal: stop.signal });
    const testo = await r.text();
    return { stato: r.status, testo };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ *
 * Estrazione: tre strade, dalla piu' precisa alla piu' grezza.        *
 * La pagina di immobiliare.it puo' cambiare forma; se salta la prima  *
 * strada si prova la seconda, e la terza regge anche col solo HTML.   *
 * ------------------------------------------------------------------ */

/* 1) Il blocco JSON che Next.js lascia nella pagina: e' la sorgente piu' completa. */
function daNextData(html) {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return [];
  let dati;
  try { dati = JSON.parse(m[1]); } catch (e) { return []; }
  const trovati = [];
  const visti = new Set();
  (function cerca(n, prof) {
    if (!n || typeof n !== 'object' || prof > 12) return;
    if (Array.isArray(n)) { n.forEach(x => cerca(x, prof + 1)); return; }
    const re = n.realEstate && typeof n.realEstate === 'object' ? n.realEstate : n;
    if (re && re.id != null && re.title && (re.price || re.properties)) {
      const chiave = String(re.id);
      if (!visti.has(chiave)) { visti.add(chiave); trovati.push(daOggettoNext(re, n)); }
    }
    Object.keys(n).forEach(k => cerca(n[k], prof + 1));
  })(dati, 0);
  return trovati.filter(Boolean);
}

function daOggettoNext(re, contenitore) {
  const p = (Array.isArray(re.properties) && re.properties[0]) || {};
  const foto = []
    .concat(((p.multimedia && p.multimedia.photos) || []).map(f => f.large || f.medium || f.small))
    .concat(re.mainPhoto ? [re.mainPhoto.large || re.mainPhoto.medium || re.mainPhoto.small] : [])
    .filter(Boolean);
  const luogo = p.location || {};
  const prezzo = re.price || {};
  return ripulisci({
    id: String(re.id),
    url: (contenitore && contenitore.seo && contenitore.seo.url) || re.seoUrl ||
         ('https://www.immobiliare.it/annunci/' + re.id + '/'),
    titolo: testo(re.title),
    prezzo: typeof prezzo.value === 'number' ? prezzo.value : null,
    prezzoTesto: testo(prezzo.formattedValue || prezzo.priceRange || ''),
    contratto: contrattoDi(re, prezzo),
    mq: numero(p.surfaceValue || p.surface),
    locali: numero(p.rooms),
    bagni: numero(p.bathrooms),
    piano: testo(p.floor && (p.floor.abbreviation || p.floor.value)),
    tipologia: testo((p.typology && p.typology.name) || p.typologyValue),
    zona: testo(luogo.microzone || luogo.macrozone || luogo.city),
    foto: foto.slice(0, 4)
  });
}

/* 2) I dati strutturati schema.org che il portale pubblica per i motori di ricerca. */
function daJsonLd(html) {
  const trovati = [];
  const blocchi = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  blocchi.forEach(b => {
    const grezzo = b.replace(/^[\s\S]*?>/, '').replace(/<\/script>$/i, '');
    let d;
    try { d = JSON.parse(grezzo); } catch (e) { return; }
    const elenchi = [].concat(d.itemListElement || (d['@graph'] || []).flatMap(x => x.itemListElement || []) || []);
    elenchi.forEach(el => {
      const it = el.item || el;
      if (!it || !it.url) return;
      const id = (String(it.url).match(/annunci\/(\d+)/) || [])[1];
      if (!id) return;
      const off = it.offers || {};
      trovati.push(ripulisci({
        id,
        url: it.url,
        titolo: testo(it.name),
        prezzo: numero(off.price),
        prezzoTesto: off.price ? formattaEuro(numero(off.price)) : '',
        contratto: /affitt|rent/i.test(JSON.stringify(off)) ? 'affitto' : 'vendita',
        mq: numero(it.floorSize && it.floorSize.value),
        locali: numero(it.numberOfRooms),
        bagni: numero(it.numberOfBathroomsTotal),
        piano: '',
        tipologia: testo(it['@type'] === 'Residence' ? '' : it['@type']),
        zona: testo(it.address && (it.address.addressLocality || it.address.streetAddress)),
        foto: [].concat(it.image || []).filter(x => typeof x === 'string').slice(0, 4)
      }));
    });
  });
  return trovati;
}

/* 3) Ultima rete: gli indirizzi degli annunci presenti nell'HTML, con quel che si riesce
      a leggere intorno. Poco elegante, ma se le prime due saltano la vetrina resta viva. */
function daHtmlGrezzo(html) {
  const trovati = [];
  const visti = new Set();
  const rex = /https?:\/\/www\.immobiliare\.it\/annunci\/(\d+)\/?/g;
  let m;
  while ((m = rex.exec(html)) !== null) {
    const id = m[1];
    if (visti.has(id)) continue;
    visti.add(id);
    const intorno = html.slice(Math.max(0, m.index - 1200), m.index + 1200);
    const titolo = (intorno.match(/title="([^"]{8,140})"/) || [])[1] || '';
    const euro = (intorno.match(/€\s?([\d.]{3,12})/) || [])[1] || '';
    const foto = (intorno.match(/https?:\/\/pic\.im-cdn\.it\/[^\s"']+\.(?:jpg|jpeg|webp)/) || [])[0];
    trovati.push(ripulisci({
      id,
      url: 'https://www.immobiliare.it/annunci/' + id + '/',
      titolo: testo(decodeHtml(titolo)),
      prezzo: euro ? numero(euro.replace(/\./g, '')) : null,
      prezzoTesto: euro ? '€ ' + euro : '',
      contratto: /affitt/i.test(intorno) ? 'affitto' : 'vendita',
      mq: numero((intorno.match(/(\d{2,4})\s?m(?:²|q)/) || [])[1]),
      locali: numero((intorno.match(/(\d{1,2})\s?local/i) || [])[1]),
      bagni: null, piano: '', tipologia: '', zona: '',
      foto: foto ? [foto] : []
    }));
  }
  return trovati;
}

/* ------------------------------------------------------------------ *
 * Utilita'                                                            *
 * ------------------------------------------------------------------ */

const testo = v => (v == null ? '' : String(v)).replace(/\s+/g, ' ').trim();
function numero(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/\./g, '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return isFinite(n) ? n : null;
}
const formattaEuro = n => (n == null ? '' : '€ ' + Math.round(n).toLocaleString('it-IT'));
function decodeHtml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
}
function contrattoDi(re, prezzo) {
  const spia = JSON.stringify(re.contract || re.contractType || prezzo || '');
  return /rent|affitt|locaz/i.test(spia) ? 'affitto' : 'vendita';
}
/* Una scheda vale solo se ha almeno un indirizzo e qualcosa da mostrare. */
function ripulisci(a) {
  if (!a.id || !a.url) return null;
  if (!a.prezzoTesto && a.prezzo != null) a.prezzoTesto = formattaEuro(a.prezzo);
  a.titolo = a.titolo || 'Immobile';
  return a;
}

/* ------------------------------------------------------------------ *
 * La risposta                                                         *
 * ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  const query = (req && req.query) || {};
  const fresco = query.fresh === '1' || query.fresh === 'true';
  const debug = query.debug === '1';

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', fresco
    ? 'no-store'
    : 'public, s-maxage=180, stale-while-revalidate=600');

  if (!SCHEDA_AGENZIA) {
    return res.status(200).end(JSON.stringify({
      ok: false,
      motivo: 'configurazione',
      messaggio: 'Manca l\'indirizzo della scheda agenzia su immobiliare.it. ' +
                 'Va messo nella variabile IMMOBILIARE_AGENZIA_URL su Vercel.',
      immobili: []
    }));
  }

  const diagnostica = [];
  const tutti = [];
  const visti = new Set();

  try {
    for (let pagina = 1; pagina <= PAGINE_MAX; pagina++) {
      const url = pagina === 1
        ? SCHEDA_AGENZIA
        : SCHEDA_AGENZIA + (SCHEDA_AGENZIA.includes('?') ? '&' : '?') + 'pag=' + pagina;

      const r = await scarica(url);
      if (r.stato !== 200) { diagnostica.push({ pagina, stato: r.stato, letti: 0 }); break; }

      let letti = daNextData(r.testo);
      let strada = 'next-data';
      if (!letti.length) { letti = daJsonLd(r.testo); strada = 'json-ld'; }
      if (!letti.length) { letti = daHtmlGrezzo(r.testo); strada = 'html'; }

      diagnostica.push({ pagina, stato: r.stato, strada, letti: letti.length, byte: r.testo.length });

      const nuovi = letti.filter(a => a && !visti.has(a.id));
      nuovi.forEach(a => visti.add(a.id));
      tutti.push.apply(tutti, nuovi);

      if (!nuovi.length) break;      // pagina senza novita': l'elenco e' finito
    }
  } catch (e) {
    diagnostica.push({ errore: String(e && e.message || e) });
  }

  /* Nessun immobile letto non vuol dire «l'agenzia non ha immobili»: molto piu' spesso
     vuol dire che la lettura non e' riuscita. Lo diciamo, e la pagina tiene quelli che
     aveva gia'. Svuotare la vetrina per un errore di rete sarebbe il danno peggiore. */
  const ok = tutti.length > 0;

  const corpo = {
    ok,
    aggiornato: new Date().toISOString(),
    fonte: SCHEDA_AGENZIA,
    conteggio: tutti.length,
    immobili: tutti,
    motivo: ok ? null : 'lettura-non-riuscita',
    messaggio: ok ? null : 'Non sono riuscito a leggere gli annunci dalla scheda su immobiliare.it.'
  };
  if (debug) corpo.diagnostica = diagnostica;

  return res.status(200).end(JSON.stringify(corpo));
};

/* Esposti per le prove: non servono a chi usa il sito, servono a poter controllare
   l'estrazione senza dover interrogare immobiliare.it. */
module.exports.interni = { daNextData, daJsonLd, daHtmlGrezzo };
