// Funil de vendas a partir dos negócios do DataCrazy, por lead.
// Cada lead guarda: origem (google / meta / outros), o passo mais avançado que já atingiu
// e quando atingiu cada passo. Assim dá para calcular custo por venda, por instalação etc.
const store = require('./store');

const PASSOS = ['lead', 'qualificado', 'credito', 'venda', 'instalado', 'pago'];
const ROTULOS = { lead: 'Leads', qualificado: 'Endereço / plano', credito: 'Análise e compra', venda: 'Venda (pendente de instalação)', instalado: 'Instalado', pago: 'Pago' };
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// etapas do DataCrazy da Conecta Aqui → passo do funil (nomes normalizados). Ajustável em FUNIL_ETAPAS (JSON).
const PADRAO = {
  qualificado: ['end enviado', 'plano claro', 'plano nio', 'plano tim', 'parou na oferta'],
  credito: ['etapa 1 - analise de credito', 'auditoria', 'aguardando cpf', 'aguardando reversao operadora', 'parou na compra', 'imput claro', 'imput tim', 'imput nio', 'auditria/biometria', 'auditoria/biometria', 'sem contato', 'compra', 'biometria'],
  venda: ['pendente de instalacao', 'reagendar instalacao', 'data_instalacao'],
  instalado: ['instalado', 'm1', 'm2', 'm3', 'm4', 'pos-venda'],
  pago: ['pago'],
};
const FUNIS_PERDA = ['cancelamentos'];
// etapas em que o lead do disparo ainda NÃO respondeu
const ENTRADA_DISPARO = ['lead api', 'disparo', 'disparo 2', 'sem interacao template'];
// lead de disparo só conta como lead quando responde (sai das etapas de entrada)
function respondeu(l) {
  if (l.origem !== 'disparos') return true;
  if (l.respondeuEm || l.passo >= 1) return true;
  return Boolean(l.etapa && !ENTRADA_DISPARO.includes(norm(l.etapa)) && !(l.perdido && ENTRADA_DISPARO.includes(norm(l.perdido))));
}
const quandoRespondeu = (l) => (l.origem !== 'disparos' ? l.criado : l.respondeuEm || l.passos.qualificado || l.atualizado || l.criado);
const ETAPAS_PERDA = ['cpf_reprovado', 'bloquear_contato', 'blacklist'];

function mapaEtapas() {
  let extra = {};
  try { extra = JSON.parse(process.env.FUNIL_ETAPAS || '{}'); } catch { /* usa o padrão */ }
  const m = {};
  for (const [passo, nomes] of Object.entries({ ...PADRAO, ...extra })) for (const n of nomes) m[norm(n)] = passo;
  return m;
}
function classificar(etapa, funil) {
  const e = norm(etapa); const f = norm(funil);
  if (FUNIS_PERDA.includes(f) || ETAPAS_PERDA.includes(e)) return { passo: null, perdido: etapa || funil };
  return { passo: mapaEtapas()[e] || 'lead', perdido: null };
}
function origemDe(negocio, etapa, vinculado) {
  const tags = ((negocio.lead && negocio.lead.tags) || []).map((t) => norm(t.name || t));
  const e = norm(etapa);
  if (vinculado || tags.some((t) => t.includes('googleads') || t === 'google') || e === 'lead google') return 'google';
  if (tags.some((t) => /meta|facebook|instagram|^fb/.test(t)) || e === 'lead meta') return 'meta';
  // disparos pela API oficial do WhatsApp (tags "api_XXXX", etapa "Lead API" ou "DISPARO")
  if (tags.some((t) => /^api[_ -]?\d*$|^api_|disparo/.test(t)) || e === 'lead api' || e.startsWith('disparo')) return 'disparos';
  return 'outros';
}
const operadoraDe = (n) => {
  const nome = ((n.products || [])[0] || {}).product?.name || '';
  const p = norm(nome).split(' ')[0];
  return { claro: 'Claro', nio: 'Nio', tim: 'Tim', vivo: 'Vivo' }[p] || '';
};

// id da etapa → { nome, funil }
async function etapas(api, lista) {
  const c = store.load('funil-etapas', null);
  if (c && Date.now() - new Date(c.em).getTime() < 3600e3) return c.mapa;
  const mapa = {};
  for (const p of lista(await api('GET', '/api/v1/pipelines'))) {
    let es = p.stages;
    if (!Array.isArray(es)) { try { es = lista(await api('GET', `/api/v1/pipelines/${p.id}/stages`)); } catch { es = []; } }
    for (const e of es) mapa[e.id] = { nome: e.name, funil: p.name };
  }
  store.save('funil-etapas', { em: new Date().toISOString(), mapa });
  return mapa;
}

