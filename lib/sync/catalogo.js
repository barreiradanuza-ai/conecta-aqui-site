// Catálogo sincronizado: junta os planos lidos dos sites das operadoras e guarda em DATA_DIR/catalogo.json.
//
// Regras:
// - Cada operadora é sincronizada separadamente. Se uma falhar, os planos dela da última leitura boa continuam valendo.
// - A Claro tem preço por cidade: o catálogo guarda uma região padrão (RJ / Rio de Janeiro) e, quando um CEP de outra
//   cidade é consultado, busca aquela cidade sob demanda e guarda também (até 6 horas).
// - A TIM tem tabela nacional (plans.json) e de São Paulo (sp.json).
// - Nio e Vivo têm preço único no site.
const store = require('../store');
const tim = require('./tim');
const claro = require('./claro');
const nio = require('./nio');
const vivo = require('./vivo');

const INTERVALO_MS = Number(process.env.SYNC_INTERVALO_MIN || 360) * 60 * 1000; // 6 horas
const VALIDADE_REGIAO_MS = 6 * 60 * 60 * 1000;
const MAX_REGIOES_CLARO = 60;

const SINCRONIZADORES = {
  tim: { padrao: () => tim.sincronizar('br'), regioes: { sp: () => tim.sincronizar('sp') } },
  claro: { padrao: () => claro.sincronizar(claro.REGIAO_PADRAO.uf, claro.REGIAO_PADRAO.cidade) },
  nio: { padrao: () => nio.sincronizar() },
  vivo: { padrao: () => vivo.sincronizar() },
};
const REGIAO_PADRAO_CLARO = claro.chaveRegiao(claro.REGIAO_PADRAO.uf, claro.REGIAO_PADRAO.cidade);

const vazio = () => ({ atualizadoEm: null, operadoras: {}, planos: [], regioesClaro: {} });
const carregar = () => ({ ...vazio(), ...store.load('catalogo', vazio()) });
const salvar = (c) => store.save('catalogo', c);

const marca = (planos, regiao) => planos.map((p) => ({ ...p, regiao }));

let rodando = null;

// Sincroniza uma operadora (região padrão) e devolve o resultado. Nunca lança: registra o erro no catálogo.
async function sincronizarOperadora(id) {
  const s = SINCRONIZADORES[id];
  const agora = new Date().toISOString();
  if (!s) return { ok: false, erro: 'operadora sem sincronizador' };
  const c = carregar();
  const anterior = c.operadoras[id] || {};
  try {
    const planos = await s.padrao();
    const regiao = id === 'claro' ? REGIAO_PADRAO_CLARO : id === 'tim' ? 'br' : null;
    const antes = c.planos.filter((p) => p.operadoraId === id && p.regiao === regiao).map((p) => p.id).sort().join(',');
    const depois = planos.map((p) => p.id).sort().join(',');
    c.planos = c.planos.filter((p) => !(p.operadoraId === id && p.regiao === regiao)).concat(marca(planos, regiao));
    c.operadoras[id] = { ok: true, erro: null, verificadoEm: agora, sucessoEm: agora, quantidade: planos.length, mudouEm: antes !== depois ? agora : anterior.mudouEm || agora, fonte: planos[0] && planos[0].fonte };
    if (id === 'claro') c.regioesClaro[REGIAO_PADRAO_CLARO] = agora;
  } catch (e) {
    c.operadoras[id] = { ...anterior, ok: false, erro: e.message, verificadoEm: agora, quantidade: c.planos.filter((p) => p.operadoraId === id).length };
    console.warn(new Date().toISOString(), `sincronização ${id} falhou:`, e.message);
  }
  c.atualizadoEm = agora;
  salvar(c);
  return c.operadoras[id];
}

async function sincronizarTudo() {
  if (rodando) return rodando;
  rodando = (async () => {
    const ativas = store.load('operadoras', []).filter((o) => o.ativo && SINCRONIZADORES[o.id]).map((o) => o.id);
    for (const id of ativas) await sincronizarOperadora(id); // uma de cada vez, sem pressa
    // a tabela de SP da TIM também é renovada junto
    if (ativas.includes('tim')) await sincronizarRegiao('tim', 'sp', SINCRONIZADORES.tim.regioes.sp).catch(() => {});
    return status();
  })().finally(() => { rodando = null; });
  return rodando;
}

