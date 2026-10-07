// Integração Google Ads ⇄ DataCrazy.
//
// 1) O site gera um código "G-XXXXX" para quem veio de anúncio do Google e coloca na mensagem do WhatsApp.
//    Guardamos código → gclid (rastreio.js).
// 2) A cada 5 min lemos as conversas recentes do DataCrazy, achamos o código e marcamos o lead com a tag
//    (DATACRAZY_TAG, padrão "googleads").
// 3) Quando o negócio desse lead entra na etapa de ganho (DATACRAZY_ETAPA_GANHO, padrão "Pendente de instalação"),
//    registramos uma conversão offline com o gclid. O Google Ads importa pelo arquivo /ads/conversoes/<token>.csv.
//
// Só lê e marca tags no DataCrazy. Nunca move negócios nem envia mensagens.
const store = require('./store');

const BASE = () => (process.env.DATACRAZY_URL || 'https://api.g1.datacrazy.io').replace(/\/$/, '');
const TOKEN = () => process.env.DATACRAZY_TOKEN || '';
const TAG = () => process.env.DATACRAZY_TAG || 'googleads';
const ETAPA = () => process.env.DATACRAZY_ETAPA_GANHO || 'Pendente de instalação';
const INTERVALO_MS = Number(process.env.DATACRAZY_INTERVALO_MIN || 5) * 60_000;
const REF = /\bG-([A-Z0-9]{5})\b/i;

const configurado = () => Boolean(TOKEN());
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const so = (s) => String(s || '').replace(/\D/g, '');

let estado = { rodando: false, ultima: null, erro: null, log: [] };
function registrar(msg) {
  estado.log.unshift(`${new Date().toISOString().slice(0, 19).replace('T', ' ')} ${msg}`);
  estado.log = estado.log.slice(0, 60);
}

