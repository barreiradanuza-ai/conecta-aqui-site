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
const CAMPOS_PADRAO = { 'Operadora escolhida': 'operadora', Plano: 'plano' };
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
// A API pública não tem a rota de campos que a tela usa (/additional-fields/business/... dá 404),
// mas o negócio vem com "additionalFields". Testamos os formatos de gravação, conferimos lendo o negócio
// de novo e guardamos o que funcionou (dc-formato-campo-negocio).
const CRM_INTERNO = () => (process.env.DATACRAZY_CRM_URL || 'https://crm.g1.datacrazy.io').replace(/\/$/, '');
const FORMATOS_CAMPO_NEG = {
  'patch-additionalField': (b, itens) => [['PATCH', `/api/v1/businesses/${b}`, { additionalFields: itens.map((i) => ({ additionalField: { id: i.campo.id }, value: i.valor })) }]],
  'patch-additionalFieldId': (b, itens) => [['PATCH', `/api/v1/businesses/${b}`, { additionalFields: itens.map((i) => ({ additionalFieldId: i.campo.id, value: i.valor })) }]],
  'patch-id': (b, itens) => [['PATCH', `/api/v1/businesses/${b}`, { additionalFields: itens.map((i) => ({ id: i.campo.id, value: i.valor })) }]],
  'put-negocio-campo': (b, itens) => itens.map((i) => ['PUT', `/api/v1/businesses/${b}/additional-fields/${i.campo.id}`, { value: i.valor }]),
  'crm-interno': (b, itens) => itens.map((i) => ['PUT', `${CRM_INTERNO()}/api/crm/additional-fields/business/${b}/${i.campo.id}`, { value: i.valor }]),
};
function camposDe(negocio) {
  const l = Array.isArray(negocio.additionalFields) ? negocio.additionalFields : [];
  return l.map((f) => { const a = f.additionalField || f.field || f; return { id: a.id || f.additionalFieldId, nome: a.name || a.label || '', tipo: a.type || '', opcoes: lerOpcoes(a.options), valor: f.additionalField || f.additionalFieldId ? (f.value ?? f.valueNumber ?? f.valueDate ?? '') : (f.value ?? '') }; }).filter((c) => c.id);
}
async function lerNegocio(id) { const n = await api('GET', `/api/v1/businesses/${id}`); return n.data || n; }
async function preencherCamposNegocio(negocio, dados, relatorio = null) {
  const valores = { plano: dados.plano, operadora: dados.operadora ? nomeOperadora(dados.operadora) : '', valor: dados.valor != null && dados.valor !== '' ? String(dados.valor) : '', cep: dados.cep, endereco: dados.rua, numero: dados.numero, bairro: dados.bairro, cidade: dados.cidade, uf: dados.uf, ref: dados.ref, origem: 'Google Ads' };
  const campos = camposDe(negocio);
  for (const [nome, id] of Object.entries(IDS_CONHECIDOS)) if (!campos.some((c) => c.id === id || norm(c.nome) === nome)) campos.push({ id, nome, tipo: '', opcoes: [], valor: '' });
  const itens = [];
  for (const [nomeCampo, chave] of Object.entries(mapaCampos())) {
    const campo = campos.find((c) => norm(c.nome) === norm(nomeCampo));
    if (!campo || !valores[chave]) continue;
    if (!relatorio && campo.valor !== '' && campo.valor != null) continue; // já preenchido pela equipe: não mexe
    itens.push({ campo, valor: valorParaCampo(campo, valores[chave]) });
  }
  if (!itens.length) return 0;
  const salvo = store.load('dc-formato-campo-negocio', null);
  if (!relatorio && salvo && salvo.formato === 'nenhum' && Date.now() - new Date(salvo.em).getTime() < 864e5) return 0;
  const ordem = !relatorio && salvo && FORMATOS_CAMPO_NEG[salvo.formato] ? [salvo.formato] : Object.keys(FORMATOS_CAMPO_NEG);
  for (const f of ordem) {
    let erro = '';
    try { for (const [m, c, corpo] of FORMATOS_CAMPO_NEG[f](negocio.id, itens)) await api(m, c, corpo); } catch (e) { if (e instanceof LimiteApi) throw e; erro = e.message; }
    let ok = false;
    if (!erro) { const n = await lerNegocio(negocio.id); const atuais = camposDe(n); ok = itens.every((i) => atuais.some((c) => c.id === i.campo.id && norm(c.valor) === norm(i.valor))); }
    if (relatorio) relatorio.push({ etapa: 'campos', formato: f, ok, erro: erro.slice(0, 200) });
    if (ok) { store.save('dc-formato-campo-negocio', { formato: f, em: new Date().toISOString() }); return itens.length; }
  }
  store.save('dc-formato-campo-negocio', { formato: 'nenhum', em: new Date().toISOString() });
  registrar('o DataCrazy não aceitou gravar Plano / Operadora escolhida no negócio pela API; tento de novo amanhã');
  return 0;
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
const FORMATOS_PRODUTO = {
  'patch-product': (b, prod, p) => ['PATCH', `/api/v1/businesses/${b}`, { products: [{ product: { ...prod, quantity: 1, total: p }, quantity: 1, price: p, total: p }] }],
  'patch-productId': (b, prod, p) => ['PATCH', `/api/v1/businesses/${b}`, { products: [{ productId: prod.id, quantity: 1, price: p }] }],
  'post-products': (b, prod, p) => ['POST', `/api/v1/businesses/${b}/products`, { productId: prod.id, quantity: 1, price: p }],
  'crm-interno': (b, prod, p) => ['PATCH', `${CRM_INTERNO()}/api/crm/businesses/${b}`, { id: b, products: [{ product: { ...prod, quantity: 1, total: p }, quantity: 1, price: p, total: p }] }],
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

// Fila: leads com plano escolhido no site esperando o negócio existir para receber campos e produto.
function negocioPendente(leadId, dados) {
  if (!dados || !(dados.plano || dados.operadora)) return;
  const pend = store.load('dc-negocios-pendentes', []).filter((x) => x.leadId !== leadId);
  pend.push({ leadId, dados: { plano: dados.plano || '', operadora: dados.operadora || '', valor: dados.valor ?? '', ref: dados.ref || '' }, em: new Date().toISOString() });
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
    out.camposNoNegocio = camposDe(neg).map((c) => c.nome || c.id);
    out.exemploCampoBruto = Array.isArray(neg.additionalFields) && neg.additionalFields[0] ? Object.keys(neg.additionalFields[0]) : [];
    out.camposGravados = await preencherCamposNegocio(neg, dados, out.tentativas);
    const prod = await garantirProduto(dados);
    out.produto = prod ? prod.name : null;
    if (prod) out.produtoColocado = await colocarProduto(neg, prod, dados.valor, out.tentativas);
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
  const mPlano = t.match(/plano\s+(.+?)\s+\(([^)]+)\)(?:\s+de\s+R\$\s*([\d.]+,\d{2}))?/i);
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
        zip: dados.cep, address: [dados.rua, dados.numero].filter(Boolean).join(', '), block: dados.bairro || '',
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
  const salvar = () => {
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
      const recebidas = msgs.filter((x) => x.received !== false).map((x) => x.body || '');
      const texto = recebidas.join('\n');
      const m = texto.match(REF);
      const doSite = recebidas.map(lerMensagemSite).find(Boolean) || null;
      if (!m && !doSite) continue;
      if (!m && preenchidos[c.id]) continue; // mensagem do site já usada para preencher este lead
      const ref = m ? 'G-' + m[1].toUpperCase() : '';
      const clique = ref ? rastreio.buscar(ref) : null;
      const telefone = acharTelefone(c.contact) || acharTelefone(c);
      if (!telefone) { registrar(`conversa com mensagem do site, mas sem telefone`); continue; }
      if (ref && !clique) registrar(`código ${ref} encontrado, mas sem clique registrado (só os dados da mensagem serão usados)`);
      const lead = await acharLead(telefone);
      if (!lead) { delete vistos[c.id]; registrar(`lead do telefone ainda não existe, tento de novo depois`); continue; }
      const ehGoogle = Boolean(clique && (clique.gclid || clique.gbraid || clique.wbraid || clique.utm_source));
      if (ehGoogle && !vinc[lead.id]) { vinc[lead.id] = { ref, gclid: clique.gclid || '', gbraid: clique.gbraid || '', wbraid: clique.wbraid || '', telefone, em: new Date().toISOString() }; novos++; }
      // dados: o que veio do clique no site + o que está escrito na mensagem (a mensagem completa o que faltar)
      const dados = { ...(doSite || {}), ...Object.fromEntries(Object.entries(clique || {}).filter(([, v]) => v !== '' && v != null)), ref };
      const primeiraVez = !preenchidos[c.id];
      const mudou = await marcarLead(lead, ehGoogle ? tagId : null, primeiraVez ? dados : null);
      preenchidos[c.id] = true;
      if (primeiraVez) negocioPendente(lead.id, dados);
      if (mudou) registrar(`lead ${lead.name || telefone}: ${ehGoogle ? `tag "${TAG()}" + ` : ''}dados do site preenchidos${dados.plano ? ` (${dados.plano})` : ''}${ref ? ` ${ref}` : ''}`);
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
    const l = lista(await api('GET', '/api/v1/leads?take=1&complete=true'))[0];
    out.leadCampos = l ? Object.keys(l) : [];
    out.leadEndereco = l && l.address ? Object.keys(l.address) : [];
    out.camposPersonalizados = (l && Array.isArray(l.additionalFields) ? l.additionalFields : []).map((f) => ({ chaves: Object.keys(f), nome: f.name || f.label || (f.additionalField && (f.additionalField.name || f.additionalField.label)) || '' }));
    out.mapaCampos = mapaCampos();
    out.negociosAguardando = store.load('dc-negocios-pendentes', []).length;
    try { const cat = await catalogo(); out.produtosNoCatalogo = cat.length; } catch (e) { out.produtosErro = e.message; }
    out.formatoCampoNegocio = store.load('dc-formato-campo-negocio', null);
    out.formatoProdutoNegocio = store.load('dc-formato-produto-negocio', null);
    try {
      const n0 = lista(await api('GET', '/api/v1/businesses?take=1'))[0];
      if (n0) { const n = await lerNegocio(n0.id); out.camposDoNegocio = camposDe(n).map((c) => c.nome || c.id); out.exemploCampoBruto = Array.isArray(n.additionalFields) && n.additionalFields[0] ? Object.keys(n.additionalFields[0]) : []; }
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

const status = () => ({ configurado: configurado(), tag: TAG(), etapa: ETAPA(), ...estado, vinculos: Object.keys(vinculos()).length, conversoes: conversoes().slice(-30).reverse().map((c) => ({ ref: c.ref, hora: c.hora, valor: c.valor, temGclid: Boolean(c.gclid) })) });

module.exports = { testarNegocio, lerMensagemSite, nomeOperadora, valorParaCampo, nomeProduto, acharNoCatalogo, velocidade, sincronizar, iniciar, diagnostico, csvConversoes, status, configurado, REF };