function registrar(leads, n, mapa, vinculos) {
  if (!n || !n.leadId) return;
  const info = mapa[n.stageId] || { nome: (n.stage && n.stage.name) || '', funil: '' };
  const { passo, perdido } = classificar(info.nome, info.funil);
  const quando = n.lastMovedAt || n.updatedAt || n.createdAt || new Date().toISOString();
  const l = leads[n.leadId] || { leadId: n.leadId, criado: n.createdAt || quando, origem: 'outros', passo: 0, passos: {} };
  if (n.createdAt && n.createdAt < l.criado) l.criado = n.createdAt;
  const v = vinculos[n.leadId];
  const origem = origemDe(n, info.nome, Boolean(v));
  // prioridade: google > meta > disparos > outros (o primeiro contato pago vence)
  const peso = { google: 3, meta: 2, disparos: 1, outros: 0 };
  if ((peso[origem] || 0) > (peso[l.origem] || 0)) l.origem = origem;
  if (v && v.ref) l.ref = v.ref;
  l.passos.lead = l.passos.lead && l.passos.lead < l.criado ? l.passos.lead : l.criado;
  if (perdido) { l.perdido = perdido; l.perdidoEm = quando; }
  else {
    if (n.status !== 'lost') { delete l.perdido; delete l.perdidoEm; }
    const idx = PASSOS.indexOf(passo);
    for (let i = 1; i <= idx; i++) if (!l.passos[PASSOS[i]]) l.passos[PASSOS[i]] = quando;
    if (idx > l.passo) l.passo = idx;
  }
  if (n.status === 'lost' && !l.perdido) { l.perdido = 'Perdido'; l.perdidoEm = quando; }
  l.etapa = info.nome; l.funil = info.funil;
  if (l.origem === 'disparos' && !l.respondeuEm && respondeu(l)) l.respondeuEm = quando;
  if (Number(n.total) > 0) l.valor = Number(n.total);
  const op = operadoraDe(n); if (op) l.operadora = op;
  l.atualizado = quando;
  leads[n.leadId] = l;
}

// Lê os negócios movidos desde a última leitura. Na primeira vez, volta FUNIL_DIAS dias (padrão 45),
// algumas páginas por ciclo para não estourar o limite da API.
async function sincronizar(api, lista, vinculos, paginasPorCiclo = 10) {
  const VERSAO = 2; // muda quando a classificação muda: relê o histórico para reclassificar
  let est = store.load('funil-estado', null);
  if (!est || est.versao !== VERSAO) est = { versao: VERSAO, desde: new Date(Date.now() - Number(process.env.FUNIL_DIAS || 45) * 864e5).toISOString(), skip: 0, max: null, completo: false };
  const mapa = await etapas(api, lista);
  const leads = store.load('funil-leads', {});
  let lidos = 0;
  try {
    for (let p = 0; p < paginasPorCiclo; p++) {
      const negs = lista(await api('GET', `/api/v1/businesses?take=100&skip=${est.skip}&filter[lastMovedAfter]=${encodeURIComponent(est.desde)}`));
      for (const n of negs) {
        registrar(leads, n, mapa, vinculos);
        const m = n.lastMovedAt || n.updatedAt || n.createdAt;
        if (m && (!est.max || m > est.max)) est.max = m;
      }
      lidos += negs.length;
      if (negs.length < 100) { // terminou esta passada
        est.desde = new Date(new Date(est.max || est.desde).getTime() - 15 * 60e3).toISOString();
        est.skip = 0; est.completo = true;
        break;
      }
      est.skip += 100;
    }
  } finally {
    // mantém 400 dias
    const limite = new Date(Date.now() - 400 * 864e5).toISOString();
    for (const [k, v] of Object.entries(leads)) if (v.criado < limite) delete leads[k];
    store.save('funil-leads', leads);
    store.save('funil-estado', { ...est, ultima: new Date().toISOString(), total: Object.keys(leads).length });
  }
  return { lidos, completo: est.completo };
}

const leads = () => Object.values(store.load('funil-leads', {}));
const status = () => store.load('funil-estado', null);

module.exports = { respondeu, quandoRespondeu, PASSOS, ROTULOS, classificar, origemDe, registrar, sincronizar, leads, status, norm, etapas };
