// Utilidades compartilhadas pelos sincronizadores de cada operadora.
const crypto = require('node:crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 ConectaAqui/2.0';

async function baixar(url, { tipo = 'text', timeoutMs = 25000, headers = {} } = {}) {
  const r = await fetch(url, {
    headers: { 'user-agent': UA, accept: tipo === 'json' ? 'application/json, text/plain, */*' : 'text/html,application/xhtml+xml', 'accept-language': 'pt-BR,pt;q=0.9', ...headers },
    signal: AbortSignal.timeout(timeoutMs), redirect: 'follow',
  });
  if (!r.ok) throw new Error(`${new URL(url).host} respondeu ${r.status}`);
  return tipo === 'json' ? r.json() : r.text();
}

// "600 Mega" / "1 Giga" / "1000 Mbps" / "ATÉ 5 Gbps" -> Mbps
function paraMbps(texto) {
  const m = String(texto || '').replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(giga|gb|gbps|mega|mb|mbps)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(/^g/i.test(m[2]) ? n * 1000 : n);
}

// "R$ 110/mês", "R$ 89,99", "1.299,90" -> número; centavos (8990) -> 89.9 via paraReais
const paraNumero = (t) => {
  const m = String(t ?? '').match(/\d[\d.,]*/);
  if (!m) return null;
  let s = m[0].replace(/[.,]$/, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // 1.299,90
  else if (/^\d+\.\d{3}(\.\d{3})*$/.test(s)) s = s.replace(/\./g, ''); // 1.299 (milhar)
  const n = Number(s); // 129.99 fica como decimal
  return Number.isFinite(n) ? n : null;
};
const arred = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100);
const centavos = (c) => (c === null || c === undefined ? null : Math.round(Number(c)) / 100);

const texto = (html) => String(html || '')
  .replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();

// Nomes de streaming usados no site -> ids do store.STREAMING
const STREAM_IDS = [
  [/globoplay/i, 'globoplay'], [/paramount/i, 'paramount'], [/\bmax\b|hbo/i, 'max'], [/netflix/i, 'netflix'],
  [/youtube/i, 'youtube'], [/disney/i, 'disney'], [/prime/i, 'prime'], [/deezer/i, 'deezer'], [/apple/i, 'apple'],
];
const streamingDe = (nomes) => [...new Set((nomes || []).map((n) => (STREAM_IDS.find(([re]) => re.test(String(n))) || [])[1]).filter(Boolean))];

// id estável por operadora + chave natural (sku, id do catálogo...), para o painel guardar destaques entre sincronizações
const idEstavel = (operadoraId, chave) => crypto.createHash('sha1').update(`${operadoraId}|${chave}`).digest('hex').slice(0, 12);

// remove planos repetidos (mesmo id ou mesmo nome+velocidade+preço), mantendo o primeiro
function unicos(lista) {
  const ids = new Set(), chaves = new Set();
  return lista.filter((p) => {
    const k = `${p.nome}|${p.velocidadeMbps}|${p.preco}|${p.precoPromo}`;
    if (ids.has(p.id) || chaves.has(k)) return false;
    ids.add(p.id); chaves.add(k); return true;
  });
}

const mbpsTexto = (mbps) => (mbps >= 1000 ? `${(mbps / 1000).toLocaleString('pt-BR')} Giga` : `${mbps} Mega`);

// Monta o plano no formato que o site usa. Campos faltantes viram null/[]
function plano(operadoraId, chave, dados) {
  return {
    id: idEstavel(operadoraId, chave),
    operadoraId,
    origemId: String(chave),
    nome: String(dados.nome || '').trim().slice(0, 100),
    tipo: dados.tipo || 'internet',
    velocidadeMbps: dados.velocidadeMbps ?? null,
    uploadMbps: dados.uploadMbps ?? null,
    preco: arred(dados.preco),
    precoPromo: arred(dados.precoPromo),
    mesesPromo: dados.mesesPromo ?? null,
    beneficios: (dados.beneficios || []).map((b) => String(b).trim()).filter(Boolean).filter((b, i, a) => a.indexOf(b) === i).slice(0, 8),
    streaming: dados.streaming || [],
    mesesStreaming: dados.mesesStreaming ?? null,
    selo: dados.selo || '',
    linkContratacao: /^https:\/\//.test(dados.linkContratacao || '') ? dados.linkContratacao : '',
    fonte: dados.fonte || '',
  };
}

module.exports = { baixar, paraMbps, paraNumero, centavos, texto, streamingDe, idEstavel, mbpsTexto, plano, unicos, UA };
