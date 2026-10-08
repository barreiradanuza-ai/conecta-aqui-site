// Gasto dos anúncios por dia e por campanha.
//  - Google: um script dentro da conta do Google Ads envia os números para /ads/gasto/google/<ADS_FEED_TOKEN>
//    (de hora em hora). Não precisa de token de desenvolvedor.
//  - Meta: o servidor lê a Marketing API com META_TOKEN nas contas META_CONTAS (ids separados por vírgula).
// Guarda em DATA_DIR/trafego-gasto.json: { "<canal>|<campanhaId>|<data>": { ... } }
const store = require('./store');

const CHAVE = 'trafego-gasto';
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const txt = (v, n = 160) => String(v ?? '').slice(0, n);
const dataOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d));

let estado = { google: { ultima: null, linhas: 0, erro: null }, meta: { ultima: null, linhas: 0, erro: null, rodando: false } };
const salvarEstado = () => store.save('trafego-gasto-estado', estado);
try { estado = { ...estado, ...store.load('trafego-gasto-estado', {}) }; estado.meta.rodando = false; } catch { /* primeira vez */ }

function gravar(canal, linhas) {
  const mapa = store.load(CHAVE, {});
  let n = 0;
  for (const l of linhas) {
    if (!dataOk(l.data) || !l.campanhaId) continue;
    const chave = `${canal}|${l.campanhaId}|${l.data}`;
    mapa[chave] = { ...(mapa[chave] || {}),
      canal, data: l.data, conta: txt(l.conta, 40), campanhaId: txt(l.campanhaId, 40), campanha: txt(l.campanha),
      status: txt(l.status, 20), gasto: Math.round(num(l.gasto) * 100) / 100, impressoes: Math.round(num(l.impressoes)),
      cliques: Math.round(num(l.cliques)), conversoes: Math.round(num(l.conversoes) * 100) / 100,
    };
    n++;
  }
  // guarda 400 dias
  const limite = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(mapa)) if (v.data < limite) delete mapa[k];
  store.save(CHAVE, mapa);
  return n;
}

// ---------- Google (recebido do script) ----------
function receberGoogle(corpo) {
  const linhas = Array.isArray(corpo && corpo.linhas) ? corpo.linhas.slice(0, 20000) : null;
  if (!linhas) throw Object.assign(new Error('formato inválido: esperado { linhas: [...] }'), { status: 400 });
  const n = gravar('google', linhas.map((l) => ({ ...l, campanhaId: String(l.campanhaId || '') })));
  // termos de pesquisa (últimos 30 dias), se o script mandar
  if (Array.isArray(corpo.termos)) {
    store.save('trafego-termos-google', { em: new Date().toISOString(), termos: corpo.termos.slice(0, 3000).map((t) => ({ termo: txt(t.termo, 120), campanha: txt(t.campanha), grupo: txt(t.grupo), gasto: num(t.gasto), cliques: Math.round(num(t.cliques)), conversoes: num(t.conversoes) })) });
  }
  // parcela de impressões por campanha e dia (vai junto da linha de gasto)
  if (Array.isArray(corpo.parcela) && corpo.parcela.length) {
    const mapa = store.load(CHAVE, {});
    const fr = (v) => Math.max(0, Math.min(1, num(v)));
    for (const p of corpo.parcela.slice(0, 20000)) {
      const l = mapa[`google|${String(p.campanhaId || '')}|${p.data}`];
      if (!l) continue;
      Object.assign(l, { impBusca: Math.round(num(p.impressoes)), parcela: fr(p.parcela), perdidaOrcamento: fr(p.perdidaOrcamento), perdidaRanking: fr(p.perdidaRanking), topo: fr(p.topo), topoAbsoluto: fr(p.topoAbsoluto) });
    }
    store.save(CHAVE, mapa);
  }
  if (Array.isArray(corpo.palavras)) {
    store.save('trafego-palavras-google', { em: new Date().toISOString(), palavras: corpo.palavras.slice(0, 5000).map((k) => ({
      id: txt(k.id, 30), palavra: txt(k.palavra, 120), tipo: txt(k.tipo, 12), status: txt(k.status, 12), qualidade: Math.round(num(k.qualidade)), campanha: txt(k.campanha), grupo: txt(k.grupo),
      gasto: num(k.gasto), impressoes: Math.round(num(k.impressoes)), cliques: Math.round(num(k.cliques)), conversoes: num(k.conversoes), parcela: num(k.parcela), perdidaRanking: num(k.perdidaRanking), topoAbsoluto: num(k.topoAbsoluto),
    })) });
  }
  if (Array.isArray(corpo.cidades)) {
    store.save('trafego-cidades-google', { em: new Date().toISOString(), cidades: corpo.cidades.slice(0, 5000).map((c) => ({
      id: txt(c.id, 20), nome: txt(c.nome || c.id, 120), gasto: num(c.gasto), impressoes: Math.round(num(c.impressoes)), cliques: Math.round(num(c.cliques)), conversoes: num(c.conversoes),
    })) });
  }
  estado.google = { ultima: new Date().toISOString(), linhas: n, erro: null, conta: txt(corpo.conta, 40), versao: Number(corpo.versao) || 1 };
  salvarEstado();
  return { ok: true, linhas: n };
}

