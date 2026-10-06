// Monitor de ofertas: confere de tempos em tempos as páginas públicas das operadoras,
// extrai velocidades, preços e streamings citados e avisa no painel quando algo mudou.
// Não altera planos sozinho: a equipe revisa e aplica pelo painel.
const crypto = require('node:crypto');
const store = require('./store');

const INTERVALO_MS = 12 * 60 * 60 * 1000; // a cada 12 horas
const STREAM_RE = /(globoplay|paramount\+?|\bmax\b|hbo max|netflix|youtube premium|disney\+?|prime video|deezer|apple tv\+?)/gi;

function textoDaPagina(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h\d)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;/g, '$')
    .replace(/\s+/g, ' ');
}

const paraMbps = (n, u) => Math.round(Number(String(n).replace(',', '.')) * (/giga/i.test(u) ? 1000 : 1));
const paraNumero = (p) => Number(p.replace(/[^\d,]/g, '').replace(',', '.'));

// Para cada velocidade citada, pega os preços e streamings logo depois dela.
function extrairOfertas(texto) {
  const ofertas = [];
  const re = /(\d{1,4}(?:[.,]\d)?)\s?(mega|giga)\b/gi;
  let m;
  while ((m = re.exec(texto))) {
    const mbps = paraMbps(m[1], m[2]);
    if (mbps < 50 || mbps > 10000) continue;
    const trecho = texto.slice(m.index, m.index + 420);
    const resto = trecho.slice(m[0].length);
    const ate = resto.search(/\d{1,4}(?:[.,]\d)?\s?(mega|giga)\b/i); // corta na próxima velocidade
    const janela = ate >= 0 ? trecho.slice(0, m[0].length + ate) : trecho;
    const precos = (janela.match(/R\$\s?\d{2,3}(?:[.,]\d{2})?/g) || []).map(paraNumero).filter((v) => v >= 30 && v <= 1500);
    if (!precos.length) continue;
    const streaming = [...new Set((janela.match(STREAM_RE) || []).map((x) => x.toLowerCase().replace(/\s+/g, ' ')))];
    ofertas.push({ velocidadeMbps: mbps, precos: [...new Set(precos)].slice(0, 3), streaming, trecho: janela.trim().slice(0, 220) });
  }
  // remove repetidas (mesma velocidade e mesmos preços)
  const vistas = new Set();
  return ofertas.filter((o) => { const k = o.velocidadeMbps + ':' + o.precos.join('/'); if (vistas.has(k)) return false; vistas.add(k); return true; })
    .sort((a, b) => a.velocidadeMbps - b.velocidadeMbps).slice(0, 25);
}

const assinatura = (ofertas) => crypto.createHash('sha1').update(JSON.stringify(ofertas.map((o) => [o.velocidadeMbps, o.precos, o.streaming]))).digest('hex').slice(0, 12);

async function verificarOperadora(op) {
  const estado = store.load('monitor', {});
  const anterior = estado[op.id] || {};
  const agora = new Date().toISOString();
  try {
    const r = await fetch(op.siteOfertas, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; ConectaAquiMonitor/1.0)', accept: 'text/html' },
      signal: AbortSignal.timeout(20000), redirect: 'follow',
    });
    if (!r.ok) throw new Error(`site respondeu ${r.status}`);
    const ofertas = extrairOfertas(textoDaPagina(await r.text()));
    const hash = assinatura(ofertas);
    estado[op.id] = {
      url: op.siteOfertas, verificadoEm: agora, ok: true, erro: null, ofertas, hash,
      revisadoHash: anterior.revisadoHash || null,
      mudouEm: hash !== anterior.hash ? agora : anterior.mudouEm || agora,
      vazio: ofertas.length === 0,
    };
  } catch (e) {
    estado[op.id] = { ...anterior, url: op.siteOfertas, verificadoEm: agora, ok: false, erro: e.message };
  }
  store.save('monitor', estado);
  return estado[op.id];
}

async function verificarTodas() {
  const ops = store.load('operadoras', []).filter((o) => o.ativo && o.siteOfertas);
  for (const op of ops) await verificarOperadora(op); // uma por vez, sem pressa
  return store.load('monitor', {});
}

function marcarRevisado(id) {
  const estado = store.load('monitor', {});
  if (estado[id]) { estado[id].revisadoHash = estado[id].hash; store.save('monitor', estado); }
  return estado[id];
}

function iniciar() {
  setTimeout(() => verificarTodas().catch(() => {}), 30_000).unref();
  setInterval(() => verificarTodas().catch(() => {}), INTERVALO_MS).unref();
}

module.exports = { iniciar, verificarTodas, verificarOperadora, marcarRevisado, extrairOfertas, textoDaPagina };
