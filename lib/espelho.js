// Espelho local das listas do MCC (CEPs Claro/Nio/TIM e cidades promocionais).
//
// Em vez de consultar o MCC a cada CEP digitado (4 chamadas por busca, sujeitas ao limite da borda),
// o site baixa a exportação CSV de cada lista inteira a cada 6 horas e responde na hora, em memória.
// Fica guardado em DATA_DIR/mcc-listas.json para sobreviver a reinícios. Enquanto uma lista ainda não
// foi baixada (ou a última cópia é muito antiga), a cobertura consulta o MCC do jeito antigo.
const fs = require('node:fs');
const path = require('node:path');
const store = require('./store');
const mcc = require('./mcc');

const LISTAS = ['ceps-claro', 'ceps-nio', 'ceps-tim', 'cidades-promo-claro'];
const INTERVALO_MS = Number(process.env.ESPELHO_INTERVALO_MIN || 360) * 60_000;
const VALIDADE_MS = 3 * 24 * 60 * 60_000; // cópia com mais de 3 dias deixa de valer
const ARQ = path.join(store.DATA_DIR, 'mcc-listas.json');

const conjuntos = new Map(); // lista -> Set
let meta = { atualizadoEm: {}, erro: {}, tamanhos: {} };
let rodando = null;

function carregarDoDisco() {
  try {
    const j = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
    for (const l of LISTAS) if (Array.isArray(j.listas?.[l])) conjuntos.set(l, new Set(j.listas[l]));
    meta = { ...meta, ...(j.meta || {}) };
  } catch { /* primeira vez */ }
}
function salvarNoDisco() {
  const listas = {}; for (const [l, s] of conjuntos) listas[l] = [...s];
  const tmp = ARQ + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ meta, listas })); fs.renameSync(tmp, ARQ);
}

const emDia = (lista) => conjuntos.has(lista) && meta.atualizadoEm[lista] && Date.now() - Date.parse(meta.atualizadoEm[lista]) < VALIDADE_MS;

// true/false quando o espelho tem a lista; null quando ainda não tem (quem chama consulta o MCC)
function existe(lista, valor) {
  if (!emDia(lista)) return null;
  const v = String(valor).trim().toUpperCase();
  return conjuntos.get(lista).has(v);
}

async function atualizarLista(lista) {
  const agora = new Date().toISOString();
  try {
    const valores = await mcc.baixarLista(lista);
    if (!valores.length && conjuntos.get(lista)?.size) throw new Error('exportação veio vazia; mantida a cópia anterior');
    conjuntos.set(lista, new Set(valores));
    meta.atualizadoEm[lista] = agora; meta.tamanhos[lista] = valores.length; delete meta.erro[lista];
  } catch (e) {
    meta.erro[lista] = `${agora} ${e.message}`;
    console.warn(agora, `espelho ${lista} falhou:`, e.message);
  }
}

async function atualizar() {
  if (!mcc.configurado()) return status();
  if (rodando) return rodando;
  rodando = (async () => {
    for (const l of LISTAS) await atualizarLista(l);
    try { salvarNoDisco(); } catch (e) { console.warn('espelho: não salvou em disco:', e.message); }
    return status();
  })().finally(() => { rodando = null; });
  return rodando;
}

function status() {
  return { listas: Object.fromEntries(LISTAS.map((l) => [l, { emDia: emDia(l), registros: conjuntos.get(l)?.size || 0, atualizadoEm: meta.atualizadoEm[l] || null, erro: meta.erro[l] || null }])), rodando: Boolean(rodando) };
}

function iniciar() {
  carregarDoDisco();
  const maisAntiga = Math.min(...LISTAS.map((l) => Date.parse(meta.atualizadoEm[l] || 0)));
  const atraso = Number.isFinite(maisAntiga) && Date.now() - maisAntiga < INTERVALO_MS ? INTERVALO_MS - (Date.now() - maisAntiga) : 5_000;
  setTimeout(() => { atualizar().catch(() => {}); setInterval(() => atualizar().catch(() => {}), INTERVALO_MS).unref(); }, atraso).unref();
}

module.exports = { existe, atualizar, status, iniciar, LISTAS, carregarDoDisco };