// a API do DataCrazy limita a quantidade de chamadas: espaçamos e, se vier 429, paramos e continuamos no próximo ciclo
let ultimaChamada = 0;
const ESPACO_MS = Number(process.env.DATACRAZY_ESPACO_MS || 700);
class LimiteApi extends Error {}
async function api(metodo, caminho, corpo) {
  const espera = ultimaChamada + ESPACO_MS - Date.now();
  if (espera > 0) await new Promise((r) => setTimeout(r, espera));
  ultimaChamada = Date.now();
  const r = await fetch(BASE() + caminho, {
    method: metodo,
    headers: { authorization: `Bearer ${TOKEN()}`, 'access-token': TOKEN(), accept: 'application/json', ...(corpo ? { 'content-type': 'application/json' } : {}) },
    body: corpo ? JSON.stringify(corpo) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const texto = await r.text();
  let j; try { j = texto ? JSON.parse(texto) : {}; } catch { j = { texto: texto.slice(0, 300) }; }
  if (r.status === 429) throw new LimiteApi('limite de chamadas do DataCrazy atingido; continua no próximo ciclo');
  if (!r.ok) throw new Error(`DataCrazy ${r.status} em ${metodo} ${caminho.split('?')[0]}: ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}
const lista = (j) => (Array.isArray(j) ? j : j.data || j.items || j.results || []);

// procura um telefone (10 a 13 dígitos) dentro de um objeto qualquer
function acharTelefone(o, prof = 0) {
  if (!o || prof > 3) return '';
  if (typeof o === 'string' || typeof o === 'number') { const d = so(o); return d.length >= 10 && d.length <= 13 ? d : ''; }
  for (const k of ['phoneNumber', 'phone', 'rawPhone', 'number', 'whatsapp', 'telefone', 'externalId']) { const t = acharTelefone(o[k], prof + 1); if (t) return t; }
  if (typeof o === 'object') for (const v of Object.values(o)) { const t = typeof v === 'object' ? acharTelefone(v, prof + 1) : ''; if (t) return t; }
  return '';
}

// ---------- dados locais ----------
const vinculos = () => store.load('dc-vinculos', {}); // leadId -> { ref, gclid, gbraid, wbraid, telefone, em }
const conversoes = () => store.load('ads-conversoes', []); // { gclid, gbraid, wbraid, nome, hora, valor, leadId, negocioId, ref }

async function etapasGanho() {
  const alvo = norm(ETAPA());
  const ids = [];
  const pipes = lista(await api('GET', '/api/v1/pipelines'));
  for (const p of pipes) {
    let etapas = p.stages;
    if (!Array.isArray(etapas)) { try { etapas = lista(await api('GET', `/api/v1/pipelines/${p.id}/stages`)); } catch { etapas = []; } }
    for (const e of etapas) if (norm(e.name || e.nome) === alvo) ids.push(e.id);
  }
  return ids;
}

async function idDaTag() {
  const tags = lista(await api('GET', '/api/v1/tags?take=500'));
  const t = tags.find((x) => norm(x.name) === norm(TAG()));
  if (t) return t.id;
  const nova = await api('POST', '/api/v1/tags', { name: TAG() });
  return nova.id || (nova.data && nova.data.id);
}

async function acharLead(telefone) {
  const tel = so(telefone);
  const variantes = [tel, tel.replace(/^55/, '')];
  for (const v of variantes) {
    const ls = lista(await api('GET', `/api/v1/leads?search=${encodeURIComponent(v)}&take=10&complete=true`));
    const l = ls.find((x) => so(x.phone || x.rawPhone).endsWith(v.slice(-8))) || null;
    if (l) return l;
  }
  return null;
}

async function marcarLead(lead, tagId) {
  const atuais = (lead.tags || []).map((t) => t.id).filter(Boolean);
  if (atuais.includes(tagId)) return false;
  await api('PATCH', `/api/v1/leads/${lead.id}`, { tags: [...atuais, tagId].map((id) => ({ id })) });
  return true;
}

// ---------- etapas da sincronização ----------
async function lerConversas(rastreio, tagId) {
  const vinc = vinculos();
  const vistos = store.load('dc-conversas-vistas', {});
  let novos = 0;
  let leituras = 0;
  const MAX_LEITURAS = Number(process.env.DATACRAZY_MAX_CONVERSAS || 40);
  // na primeira vez olha as últimas 6 horas; depois, só o que chegou desde a última leitura (com folga)
  const desde = new Date(new Date(store.load('dc-ultima-conversa', null) || Date.now() - 6 * 3600e3).getTime() - 15 * 60e3).toISOString();
  let maisRecente = store.load('dc-ultima-conversa', null) || new Date(Date.now() - 6 * 3600e3).toISOString();
  const salvar = () => {
    const chaves = Object.keys(vistos); if (chaves.length > 5000) for (const k of chaves.slice(0, chaves.length - 5000)) delete vistos[k];
    store.save('dc-conversas-vistas', vistos); store.save('dc-vinculos', vinc); store.save('dc-ultima-conversa', maisRecente);
  };
  try {
  for (let pagina = 0; pagina < 4 && leituras < MAX_LEITURAS; pagina++) {
    const convs = lista(await api('GET', `/api/v1/conversations?take=50&skip=${pagina * 50}&filter[openWindow]=last24h`));
    if (!convs.length) break;
    let algumRecente = false;
    for (const c of convs) {
      const marca = c.lastReceivedMessageDate || c.lastMessageDate || c.createdAt;
      if (!marca || marca < desde) continue;
      algumRecente = true;
      if (vistos[c.id] && vistos[c.id] === marca) continue;
      if (leituras >= MAX_LEITURAS) break;
      leituras++;
      if (marca > maisRecente) maisRecente = marca;
      const msgs = lista(await api('GET', `/api/v1/conversations/${c.id}/messages?take=30`));
      vistos[c.id] = marca;
      const m = msgs.map((x) => (x.received === false ? '' : x.body || '')).join('\n').match(REF);
      if (!m) continue;
      const ref = 'G-' + m[1].toUpperCase();
      const clique = rastreio.buscar(ref);
      const telefone = acharTelefone(c.contact) || acharTelefone(c);
      if (!clique || !telefone) { registrar(`código ${ref} encontrado, mas ${!clique ? 'sem clique registrado' : 'sem telefone na conversa'}`); continue; }
      const lead = await acharLead(telefone);
      if (!lead) { delete vistos[c.id]; registrar(`código ${ref}: lead do telefone ainda não existe, tento de novo depois`); continue; }
      if (!vinc[lead.id]) { vinc[lead.id] = { ref, gclid: clique.gclid || '', gbraid: clique.gbraid || '', wbraid: clique.wbraid || '', telefone, em: new Date().toISOString() }; novos++; }
      if (await marcarLead(lead, tagId)) registrar(`lead ${lead.name || telefone} marcado com "${TAG()}" (${ref})`);
    }
    if (!algumRecente) break; // a lista vem das mais recentes para as mais antigas
  }
  } finally { salvar(); }
  return novos;
}

async function lerFormularios(rastreio, tagId) {
  // leads do formulário do site que vieram do Google: já temos o telefone
  const pend = rastreio.formulariosPendentes();
  const vinc = vinculos();
  for (const f of pend) {
    let lead = await acharLead(f.telefone);
    if (!lead) {
      const novo = await api('POST', '/api/v1/leads', { name: f.nome || 'Lead site', phone: '+' + (f.telefone.startsWith('55') ? f.telefone : '55' + f.telefone), source: 'Site Conecta Aqui', tags: [{ id: tagId }] });
      lead = novo.data || novo;
      registrar(`lead do formulário criado no DataCrazy: ${f.nome} (${f.ref})`);
    } else if (await marcarLead(lead, tagId)) registrar(`lead do formulário marcado com "${TAG()}": ${f.nome} (${f.ref})`);
    if (lead && lead.id && !vinc[lead.id]) vinc[lead.id] = { ref: f.ref, gclid: f.gclid || '', gbraid: f.gbraid || '', wbraid: f.wbraid || '', telefone: f.telefone, em: new Date().toISOString() };
    rastreio.formularioEnviado(f.id);
  }
  store.save('dc-vinculos', vinc);
}

async function lerNegocios(etapas) {
  if (!etapas.length) { registrar(`etapa "${ETAPA()}" não encontrada em nenhum funil`); return 0; }
  const vinc = vinculos();
  const conv = conversoes();
  const ja = new Set(conv.map((c) => c.negocioId));
  const desde = store.load('dc-ultimo-negocio', null) || new Date(Date.now() - 7 * 864e5).toISOString();
  let novas = 0;
  let maisRecente = desde;
  for (let pagina = 0; pagina < 10; pagina++) {
    const negs = lista(await api('GET', `/api/v1/businesses?take=100&skip=${pagina * 100}&filter[lastMovedAfter]=${encodeURIComponent(desde)}`));
    if (!negs.length) break;
    for (const n of negs) {
      const movido = n.lastMovedAt || n.statusChangedAt || n.createdAt;
      if (movido && movido > maisRecente) maisRecente = movido;
      if (!etapas.includes(n.stageId) || ja.has(n.id)) continue;
      const v = vinc[n.leadId];
      if (!v || !(v.gclid || v.gbraid || v.wbraid)) continue;
      conv.push({ gclid: v.gclid, gbraid: v.gbraid, wbraid: v.wbraid, ref: v.ref, leadId: n.leadId, negocioId: n.id, hora: movido || new Date().toISOString(), valor: Number(n.total) || 0, registradoEm: new Date().toISOString() });
      ja.add(n.id); novas++;
      registrar(`venda: negócio ${n.code || n.id} foi para "${ETAPA()}" (${v.ref}) → conversão para o Google Ads`);
    }
    if (negs.length < 100) break;
  }
  store.save('ads-conversoes', conv.slice(-5000));
  store.save('dc-ultimo-negocio', maisRecente);
  return novas;
}

async function sincronizar(rastreio) {
  if (!configurado()) return { erro: 'DATACRAZY_TOKEN não configurado' };
  if (estado.rodando) return estado;
  estado.rodando = true; estado.erro = null;
  try {
    const cache = store.load('dc-cache', {});
    if (!cache.em || Date.now() - new Date(cache.em).getTime() > 3600e3) { cache.tagId = await idDaTag(); cache.etapas = await etapasGanho(); cache.em = new Date().toISOString(); store.save('dc-cache', cache); }
    const { tagId, etapas } = cache;
    await lerConversas(rastreio, tagId);
    await lerFormularios(rastreio, tagId);
    await lerNegocios(etapas);
    estado.ultima = new Date().toISOString();
  } catch (e) {
    if (e instanceof LimiteApi) { registrar(e.message); estado.ultima = new Date().toISOString(); }
    else { estado.erro = e.message; registrar('erro: ' + e.message); }
  } finally { estado.rodando = false; }
  return estado;
}

// diagnóstico para o painel: mostra o que a API devolve, sem dados pessoais
async function diagnostico() {
  const out = { configurado: configurado(), base: BASE(), tag: TAG(), etapa: ETAPA() };
  if (!configurado()) return out;
  try {
    const pipes = lista(await api('GET', '/api/v1/pipelines'));
    out.funis = [];
    for (const p of pipes) {
      let etapas = p.stages;
      if (!Array.isArray(etapas)) { try { etapas = lista(await api('GET', `/api/v1/pipelines/${p.id}/stages`)); } catch (e) { etapas = []; } }
      out.funis.push({ nome: p.name, etapas: etapas.map((e) => e.name) });
    }
    out.etapaEncontrada = (await etapasGanho()).length > 0;
    const tags = lista(await api('GET', '/api/v1/tags?take=500'));
    out.tagExiste = tags.some((t) => norm(t.name) === norm(TAG()));
    const convs = await api('GET', '/api/v1/conversations?take=1&filter[openWindow]=last24h');
    const c = lista(convs)[0];
    out.conversaCampos = c ? Object.keys(c) : [];
    out.contatoCampos = c && c.contact ? Object.keys(c.contact) : [];
    out.temTelefoneNaConversa = Boolean(c && (acharTelefone(c.contact) || acharTelefone(c)));
  } catch (e) { out.erro = e.message; }
  return out;
}

function iniciar(rastreio) {
  if (!configurado()) return;
  setTimeout(() => sincronizar(rastreio).catch(() => {}), 20_000).unref();
  setInterval(() => sincronizar(rastreio).catch(() => {}), INTERVALO_MS).unref();
}

// arquivo para o Google Ads importar (Uploads programados por HTTPS)
function csvConversoes() {
  const nome = process.env.ADS_CONVERSAO_VENDA_NOME || 'Venda - Pendente de instalação';
  const limite = Date.now() - 88 * 864e5; // o Google aceita cliques de até 90 dias
  // horário de Brasília com o fuso na própria data (o Gestor de dados do Google não aceita a linha "Parameters:")
  const fmt = (iso) => new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') + '-03:00';
  const linhas = conversoes().filter((c) => c.gclid && new Date(c.hora).getTime() > limite)
    .map((c) => [c.gclid, nome, fmt(c.hora), c.valor ? c.valor.toFixed(2) : '1.00', 'BRL'].join(','));
  // O Google exige pelo menos uma linha para reconhecer o arquivo. Sem vendas ainda, vai uma linha de exemplo
  // com um código de clique inválido: o Google a recusa na importação e nenhuma conversão é criada.
  if (!linhas.length) linhas.push(['EXEMPLO-SEM-VENDAS-IGNORAR', nome, fmt(new Date().toISOString()), '1.00', 'BRL'].join(','));
  return ['Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency', ...linhas].join('\r\n') + '\r\n';
}

const status = () => ({ configurado: configurado(), tag: TAG(), etapa: ETAPA(), ...estado, vinculos: Object.keys(vinculos()).length, conversoes: conversoes().slice(-30).reverse().map((c) => ({ ref: c.ref, hora: c.hora, valor: c.valor, temGclid: Boolean(c.gclid) })) });

module.exports = { sincronizar, iniciar, diagnostico, csvConversoes, status, configurado, REF };
