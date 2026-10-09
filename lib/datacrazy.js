// Integração Google Ads ⇄ DataCrazy.
//
// 1) O site gera um código "G-XXXXX" para quem veio de anúncio do Google e coloca na mensagem do WhatsApp.
//    Guardamos código → gclid (rastreio.js).
// 2) A cada 5 min lemos as conversas recentes do DataCrazy, achamos o código e marcamos o lead com a tag
//    (DATACRAZY_TAG, padrão "googleads").
// 3) Quando o negócio desse lead entra na etapa de ganho (DATACRAZY_ETAPA_GANHO, padrão "Pendente de instalação"),
//    registramos uma conversão offline com o gclid. O Google Ads importa pelo arquivo /ads/conversoes/<token>.csv.
//
// 4) Preenche o endereço no lead e, no negócio do lead, os campos "Operadora escolhida" (Claro / Nio / Tim) e "Plano",
//    e coloca o produto do catálogo que corresponde ao plano (cria o produto se não existir).
//
// Nunca move negócios nem envia mensagens.
const store = require('./store');

const BASE = () => (process.env.DATACRAZY_URL || 'https://api.g1.datacrazy.io').replace(/\/$/, '');
const TOKEN = () => process.env.DATACRAZY_TOKEN || '';
const TAG = () => process.env.DATACRAZY_TAG || 'googleads';
const ETAPA = () => process.env.DATACRAZY_ETAPA_GANHO || 'Pendente de instalação';
const INTERVALO_MS = Number(process.env.DATACRAZY_INTERVALO_MIN || 2) * 60_000;
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
  const r = await fetch(/^https?:/.test(caminho) ? caminho : BASE() + caminho, {
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

// Telefone do CLIENTE de uma conversa. Pela documentação do DataCrazy o contato não tem campo "phone":
// o número vem em contact.contactId (às vezes externalId, ex.: "5511999999999@s.whatsapp.net").
// Nunca olha dentro de "instance": lá está o número da PRÓPRIA empresa, que achava o lead errado (ou nenhum).
function telefoneDaConversa(c, msgs = []) {
  const ct = (c && c.contact) || {};
  const cands = [ct.contactId, ct.phoneNumber, ct.phone, ct.rawPhone, ct.number, ct.externalId];
  for (const m of msgs) if (m && m.contact && m.received !== false) cands.push(m.contact.contactId, m.contact.phone, m.contact.phoneNumber, m.contact.externalId);
  for (const x of cands) {
    if (x == null) continue;
    const d = so(String(x).split('@')[0]);
    if (d.length >= 10 && d.length <= 13) return d.length <= 11 ? '55' + d : d;
  }
  return '';
}

// contadores do último dia, sem dados pessoais (aparecem no painel e no relatório da IA)
function contar(chave, n = 1) {
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const c = store.load('dc-contadores', {});
  if (c.dia !== hoje) { for (const k of Object.keys(c)) delete c[k]; c.dia = hoje; }
  c[chave] = (c[chave] || 0) + n;
  store.save('dc-contadores', c);
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

// ---------- negócio: campos "Operadora escolhida" e "Plano" + produto ----------
// Formato confirmado na tela do DataCrazy (08/10/2026):
//  - campos do NEGÓCIO: PUT /additional-fields/business/{negocio}/{campo}  { value }
//  - produtos do negócio: PATCH /businesses/{negocio}  { products: [{ product: {...}, quantity, price, total }] }
// DATACRAZY_CAMPOS troca o mapa {"Nome do campo do negócio":"chave"}; chaves: plano, operadora, valor, cep, endereco, numero, bairro, cidade, uf, ref, origem
// Os de endereço só são usados se o negócio tiver um campo com esse nome (senão são ignorados).
const CAMPOS_PADRAO = {
  'Operadora escolhida': 'operadora', Plano: 'plano',
  'Endereço': 'enderecoCompleto', 'Endereço completo': 'enderecoCompleto', CEP: 'cep', 'Número': 'numero', Bairro: 'bairro', Cidade: 'cidade', UF: 'uf', Estado: 'uf',
};
// ids conhecidos na conta da Conecta Aqui (usados se a lista de campos não vier pela API)
const IDS_CONHECIDOS = { 'operadora escolhida': '8a0c740e-7037-4854-b4a5-d81abd233ceb', plano: 'eba71c38-004c-44c1-b85f-70b4d0b8dfcf' };
function mapaCampos() {
  try { const m = JSON.parse(process.env.DATACRAZY_CAMPOS || 'null'); if (m && typeof m === 'object' && Object.keys(m).length) return m; } catch { /* usa o padrão */ }
  return CAMPOS_PADRAO;
}
function nomeOperadora(o) {
  const n = norm(o);
  if (n.includes('claro')) return 'Claro';
  if (/\bnio\b/.test(n)) return 'Nio';
  if (/\btim\b/.test(n)) return 'Tim';
  return String(o || '').trim();
}
function lerOpcoes(o) {
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = o.split(/[,;\n]/); } }
  if (!Array.isArray(o)) return [];
  return o.map((x) => (typeof x === 'string' ? { label: x.trim() } : { label: String(x.label || x.name || x.value || '').trim() })).filter((x) => x.label);
}
function valorParaCampo(campo, valor) {
  const v = String(valor);
  if (!campo.opcoes || !campo.opcoes.length) return v;
  const op = campo.opcoes.find((o) => norm(o.label) === norm(v)) || campo.opcoes.find((o) => norm(v).includes(norm(o.label)) || norm(o.label).includes(norm(v)));
  return op ? op.label : v;
}
// A API pública não grava campos do negócio (/api/v1/additional-fields/business dá 404 e o PATCH ignora).
// A rota da própria tela do DataCrazy aceita o token da API: PUT {crm}/api/crm/additional-fields/business/{negócio}/{campo} { value }.
// Confirmado no negócio TESTE API em 08/10/2026 (os dois campos gravaram).
const CRM_INTERNO = () => (process.env.DATACRAZY_CRM_URL || 'https://crm.g1.datacrazy.io').replace(/\/$/, '');
async function lerNegocio(id) { const n = await api('GET', `/api/v1/businesses/${id}`); return n.data || n; }
function camposDe(lista_) {
  return (Array.isArray(lista_) ? lista_ : []).map((f) => { const a = f.additionalField || f; return { id: a.id || f.additionalFieldId, nome: a.name || '', opcoes: lerOpcoes(a.options), valor: f.value ?? f.valueNumber ?? f.valueDate ?? '' }; }).filter((c) => c.id);
}
// campos do negócio com os valores atuais (pela rota da tela); null se não der para ler
async function camposDoNegocio(negocioId) {
  try { return camposDe(lista(await api('GET', `${CRM_INTERNO()}/api/crm/additional-fields/business/${negocioId}?take=1000&skip=0`))); } catch (e) { if (e instanceof LimiteApi) throw e; return null; }
}
async function preencherCamposNegocio(negocio, dados, relatorio = null) {
  const cepFmt = dados.cep ? String(dados.cep).replace(/^(\d{5})(\d{3})$/, '$1-$2') : '';
  const enderecoCompleto = [[dados.rua, dados.numero].filter(Boolean).join(', '), dados.bairro, dados.cidade && dados.uf ? `${dados.cidade}/${dados.uf}` : dados.cidade, cepFmt && `CEP ${cepFmt}`].filter(Boolean).join(' - ');
  const valores = { plano: dados.plano, operadora: dados.operadora ? nomeOperadora(dados.operadora) : '', valor: dados.valor != null && dados.valor !== '' ? String(dados.valor) : '', cep: cepFmt, endereco: dados.rua, enderecoCompleto, numero: dados.numero, bairro: dados.bairro, cidade: dados.cidade, uf: dados.uf, ref: dados.ref, origem: dados.ref ? 'Google Ads' : 'Site' };
  const lidos = await camposDoNegocio(negocio.id);
  const campos = lidos ? [...lidos] : camposDe(negocio.additionalFields);
  for (const [nome, id] of Object.entries(IDS_CONHECIDOS)) if (!campos.some((c) => c.id === id || norm(c.nome) === nome)) campos.push({ id, nome, opcoes: [], valor: '' });
  let n = 0;
  for (const [nomeCampo, chave] of Object.entries(mapaCampos())) {
    const campo = campos.find((c) => norm(c.nome) === norm(nomeCampo));
    if (!campo || !valores[chave]) continue;
    if (!relatorio && campo.valor !== '' && campo.valor != null) continue; // já preenchido pela equipe: não mexe
    const valor = valorParaCampo(campo, valores[chave]);
    let erro = '';
    try { await api('PUT', `${CRM_INTERNO()}/api/crm/additional-fields/business/${negocio.id}/${campo.id}`, { value: valor }); n++; if (!relatorio) contar('camposGravados'); } catch (e) { if (e instanceof LimiteApi) throw e; erro = e.message; if (!relatorio) { contar('camposComErro'); store.save('dc-ultimo-erro', { em: new Date().toISOString(), onde: `campo ${nomeCampo}`, erro: erro.slice(0, 200) }); } }
    if (relatorio) relatorio.push({ etapa: 'campo', campo: nomeCampo, valor, ok: !erro, erro: erro.slice(0, 200) });
    else if (erro) registrar(`negócio ${negocio.code || negocio.id}: não gravou "${nomeCampo}" (${erro.slice(0, 120)})`);
  }
  return n;
}

// ---------- produto (plano escolhido) ----------
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
function nomeProduto(d) {
  const op = d.operadora ? nomeOperadora(d.operadora) : '';
  const p = String(d.plano || '').replace(/\s+mega\b/i, '').trim();
  return !op || norm(p).includes(norm(op)) ? p : `${op} ${p}`;
}
// velocidade em Mega: "600 Mega" → 600, "1 GB"/"1 Giga" → 1000
function velocidade(s) {
  const t = norm(s);
  const m = t.match(/(\d{2,4})\s*(mega|mb)\b/); if (m) return Number(m[1]);
  const g = t.match(/(\d+(?:[.,]\d+)?)\s*(giga|gb)\b/); if (g) return Math.round(parseFloat(g[1].replace(',', '.')) * 1000);
  const n = t.match(/\b(\d{3,4})\b/); return n ? Number(n[1]) : 0;
}
// Procura no catálogo um produto da mesma operadora e velocidade (ex.: "Nio Fibra 600 Mega" → "Nio Fibra 600").
function acharNoCatalogo(catalogo, d) {
  const nome = nomeProduto(d);
  const exato = catalogo.find((x) => norm(x.name) === norm(nome));
  if (exato) return exato;
  const op = norm(nomeOperadora(d.operadora || d.plano));
  const vel = velocidade(d.plano);
  if (!op || !vel) return null;
  const promo = /promo/i.test(d.plano);
  const extras = (s) => norm(s).replace(/[^a-z]+/g, ' ').split(' ').filter((w) => ['tv', 'movel', 'paramount', 'globoplay', 'youtube', 'max', 'netflix', 'combo', 'pos', 'controle', 'box', 'chip'].includes(w)).sort().join(',');
  const cand = catalogo.filter((x) => norm(x.name).startsWith(op) && velocidade(x.name) === vel && extras(x.name) === extras(d.plano));
  if (!cand.length) return null;
  const preco = Number(d.valor) || 0;
  cand.sort((x, y) => (Math.abs(x.price - preco) - Math.abs(y.price - preco)) || ((/promo/i.test(x.name) === promo ? 0 : 1) - (/promo/i.test(y.name) === promo ? 0 : 1)));
  return cand[0];
}
async function catalogo() {
  const todos = [];
  for (let p = 0; p < 5; p++) {
    const ps = lista(await api('GET', `/api/v1/products?take=100&skip=${p * 100}`));
    todos.push(...ps);
    if (ps.length < 100) break;
  }
  return todos;
}
// Usa o produto do catálogo que corresponde ao plano; se não existir, cria.
async function garantirProduto(d) {
  if (!d || !d.plano) return null;
  const cat = await catalogo();
  let prod = acharNoCatalogo(cat, d);
  if (!prod) {
    const nome = nomeProduto(d);
    const novo = await api('POST', '/api/v1/products', { id_sku: 'ca-' + slug(nome), name: nome, price: Number(d.valor) || 0 });
    prod = novo.data || novo;
    if (!prod.id) return null;
    registrar(`produto criado no DataCrazy: ${nome}`);
  }
  return prod;
}
// Formato confirmado no negócio TESTE API (08/10/2026): PATCH /api/v1/businesses/{id} com products.
const FORMATOS_PRODUTO = {
  'patch-product': (b, prod, p) => ['PATCH', `/api/v1/businesses/${b}`, { products: [{ product: { ...prod, quantity: 1, total: p }, quantity: 1, price: p, total: p }] }],
};
async function colocarProduto(negocio, prod, preco, relatorio = null) {
  const p = Number(preco) || Number(prod.price) || 0;
  const salvo = store.load('dc-formato-produto-negocio', null);
  if (!relatorio && salvo && salvo.formato === 'nenhum' && Date.now() - new Date(salvo.em).getTime() < 864e5) return false;
  const ordem = !relatorio && salvo && FORMATOS_PRODUTO[salvo.formato] ? [salvo.formato] : Object.keys(FORMATOS_PRODUTO);
  for (const f of ordem) {
    let erro = '';
    try { const [m, c, corpo] = FORMATOS_PRODUTO[f](negocio.id, prod, p); await api(m, c, corpo); } catch (e) { if (e instanceof LimiteApi) throw e; erro = e.message; }
    let ok = false;
    if (!erro) { const n = await lerNegocio(negocio.id); ok = Array.isArray(n.products) && n.products.some((x) => (x.product && x.product.id) === prod.id || x.productId === prod.id); }
    if (relatorio) relatorio.push({ etapa: 'produto', formato: f, ok, erro: erro.slice(0, 200) });
    if (ok) { store.save('dc-formato-produto-negocio', { formato: f, em: new Date().toISOString() }); return true; }
  }
  store.save('dc-formato-produto-negocio', { formato: 'nenhum', em: new Date().toISOString() });
  registrar('o DataCrazy não aceitou colocar o produto no negócio pela API; tento de novo amanhã');
  return false;
}

// Depois de preencher os campos, coloca o negócio na etapa do plano ("Plano Claro" / "Plano Nio" / "Plano Tim").
// Só mexe se o negócio ainda estiver numa etapa de ENTRADA (ex.: "Lead Google"): nunca volta um negócio que já andou.
// DATACRAZY_MOVER=off desliga. DATACRAZY_ETAPA_PLANO muda o nome da etapa (padrão "Plano {operadora}").
async function moverParaEtapaDoPlano(neg, dados) {
  if (/^(off|nao|não|0|false)$/i.test(process.env.DATACRAZY_MOVER || '')) return false;
  const op = nomeOperadora(dados.operadora || dados.plano);
  if (!['Claro', 'Nio', 'Tim'].includes(op)) return false;
  const funil = require('./funil');
  const mapa = await funil.etapas(api, lista);
  const atual = mapa[neg.stageId];
  if (!atual) return false;
  const cl = funil.classificar(atual.nome, atual.funil);
  if (cl.perdido || cl.passo !== 'lead') return false; // já está à frente (ou perdido): não mexe
  const alvoNome = norm((process.env.DATACRAZY_ETAPA_PLANO || 'Plano {operadora}').replace('{operadora}', op));
  const alvos = Object.entries(mapa).filter(([, e]) => norm(e.nome) === alvoNome);
  if (!alvos.length) { registrar(`etapa "${alvoNome}" não encontrada no DataCrazy; negócio não foi movido`); return false; }
  const alvo = alvos.find(([, e]) => e.funil === atual.funil) || alvos.find(([, e]) => /qualifica/i.test(norm(e.funil))) || alvos[0];
  if (alvo[0] === neg.stageId) return false;
  await api('POST', '/api/v1/businesses/actions/move', { ids: [neg.id], destinationStageId: alvo[0] });
  contar('negociosMovidos');
  registrar(`negócio ${neg.code || neg.id}: movido de "${atual.nome}" para "${alvo[1].nome}"`);
  return true;
}

// Fila: leads com plano escolhido no site esperando o negócio existir para receber campos e produto.
function negocioPendente(leadId, dados) {
  if (!dados || !(dados.plano || dados.operadora)) return;
  const pend = store.load('dc-negocios-pendentes', []).filter((x) => x.leadId !== leadId);
  const d = { plano: dados.plano || '', operadora: dados.operadora || '', valor: dados.valor ?? '', ref: dados.ref || '' };
  for (const k of ['cep', 'rua', 'numero', 'bairro', 'cidade', 'uf']) if (dados[k]) d[k] = dados[k];
  pend.push({ leadId, dados: d, em: new Date().toISOString() });
  store.save('dc-negocios-pendentes', pend.slice(-500));
}
async function completarNegocio(item) {
  const negs = lista(await api('GET', `/api/v1/leads/${item.leadId}/businesses`))
    .filter((n) => !/won|lost|ganh|perd/i.test(String(n.status || '')))
    .sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  if (!negs[0]) return 'sem-negocio';
  const neg = await lerNegocio(negs[0].id);
  const feito = [];
  try {
    const n = await preencherCamposNegocio(neg, item.dados);
    if (n) feito.push(`${n} campo(s)`);
  } catch (e) { if (e instanceof LimiteApi) throw e; registrar(`negócio ${neg.code || neg.id}: não consegui preencher Plano/Operadora (${e.message})`); }
  if (item.dados.plano && !(Array.isArray(neg.products) && neg.products.length) && !(neg.productsCount > 0)) {
    try {
      const prod = await garantirProduto(item.dados);
      if (prod) {
        const ok = await colocarProduto(neg, prod, item.dados.valor);
        if (ok) feito.push(`produto "${prod.name}"`);
      }
    } catch (e) { if (e instanceof LimiteApi) throw e; registrar(`negócio ${neg.code || neg.id}: não consegui colocar o produto (${e.message})`); }
  }
  if (feito.length) registrar(`negócio ${neg.code || neg.id}: ${feito.join(' + ')}`);
  try { await moverParaEtapaDoPlano(neg, item.dados); } catch (e) {
    if (e instanceof LimiteApi) throw e;
    registrar(`negócio ${neg.code || neg.id}: não consegui mover para a etapa do plano (${e.message})`);
    store.save('dc-ultimo-erro', { em: new Date().toISOString(), onde: 'mover negócio', erro: e.message.slice(0, 200) });
  }
  return 'ok';
}
// Teste pelo painel: procura o lead pelo nome (ex.: "TESTE API"), pega o negócio aberto mais recente
// e tenta gravar Plano / Operadora escolhida e um produto, mostrando cada formato tentado.
async function testarNegocio(nomeLead, dados = { plano: 'Nio Fibra 600 Mega', operadora: 'Nio', valor: 110 }) {
  if (!configurado()) return { erro: 'DATACRAZY_TOKEN não configurado' };
  const out = { lead: null, negocio: null, tentativas: [] };
  try {
    const leads = lista(await api('GET', `/api/v1/leads?search=${encodeURIComponent(nomeLead)}&take=10`));
    const lead = leads.find((l) => norm(l.name) === norm(nomeLead));
    if (!lead) return { ...out, erro: `nenhum lead com o nome exato "${nomeLead}". Crie um lead e um negócio de teste com esse nome.` };
    out.lead = lead.name;
    const negs = lista(await api('GET', `/api/v1/leads/${lead.id}/businesses`)).filter((n) => !/won|lost|ganh|perd/i.test(String(n.status || '')));
    if (!negs.length) return { ...out, erro: 'o lead de teste não tem negócio aberto' };
    const neg = await lerNegocio(negs[0].id);
    out.negocio = neg.code || neg.id;
    const antes = await camposDoNegocio(neg.id);
    out.leituraDosCampos = antes ? 'ok' : 'não consegui ler os campos do negócio';
    out.camposGravados = await preencherCamposNegocio(neg, dados, out.tentativas);
    const prod = await garantirProduto(dados);
    out.produto = prod ? prod.name : null;
    if (prod) out.produtoColocado = await colocarProduto(neg, prod, dados.valor, out.tentativas);
    const depois = await camposDoNegocio(neg.id);
    if (depois) out.camposAgora = Object.fromEntries(depois.filter((c) => Object.keys(mapaCampos()).some((k) => norm(k) === norm(c.nome))).map((c) => [c.nome, c.valor]));
  } catch (e) { out.erro = e.message; }
  return out;
}
async function lerNegociosPendentes() {
  const limite = Date.now() - 48 * 3600e3;
  const pend = store.load('dc-negocios-pendentes', []).filter((x) => new Date(x.em).getTime() > limite);
  const restam = [];
  let i = 0;
  try {
    for (; i < pend.length; i++) {
      if (i >= 10) { restam.push(pend[i]); continue; }
      if ((await completarNegocio(pend[i])) === 'sem-negocio') restam.push(pend[i]); // negócio ainda não criado: tenta no próximo ciclo
    }
  } catch (e) { restam.push(...pend.slice(i)); throw e; } finally { store.save('dc-negocios-pendentes', restam); }
}

// Lê a mensagem que o site manda para o WhatsApp e extrai plano e endereço.
// Formatos do site:
//  "Olá! Quero contratar o plano Nio Fibra 600 Mega (Nio) de R$ 110,00/mês.\nEndereço: Rua A, 12 - Centro - Sete Lagoas/MG - CEP 35700-001"
//  "Olá! Sou Maria. Tenho interesse no plano X (Claro). Endereço: Rua A, 12 - Centro - Cidade/UF - CEP 35700001."
function lerMensagemSite(texto) {
  const t = String(texto || '').replace(/\r/g, '');
  let mPlano = t.match(/plano[ \t]+([^\n(]+?)[ \t]*\(([^)\n]+)\)(?:[ \t]+de[ \t]+R\$\s*([\d.]+,\d{2}))?/i);
  if (mPlano && /^ref:/i.test(mPlano[2].trim())) mPlano = null; // "(Ref: G-XXXXX)" não é operadora
  const mEnd = t.match(/Endere[cç]o:\s*([^\n]+?)\.?\s*(?:\(Ref:|\n|$)/i);
  if (!mPlano && !mEnd) return null;
  const d = {};
  if (mPlano) {
    d.plano = mPlano[1].trim(); d.operadora = mPlano[2].trim();
    if (mPlano[3]) d.valor = Number(mPlano[3].replace(/\./g, '').replace(',', '.'));
  }
  if (mEnd) {
    const partes = mEnd[1].split(/\s+-\s+/).map((x) => x.trim()).filter(Boolean);
    for (let i = partes.length - 1; i >= 0; i--) {
      const p = partes[i];
      const cep = p.match(/CEP\s*(\d{5})-?(\d{3})/i);
      if (cep) { d.cep = cep[1] + cep[2]; partes.splice(i, 1); continue; }
      const cid = p.match(/^(.+)\/([A-Z]{2})$/);
      if (cid && !d.cidade) { d.cidade = cid[1].trim(); d.uf = cid[2]; partes.splice(i, 1); }
    }
    if (partes.length) {
      const ruaNum = partes[0].match(/^(.*?),\s*([\w\-\/ ]{1,10})$/);
      if (ruaNum) { d.rua = ruaNum[1].trim(); d.numero = ruaNum[2].trim(); } else d.rua = partes[0];
      if (partes[1]) d.bairro = partes[1];
    }
  }
  return d;
}

// Coloca a tag e preenche o endereço do lead (se ainda não tiver). Plano e operadora vão para o negócio (fila acima).
async function marcarLead(lead, tagId, dados = null) {
  const atuais = (lead.tags || []).map((t) => t.id).filter(Boolean);
  const corpo = {};
  if (tagId && !atuais.includes(tagId)) corpo.tags = [...atuais, tagId].map((id) => ({ id }));
  if (dados) {
    const end = lead.address || {};
    if (!end.zip && dados.cep) {
      corpo.address = {
        zip: String(dados.cep).replace(/^(\d{5})(\d{3})$/, '$1-$2'), address: dados.rua || '', number: dados.numero || '', block: dados.bairro || '',
        city: dados.cidade || '', state: dados.uf || '', country: 'Brasil',
      };
    }
  }
  if (!Object.keys(corpo).length) return false;
  await api('PATCH', `/api/v1/leads/${lead.id}`, corpo);
  return true;
}

// ---------- etapas da sincronização ----------
async function lerConversas(rastreio, tagId) {
  const vinc = vinculos();
  const vistos = store.load('dc-conversas-vistas', {});
  const preenchidos = store.load('dc-preenchidos', {});
  let novos = 0;
  let leituras = 0;
  const MAX_LEITURAS = Number(process.env.DATACRAZY_MAX_CONVERSAS || 40);
  // na primeira vez olha as últimas 6 horas; depois, só o que chegou desde a última leitura (com folga)
  const desde = new Date(new Date(store.load('dc-ultima-conversa', null) || Date.now() - 6 * 3600e3).getTime() - 15 * 60e3).toISOString();
  let maisRecente = store.load('dc-ultima-conversa', null) || new Date(Date.now() - 6 * 3600e3).toISOString();
  // conversas para reler no próximo ciclo (lead ainda não criado, erro): seguram a janela de leitura por até 2 horas
  const esperar = [];
  const adiadas = store.load('dc-adiadas', {});
  for (const [k, v] of Object.entries(adiadas)) if (Date.now() - new Date(v).getTime() > 2 * 3600e3) delete adiadas[k];
  const adiar = (id, marca) => {
    adiadas[id] = adiadas[id] || new Date().toISOString();
    if (Date.now() - new Date(adiadas[id]).getTime() >= 2 * 3600e3) { delete adiadas[id]; return false; }
    delete vistos[id]; esperar.push(marca); return true;
  };
  const salvar = () => {
    store.save('dc-adiadas', adiadas);
    if (esperar.length) { const min = esperar.sort()[0]; if (min < maisRecente) maisRecente = min; }
    const chaves = Object.keys(vistos); if (chaves.length > 5000) for (const k of chaves.slice(0, chaves.length - 5000)) delete vistos[k];
    store.save('dc-conversas-vistas', vistos); store.save('dc-vinculos', vinc);
    const pk = Object.keys(preenchidos); if (pk.length > 5000) for (const k of pk.slice(0, pk.length - 5000)) delete preenchidos[k];
    store.save('dc-preenchidos', preenchidos); store.save('dc-ultima-conversa', maisRecente);
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
      const recebidasMsg = msgs.filter((x) => x.received !== false);
      const recebidas = recebidasMsg.map((x) => x.body || '');
      const texto = recebidas.join('\n');
      const m = texto.match(REF);
      // usa a mensagem do site MAIS RECENTE; cada mensagem nova do site é processada uma vez
      // (a mesma pessoa pode voltar ao site e escolher outro plano)
      const quando = (x) => String(x.createdAt || x.date || x.timestamp || x.sentAt || '');
      const doSiteMsg = recebidasMsg.map((x) => ({ x, d: lerMensagemSite(x.body || '') })).filter((o) => o.d).sort((a, b) => quando(b.x).localeCompare(quando(a.x)))[0] || null;
      const doSite = doSiteMsg ? doSiteMsg.d : null;
      const chave = doSiteMsg ? `${c.id}:${doSiteMsg.x.id || require('node:crypto').createHash('sha1').update(doSiteMsg.x.body || '').digest('hex').slice(0, 16)}` : c.id;
      if (!m && !doSite) continue;
      if (!m && preenchidos[chave]) continue; // esta mensagem do site já foi usada
      contar('mensagensDoSite');
      try {
      const ref = m ? 'G-' + m[1].toUpperCase() : '';
      const clique = ref ? rastreio.buscar(ref) : null;
      const telefone = telefoneDaConversa(c, recebidasMsg);
      if (!telefone) { contar('semTelefone'); registrar(`conversa com mensagem do site, mas sem telefone do cliente (campos do contato: ${Object.keys(c.contact || {}).join(', ')})`); continue; }
      if (ref && !clique) registrar(`código ${ref} encontrado, mas sem clique registrado (só os dados da mensagem serão usados)`);
      const lead = await acharLead(telefone);
      if (!lead) {
        // o DataCrazy às vezes cria o lead alguns minutos depois: tenta de novo por até 2 horas
        if (!adiar(c.id, marca)) { contar('leadNaoEncontrado'); registrar(`lead do telefone ...${telefone.slice(-4)} não encontrado no DataCrazy depois de 2 horas`); }
        continue;
      }
      delete adiadas[c.id];
      const ehGoogle = Boolean(clique && (clique.gclid || clique.gbraid || clique.wbraid || clique.utm_source));
      if (ehGoogle && !vinc[lead.id]) { vinc[lead.id] = { ref, gclid: clique.gclid || '', gbraid: clique.gbraid || '', wbraid: clique.wbraid || '', telefone, em: new Date().toISOString() }; novos++; }
      // a mensagem mais recente do site vale mais que o clique (a pessoa pode ter trocado de plano)
      const dados = { ...Object.fromEntries(Object.entries(clique || {}).filter(([, v]) => v !== '' && v != null)), ...(doSite || {}), ref };
      const primeiraVez = !preenchidos[chave];
      // primeiro põe o negócio na fila (plano/operadora/endereço); um erro ao atualizar o lead não pode impedir isso
      if (primeiraVez) negocioPendente(lead.id, dados);
      preenchidos[chave] = true;
      if (primeiraVez && (dados.plano || dados.operadora)) registrar(`lead ${lead.name || telefone}: plano ${dados.plano || '?'} (${dados.operadora || '?'}) na fila para o negócio`);
      let mudou = false;
      try { mudou = await marcarLead(lead, ehGoogle ? tagId : null, primeiraVez ? dados : null); } catch (e) {
        if (e instanceof LimiteApi) throw e;
        contar('erroNoLead'); store.save('dc-ultimo-erro', { em: new Date().toISOString(), onde: 'atualizar lead (tag/endereço)', erro: e.message.slice(0, 200) });
        registrar(`lead ${lead.name || telefone}: não consegui gravar tag/endereço (${e.message.slice(0, 120)})`);
      }
      if (mudou) { contar('leadsAtualizados'); registrar(`lead ${lead.name || telefone}: ${ehGoogle ? `tag "${TAG()}" + ` : ''}dados do site preenchidos${dados.plano ? ` (${dados.plano})` : ''}${ref ? ` ${ref}` : ''}`); }
      } catch (e) {
        // um erro numa conversa não derruba as outras; se foi limite da API, relê esta no próximo ciclo
        if (e instanceof LimiteApi) { delete vistos[c.id]; esperar.push(marca); throw e; }
        adiar(c.id, marca);
        store.save('dc-ultimo-erro', { em: new Date().toISOString(), onde: 'ler conversa', erro: e.message.slice(0, 200) });
        registrar('erro numa conversa: ' + e.message.slice(0, 150));
      }
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
    } else if (await marcarLead(lead, tagId, f)) registrar(`lead do formulário marcado com "${TAG()}": ${f.nome} (${f.ref})`);
    if (lead && lead.id) negocioPendente(lead.id, f);
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
    await lerNegociosPendentes();
    await lerNegocios(etapas);
    // funil de vendas do painel de tráfego (todos os negócios, não só os do Google)
    try { await require('./funil').sincronizar(api, lista, vinculos()); } catch (e) { if (e instanceof LimiteApi) throw e; registrar('funil: ' + e.message); }
    estado.ultima = new Date().toISOString();
    store.save('dc-ultima-sinc', estado.ultima);
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
    out.temTelefoneNaConversa = Boolean(c && telefoneDaConversa(c));
    const l = lista(await api('GET', '/api/v1/leads?take=1&complete=true'))[0];
    out.leadCampos = l ? Object.keys(l) : [];
    out.leadEndereco = l && l.address ? Object.keys(l.address) : [];
    out.camposPersonalizados = (l && Array.isArray(l.additionalFields) ? l.additionalFields : []).map((f) => ({ chaves: Object.keys(f), nome: f.name || f.label || (f.additionalField && (f.additionalField.name || f.additionalField.label)) || '' }));
    out.mapaCampos = mapaCampos();
    out.negociosAguardando = store.load('dc-negocios-pendentes', []).length;
    try { const cat = await catalogo(); out.produtosNoCatalogo = cat.length; } catch (e) { out.produtosErro = e.message; }
    out.formatoProdutoNegocio = store.load('dc-formato-produto-negocio', null);
    try {
      const n0 = lista(await api('GET', '/api/v1/businesses?take=1'))[0];
      if (n0) { const cs = await camposDoNegocio(n0.id); out.leituraCamposNegocio = cs ? 'ok' : 'falhou'; if (cs) out.camposEncontrados = Object.keys(mapaCampos()).map((k) => ({ campo: k, existe: cs.some((c) => norm(c.nome) === norm(k)) || Boolean(IDS_CONHECIDOS[norm(k)]) })); }
    } catch (e) { out.negocioErro = e.message; }
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

// resumo sem dados pessoais (vai para o relatório da IA)
const resumo = () => ({ ultima: estado.ultima || store.load('dc-ultima-sinc', null), erro: estado.erro, hoje: store.load('dc-contadores', {}), ultimoErro: store.load('dc-ultimo-erro', null), negociosAguardando: store.load('dc-negocios-pendentes', []).length });
const status = () => ({ configurado: configurado(), tag: TAG(), etapa: ETAPA(), resumo: resumo(), ...estado, vinculos: Object.keys(vinculos()).length, conversoes: conversoes().slice(-30).reverse().map((c) => ({ ref: c.ref, hora: c.hora, valor: c.valor, temGclid: Boolean(c.gclid) })) });

module.exports = { resumo, telefoneDaConversa, testarNegocio, lerMensagemSite, nomeOperadora, valorParaCampo, nomeProduto, acharNoCatalogo, velocidade, sincronizar, iniciar, diagnostico, csvConversoes, status, configurado, REF };