// Lê uma região específica (TIM sp, Claro cidade) e guarda no catálogo. Lança em caso de erro.
async function sincronizarRegiao(id, regiao, fn) {
  const planos = await fn();
  const c = carregar();
  c.planos = c.planos.filter((p) => !(p.operadoraId === id && p.regiao === regiao)).concat(marca(planos, regiao));
  if (id === 'claro') {
    c.regioesClaro[regiao] = new Date().toISOString();
    // limita o número de cidades guardadas (as mais antigas saem, nunca a padrão)
    const chaves = Object.entries(c.regioesClaro).filter(([k]) => k !== REGIAO_PADRAO_CLARO).sort((a, b) => a[1].localeCompare(b[1]));
    while (chaves.length > MAX_REGIOES_CLARO) { const [k] = chaves.shift(); delete c.regioesClaro[k]; c.planos = c.planos.filter((p) => !(p.operadoraId === 'claro' && p.regiao === k)); }
  }
  salvar(c);
  return planos;
}

// Planos da Claro para a cidade do CEP. Busca sob demanda; se falhar, usa a região padrão.
const buscasClaro = new Map();
async function planosClaro(uf, cidade) {
  const c = carregar();
  const regiao = uf && cidade ? claro.chaveRegiao(uf, cidade) : REGIAO_PADRAO_CLARO;
  const emDia = c.regioesClaro[regiao] && Date.now() - Date.parse(c.regioesClaro[regiao]) < VALIDADE_REGIAO_MS;
  if (regiao !== REGIAO_PADRAO_CLARO && !emDia) {
    if (!buscasClaro.has(regiao)) buscasClaro.set(regiao, sincronizarRegiao('claro', regiao, () => claro.sincronizar(uf, cidade)).catch(() => null).finally(() => buscasClaro.delete(regiao)));
    const planos = await buscasClaro.get(regiao);
    if (planos && planos.length) return marca(planos, regiao);
    // registra que tentou (para não bater no site a cada CEP) e cai para a padrão
    const c2 = carregar(); c2.regioesClaro[regiao] = c2.regioesClaro[regiao] || new Date(Date.now() - VALIDADE_REGIAO_MS + 30 * 60_000).toISOString(); salvar(c2);
  }
  const daRegiao = c.planos.filter((p) => p.operadoraId === 'claro' && p.regiao === regiao);
  return daRegiao.length ? daRegiao : c.planos.filter((p) => p.operadoraId === 'claro' && p.regiao === REGIAO_PADRAO_CLARO);
}

// Lista final de planos para um endereço (uf/cidade opcionais). Sem endereço: vitrine (regiões padrão).
async function planosPara(endereco) {
  const c = carregar();
  const uf = endereco && String(endereco.uf || '').toUpperCase();
  const cidade = endereco && endereco.cidade;
  const regiaoTim = uf === 'SP' && c.planos.some((p) => p.operadoraId === 'tim' && p.regiao === 'sp') ? 'sp' : 'br';
  const fixos = c.planos.filter((p) => (p.operadoraId === 'tim' && p.regiao === regiaoTim) || (!['tim', 'claro'].includes(p.operadoraId)));
  const daClaro = uf && cidade ? await planosClaro(uf, cidade) : c.planos.filter((p) => p.operadoraId === 'claro' && p.regiao === REGIAO_PADRAO_CLARO);
  return fixos.concat(daClaro);
}

// Todos os planos conhecidos (todas as regiões), para o painel escolher destaques.
const todos = () => carregar().planos;

function status() {
  const c = carregar();
  return { atualizadoEm: c.atualizadoEm, operadoras: c.operadoras, total: c.planos.length, regioesClaro: Object.keys(c.regioesClaro), rodando: Boolean(rodando) };
}

function iniciar() {
  const c = carregar();
  const atraso = c.atualizadoEm && Date.now() - Date.parse(c.atualizadoEm) < INTERVALO_MS ? 5 * 60_000 : 15_000;
  setTimeout(() => sincronizarTudo().catch(() => {}), atraso).unref();
  setInterval(() => sincronizarTudo().catch(() => {}), INTERVALO_MS).unref();
}

module.exports = { sincronizarTudo, sincronizarOperadora, planosPara, todos, status, iniciar, REGIAO_PADRAO_CLARO, SINCRONIZADORES };