// ---------- Meta: anúncios + custo da API oficial do WhatsApp (lido pela Graph API) ----------
// Um token por BM: META_TOKEN, META_TOKEN_2 … META_TOKEN_6 (usuário do sistema com ads_read,
// business_management e whatsapp_business_management). As contas de anúncio e as contas do WhatsApp
// de cada BM são descobertas sozinhas. META_CONTAS e WHATSAPP_WABAS (ids separados por vírgula) são opcionais.
const META_VERSAO = () => process.env.META_API_VERSION || 'v23.0';
const GRAPH = () => `${(process.env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '')}/${META_VERSAO()}`;
const lista_ = (v) => String(v || '').split(',').map((s) => s.trim().replace(/^act_/, '')).filter(Boolean);
const metaContas = () => lista_(process.env.META_CONTAS);
const metaTokens = () => ['', '_2', '_3', '_4', '_5', '_6'].map((k) => process.env['META_TOKEN' + k]).filter(Boolean);
const metaConfigurado = () => metaTokens().length > 0;
// conversas iniciadas no WhatsApp / leads, conforme o objetivo da campanha
const ACOES_LEAD = ['onsite_conversion.messaging_conversation_started_7d', 'lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const CATEGORIA = { MARKETING: 'Marketing', UTILITY: 'Utilidade', AUTHENTICATION: 'Autenticação', SERVICE: 'Serviço', REFERRAL_CONVERSION: 'Vindas de anúncio', MARKETING_LITE: 'Marketing' };

async function graph(caminho, token, params = {}) {
  const url = caminho.startsWith('http') ? caminho : `${GRAPH()}/${caminho}?${new URLSearchParams({ ...params, access_token: token })}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  return j;
}
async function todasPaginas(caminho, token, params) {
  const out = []; let j = await graph(caminho, token, params);
  for (let p = 0; p < 20; p++) { out.push(...(j.data || [])); if (!(j.paging && j.paging.next)) break; j = await graph(j.paging.next, token); }
  return out;
}

// descobre o que cada token enxerga (cache de 6 h)
async function descobrir(erros) {
  const cache = store.load('meta-descoberta', null);
  const chaveTokens = metaTokens().map((t) => t.slice(-6)).join(',');
  if (cache && cache.tokens === chaveTokens && Date.now() - new Date(cache.em).getTime() < 6 * 3600e3) return cache;
  const contas = {}; const wabas = {};
  for (const [i, token] of metaTokens().entries()) {
    try { for (const a of await todasPaginas('me/adaccounts', token, { fields: 'account_id,name', limit: '200' })) if (!contas[a.account_id]) contas[a.account_id] = { id: a.account_id, nome: a.name, token: i }; }
    catch (e) { erros.push(`token ${i + 1} (contas de anúncio): ${e.message}`.slice(0, 200)); }
    try {
      for (const bm of await todasPaginas('me/businesses', token, { fields: 'id,name', limit: '100' })) {
        for (const tipo of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
          try { for (const w of await todasPaginas(`${bm.id}/${tipo}`, token, { fields: 'id,name,currency', limit: '100' })) if (!wabas[w.id]) wabas[w.id] = { id: w.id, nome: w.name, moeda: w.currency || '', bm: bm.name, token: i }; } catch { /* sem permissão para este tipo */ }
        }
      }
    } catch (e) { erros.push(`token ${i + 1} (WhatsApp): ${e.message}`.slice(0, 200)); }
  }
  // ids informados à mão: usa o primeiro token que conseguir ler
  for (const id of metaContas()) if (!contas[id]) contas[id] = { id, nome: id, token: null };
  for (const id of lista_(process.env.WHATSAPP_WABAS)) if (!wabas[id]) wabas[id] = { id, nome: id, moeda: '', token: null };
  const res = { em: new Date().toISOString(), tokens: chaveTokens, contas: Object.values(contas), wabas: Object.values(wabas) };
  store.save('meta-descoberta', res);
  return res;
}
async function comToken(item, f) {
  const toks = metaTokens();
  const ordem = item.token != null ? [item.token, ...toks.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...toks.keys()];
  let ultimo;
  for (const i of ordem) { try { return await f(toks[i]); } catch (e) { ultimo = e; } }
  throw ultimo || new Error('nenhum token');
}

async function insightsConta(conta, token, de, ate) {
  const out = [];
  for (const x of await todasPaginas(`act_${conta.id}/insights`, token, { level: 'campaign', time_increment: '1', limit: '500', fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions', time_range: JSON.stringify({ since: de, until: ate }) })) {
    const conv = (x.actions || []).filter((a) => ACOES_LEAD.includes(a.action_type)).reduce((s, a) => Math.max(s, num(a.value)), 0);
    out.push({ data: x.date_start, conta: conta.id, campanhaId: x.campaign_id, campanha: x.campaign_name, gasto: x.spend, impressoes: x.impressions, cliques: x.clicks, conversoes: conv });
  }
  return out;
}

// custo da API oficial do WhatsApp por dia e categoria (cobrança por mensagem; cai para conversas nas contas antigas)
async function custoWhatsApp(waba, token, de, ate) {
  const ini = Math.floor(Date.parse(de + 'T03:00:00Z') / 1000); const fim = Math.floor(Date.parse(ate + 'T03:00:00Z') / 1000) + 86400;
  const cambio = waba.moeda && waba.moeda !== 'BRL' ? num(process.env.CAMBIO_USD || 5.5) : 1;
  const porDia = {};
  const somar = (pts, chaveCat, chaveVol) => {
    for (const p of pts || []) {
      const d = new Date((num(p.start) - 3 * 3600) * 1000).toISOString().slice(0, 10);
      const cat = CATEGORIA[p[chaveCat]] || p[chaveCat] || 'Mensagens';
      const k = d + '|' + cat;
      const x = porDia[k] || (porDia[k] = { data: d, conta: waba.id, campanhaId: `wa-${waba.id}-${cat}`, campanha: `WhatsApp API · ${waba.nome || waba.id} · ${cat}`, gasto: 0, impressoes: 0, cliques: 0, conversoes: 0 });
      x.gasto += num(p.cost) * cambio; x.impressoes += num(p[chaveVol]);
    }
  };
  try {
    const j = await graph(waba.id, token, { fields: `pricing_analytics.start(${ini}).end(${fim}).granularity(DAILY).dimensions(["PRICING_CATEGORY"])` });
    for (const bloco of (j.pricing_analytics && j.pricing_analytics.data) || []) somar(bloco.data_points, 'pricing_category', 'volume');
  } catch (e) {
    const j = await graph(waba.id, token, { fields: `conversation_analytics.start(${ini}).end(${fim}).granularity(DAILY).dimensions(["CONVERSATION_CATEGORY"])` });
    for (const bloco of (j.conversation_analytics && j.conversation_analytics.data) || []) somar(bloco.data_points, 'conversation_category', 'conversation');
  }
  return Object.values(porDia);
}

async function lerMeta(dias = null) {
  if (!metaConfigurado()) return { erro: 'META_TOKEN não configurado' };
  if (estado.meta.rodando) return estado.meta;
  estado.meta.rodando = true;
  const jaTem = Object.values(store.load(CHAVE, {})).some((v) => v.canal === 'meta' || v.canal === 'disparos');
  const periodo = dias || (jaTem ? 7 : 90);
  const ate = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const de = new Date(Date.now() - 3 * 3600e3 - (periodo - 1) * 864e5).toISOString().slice(0, 10);
  const erros = [];
  try {
    const d = await descobrir(erros);
    const anuncios = []; const disparos = [];
    const filtro = metaContas();
    for (const conta of d.contas) {
      if (filtro.length && !filtro.includes(conta.id)) continue; // META_CONTAS limita às contas da Conecta Aqui
      try { anuncios.push(...(await comToken(conta, (t) => insightsConta(conta, t, de, ate)))); } catch (e) { erros.push(`conta ${conta.id}: ${e.message}`.slice(0, 200)); }
    }
    for (const w of d.wabas) {
      try { disparos.push(...(await comToken(w, (t) => custoWhatsApp(w, t, de, ate)))); } catch (e) { erros.push(`WhatsApp ${w.nome || w.id}: ${e.message}`.slice(0, 200)); }
    }
    const n = gravar('meta', anuncios) + gravar('disparos', disparos);
    estado.meta = { ultima: new Date().toISOString(), linhas: n, erro: erros.length ? erros.join(' · ') : null, rodando: false,
      contasLidas: d.contas.filter((c) => !filtro.length || filtro.includes(c.id)).map((c) => `${c.nome} (${c.id})`), wabas: d.wabas.map((w) => `${w.nome || w.id}${w.moeda && w.moeda !== 'BRL' ? ` [${w.moeda}]` : ''}`) };
  } catch (e) {
    estado.meta = { ...estado.meta, erro: e.message, rodando: false };
  } finally { estado.meta.rodando = false; salvarEstado(); }
  return estado.meta;
}

function iniciar() {
  if (!metaConfigurado()) return;
  setTimeout(() => lerMeta().catch(() => {}), 30_000).unref();
  setInterval(() => lerMeta().catch(() => {}), 60 * 60_000).unref();
}

const linhas = () => Object.values(store.load(CHAVE, {}));
const termosGoogle = () => store.load('trafego-termos-google', null);
const palavrasGoogle = () => store.load('trafego-palavras-google', null);
const cidadesGoogle = () => store.load('trafego-cidades-google', null);
const status = () => ({ google: estado.google, meta: { ...estado.meta, configurado: metaConfigurado(), tokens: metaTokens().length, contas: estado.meta.contasLidas || metaContas(), wabas: estado.meta.wabas || [] } });

module.exports = { receberGoogle, lerMeta, iniciar, linhas, termosGoogle, palavrasGoogle, cidadesGoogle, status, gravar };
