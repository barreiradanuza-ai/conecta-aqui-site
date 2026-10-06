// Conecta Aqui — site + ponte de cobertura (app Minha Casa Conectada) + painel de planos.
// Sem dependências externas: só Node.js 20+.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const store = require('./lib/store');
const csv = require('./lib/csv');
const faixas = require('./lib/faixas');
const cobertura = require('./lib/cobertura');
const monitor = require('./lib/monitor');
const UPLOADS_DIR = path.join(store.DATA_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PROD = process.env.NODE_ENV === 'production';

store.init();

// ---------------- utilidades HTTP ----------------
function enviar(res, status, corpo, tipo = 'application/json; charset=utf-8', extras = {}) {
  const dados = typeof corpo === 'string' || Buffer.isBuffer(corpo) ? corpo : JSON.stringify(corpo);
  res.writeHead(status, {
    'content-type': tipo,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    ...extras,
  });
  res.end(dados);
}
const json = (res, status, obj) => enviar(res, status, obj);

function lerCorpo(req, limite = 2 * 1024 * 1024) {
  return new Promise((ok, falha) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => { tam += c.length; if (tam > limite) { falha(Object.assign(new Error('Arquivo muito grande'), { status: 413 })); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes).toString('utf8')));
    req.on('error', falha);
  });
}
function lerBuffer(req, limite) {
  return new Promise((ok, falha) => {
    let tam = 0; const partes = [];
    req.on('data', (c) => { tam += c.length; if (tam > limite) { falha(Object.assign(new Error('Imagem muito grande (máximo 1,5 MB)'), { status: 413 })); req.destroy(); } else partes.push(c); });
    req.on('end', () => ok(Buffer.concat(partes)));
    req.on('error', falha);
  });
}
// reconhece a imagem pelo conteúdo (não confia no nome do arquivo)
function tipoImagem(b) {
  if (b.length > 8 && b[0] === 0x89 && b.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
async function lerJson(req) {
  const t = await lerCorpo(req);
  try { return t ? JSON.parse(t) : {}; } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}
function lerCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
const ipDe = (req) => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;

// ---------------- limite de requisições ----------------
const janelas = new Map();
function limitar(req, chave, max, janelaMs) {
  const k = chave + '|' + ipDe(req);
  const agora = Date.now();
  const lista = (janelas.get(k) || []).filter((t) => agora - t < janelaMs);
  lista.push(agora); janelas.set(k, lista);
  if (janelas.size > 50000) janelas.clear();
  return lista.length <= max;
}

// ---------------- sessão do painel ----------------
const assinar = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
function criarSessao() {
  const exp = Date.now() + 12 * 60 * 60 * 1000;
  const v = `adm.${exp}`;
  return `${v}.${assinar(v)}`;
}
function sessaoValida(req) {
  const t = lerCookies(req).ca_admin || '';
  const i = t.lastIndexOf('.');
  if (i < 0) return false;
  const v = t.slice(0, i), sig = t.slice(i + 1);
  const esperado = assinar(v);
  if (sig.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return false;
  return Number(v.split('.')[1]) > Date.now();
}
function senhaConfere(s) {
  if (!ADMIN_PASSWORD) return false;
  const a = crypto.createHash('sha256').update(String(s)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------- dados ----------------
const operadorasAtivas = () => store.load('operadoras', []).filter((o) => o.ativo);
function planosPublicos(filtro) {
  const ops = Object.fromEntries(store.load('operadoras', []).map((o) => [o.id, o]));
  return store.load('planos', [])
    .filter((p) => p.ativo && ops[p.operadoraId]?.ativo && filtro(p))
    .sort((a, b) => (b.destaque - a.destaque) || (a.ordem - b.ordem) || ((a.precoPromo ?? a.preco) - (b.precoPromo ?? b.preco)))
    .map((p) => ({
      id: p.id, nome: p.nome, tipo: p.tipo, velocidadeMbps: p.velocidadeMbps, preco: p.preco, precoPromo: p.precoPromo,
      mesesPromo: p.mesesPromo, beneficios: p.beneficios, destaque: p.destaque,
      streaming: (p.streaming || []).map((k) => ({ id: k, nome: store.STREAMING[k] })), mesesStreaming: p.mesesStreaming ?? null,
      linkContratacao: p.linkContratacao || ops[p.operadoraId].linkContratacao || '',
      operadora: { id: p.operadoraId, nome: ops[p.operadoraId].nome, cor: ops[p.operadoraId].cor, logoUrl: ops[p.operadoraId].logoUrl },
    }));
}

const COLUNAS_PLANO = ['id', 'operadoraId', 'nome', 'tipo', 'velocidadeMbps', 'preco', 'precoPromo', 'mesesPromo', 'beneficios', 'streaming', 'mesesStreaming', 'destaque', 'ativo', 'apenasCidadePromo', 'linkContratacao', 'ordem'];
const COLUNAS_LEAD = ['criadoEm', 'nome', 'telefone', 'cep', 'rua', 'numero', 'bairro', 'cidade', 'uf', 'planoNome', 'operadora', 'origem'];

// ---------------- rotas públicas ----------------
async function rotaPublica(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/cobertura') {
    if (!limitar(req, 'cob', 30, 60_000)) return json(res, 429, { erro: 'Muitas buscas seguidas. Aguarde um minuto.' });
    const ops = operadorasAtivas();
    const dados = await cobertura.consultar(url.searchParams.get('cep'), ops);
    const planos = planosPublicos((p) => dados.operadoras[p.operadoraId] && (!p.apenasCidadePromo || dados.promoClaro));
    return json(res, 200, {
      cep: dados.cep, endereco: dados.endereco, demo: dados.demo,
      operadoras: ops.filter((o) => dados.operadoras[o.id]).map((o) => ({ id: o.id, nome: o.nome, cor: o.cor, logoUrl: o.logoUrl })),
      planos,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/destaques') {
    return json(res, 200, { planos: planosPublicos((p) => p.destaque && !p.apenasCidadePromo).slice(0, 6), operadoras: operadorasAtivas().map((o) => ({ id: o.id, nome: o.nome, cor: o.cor, logoUrl: o.logoUrl })) });
  }
  if (req.method === 'POST' && url.pathname === '/api/contato') {
    if (!limitar(req, 'lead', 5, 10 * 60_000)) return json(res, 429, { erro: 'Muitos envios. Tente mais tarde.' });
    const b = await lerJson(req);
    if (b.site) return json(res, 200, { ok: true }); // armadilha anti-robô (campo escondido)
    const telefone = String(b.telefone || '').replace(/\D/g, '');
    const nome = String(b.nome || '').trim().slice(0, 80);
    if (nome.length < 2 || telefone.length < 10 || telefone.length > 13) return json(res, 400, { erro: 'Informe nome e um telefone com DDD.' });
    const leads = store.load('leads', []);
    leads.push({
      id: store.newId(), criadoEm: new Date().toISOString(), nome, telefone,
      cep: cobertura.limparCep(b.cep).slice(0, 8), rua: String(b.rua || '').slice(0, 120), numero: String(b.numero || '').slice(0, 10), bairro: String(b.bairro || '').slice(0, 60), cidade: String(b.cidade || '').slice(0, 60), uf: String(b.uf || '').slice(0, 2),
      planoNome: String(b.planoNome || '').slice(0, 100), operadora: String(b.operadora || '').slice(0, 40),
      origem: ['plano', 'sem-cobertura', 'contato'].includes(b.origem) ? b.origem : 'contato',
    });
    store.save('leads', leads.slice(-20000));
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/slides') {
    // slides de promoção trazem o plano junto (preço sempre igual ao do painel)
    const planos = planosPublicos(() => true);
    const acha = (x) => {
      if (x.planoId) return planos.find((p) => p.id === x.planoId);
      const [k, v] = (x.filtro || '').split(':');
      if (k === 'streaming') return planos.find((p) => p.streaming.some((s) => s.id === v));
      if (k === 'tipo') return planos.find((p) => p.tipo === v);
      if (k === 'operadora') return planos.find((p) => p.operadora.id === v);
      return null;
    };
    const lista = store.load('slides', []).filter((x) => x.ativo).map((x) => (x.visual === 'plano' ? { ...x, plano: acha(x) || null } : x));
    return json(res, 200, lista.filter((x) => x.visual !== 'plano' || x.plano));
  }
  if (req.method === 'POST' && url.pathname === '/api/clique') {
    // registra quem clicou em "Quero este plano" (vai direto para o WhatsApp)
    if (!limitar(req, 'clique', 20, 10 * 60_000)) return json(res, 200, { ok: true });
    const b = await lerJson(req);
    const leads = store.load('leads', []);
    leads.push({
      id: store.newId(), criadoEm: new Date().toISOString(), nome: '', telefone: '',
      cep: cobertura.limparCep(b.cep).slice(0, 8), rua: String(b.rua || '').slice(0, 120), numero: String(b.numero || '').slice(0, 10), bairro: String(b.bairro || '').slice(0, 60),
      cidade: String(b.cidade || '').slice(0, 60), uf: String(b.uf || '').slice(0, 2),
      planoNome: String(b.planoNome || '').slice(0, 100), operadora: String(b.operadora || '').slice(0, 40), origem: 'whatsapp',
    });
    store.save('leads', leads.slice(-20000));
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/api/config') {
    return json(res, 200, { whatsapp: (process.env.WHATSAPP_NUMBER || '').replace(/\D/g, ''), whatsappPlanos: (process.env.WHATSAPP_PLANOS || '5511955035657').replace(/\D/g, ''), telefone: process.env.TELEFONE || '', email: process.env.EMAIL_CONTATO || '', cnpj: process.env.CNPJ || '62.915.438/0001-57', adsConversao: process.env.ADS_CONVERSAO || '' });
  }
  return false;
}

// ---------------- rotas do painel ----------------
async function rotaAdmin(req, res, url) {
  if (url.pathname === '/admin/api/login' && req.method === 'POST') {
    if (!limitar(req, 'login', 8, 15 * 60_000)) return json(res, 429, { erro: 'Muitas tentativas. Aguarde 15 minutos.' });
    const b = await lerJson(req);
    if (!ADMIN_PASSWORD) return json(res, 503, { erro: 'Defina a variável ADMIN_PASSWORD no servidor.' });
    if (!senhaConfere(b.senha)) return json(res, 401, { erro: 'Senha incorreta.' });
    return enviar(res, 200, { ok: true }, undefined, { 'set-cookie': `ca_admin=${criarSessao()}; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200${IS_PROD ? '; Secure' : ''}` });
  }
  if (url.pathname === '/admin/api/logout' && req.method === 'POST') {
    return enviar(res, 200, { ok: true }, undefined, { 'set-cookie': 'ca_admin=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0' });
  }
  if (!sessaoValida(req)) return json(res, 401, { erro: 'Não autenticado' });
  // proteção extra contra envio de outro site
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'painel') return json(res, 403, { erro: 'Requisição recusada' });

  const operadoras = store.load('operadoras', []);
  const p = url.pathname.replace('/admin/api', '');

  if (p === '/status' && req.method === 'GET') {
    return json(res, 200, { modoDemo: cobertura.MODO_DEMO, planos: store.load('planos', []).length, leads: store.load('leads', []).length });
  }
  // --- planos ---
  if (p === '/planos' && req.method === 'GET') return json(res, 200, store.load('planos', []));
  if (p === '/planos' && req.method === 'POST') {
    const plano = store.normalizarPlano({ ...(await lerJson(req)), id: undefined, atualizadoEm: undefined });
    const erros = store.validarPlano(plano, operadoras);
    if (erros.length) return json(res, 400, { erro: erros.join('; ') });
    const planos = store.load('planos', []); planos.push(plano); store.save('planos', planos);
    return json(res, 201, plano);
  }
  let m = p.match(/^\/planos\/([a-f0-9]+)$/);
  if (m && req.method === 'PUT') {
    const planos = store.load('planos', []);
    const i = planos.findIndex((x) => x.id === m[1]);
    if (i < 0) return json(res, 404, { erro: 'Plano não encontrado' });
    const plano = store.normalizarPlano({ ...planos[i], ...(await lerJson(req)), id: m[1], atualizadoEm: undefined });
    const erros = store.validarPlano(plano, operadoras);
    if (erros.length) return json(res, 400, { erro: erros.join('; ') });
    planos[i] = plano; store.save('planos', planos);
    return json(res, 200, plano);
  }
  if (m && req.method === 'DELETE') {
    const planos = store.load('planos', []);
    store.save('planos', planos.filter((x) => x.id !== m[1]));
    return json(res, 200, { ok: true });
  }
  if (p === '/planos/exportar' && req.method === 'GET') {
    const br = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
    const linhas = store.load('planos', []).map((x) => ({ ...x, preco: br(x.preco), precoPromo: br(x.precoPromo), destaque: x.destaque ? 'sim' : 'nao', ativo: x.ativo ? 'sim' : 'nao', apenasCidadePromo: x.apenasCidadePromo ? 'sim' : 'nao' }));
    return enviar(res, 200, csv.stringify(linhas, COLUNAS_PLANO), 'text/csv; charset=utf-8', { 'content-disposition': 'attachment; filename="planos-conecta-aqui.csv"' });
  }
  if (p === '/planos/importar' && req.method === 'POST') {
    const modo = url.searchParams.get('modo') === 'substituir' ? 'substituir' : 'mesclar';
    const registros = csv.parse(await lerCorpo(req));
    if (!registros.length) return json(res, 400, { erro: 'Planilha vazia ou sem cabeçalho.' });
    const atuais = modo === 'substituir' ? [] : store.load('planos', []);
    const porId = new Map(atuais.map((x) => [x.id, x]));
    const erros = []; let criados = 0, atualizados = 0;
    registros.forEach((r, idx) => {
      const existente = r.id && porId.get(r.id);
      const plano = store.normalizarPlano({ ...(existente || {}), ...r, id: existente ? r.id : undefined, atualizadoEm: undefined });
      const e = store.validarPlano(plano, operadoras);
      if (e.length) { erros.push(`Linha ${idx + 2}: ${e.join('; ')}`); return; }
      if (existente) atualizados++; else criados++;
      porId.set(plano.id, plano);
    });
    if (erros.length) return json(res, 400, { erro: 'Nada foi importado. Corrija a planilha:', detalhes: erros.slice(0, 30) });
    store.save('planos', [...porId.values()]);
    return json(res, 200, { ok: true, criados, atualizados });
  }
  // --- operadoras ---
  if (p === '/operadoras' && req.method === 'GET') return json(res, 200, operadoras);
  if (p === '/operadoras' && req.method === 'PUT') {
    const lista = (await lerJson(req)).map(store.normalizarOperadora);
    if (lista.some((o) => !o.id || !o.nome)) return json(res, 400, { erro: 'Toda operadora precisa de nome.' });
    if (new Set(lista.map((o) => o.id)).size !== lista.length) return json(res, 400, { erro: 'Há operadoras com o mesmo nome.' });
    const usadas = new Set(store.load('planos', []).map((x) => x.operadoraId));
    const removidaEmUso = operadoras.find((o) => usadas.has(o.id) && !lista.some((n) => n.id === o.id));
    if (removidaEmUso) return json(res, 400, { erro: `"${removidaEmUso.nome}" tem planos cadastrados. Desative em vez de remover.` });
    store.save('operadoras', lista); cobertura.limparCache();
    return json(res, 200, lista);
  }
  // --- slides ---
  if (p === '/slides' && req.method === 'GET') return json(res, 200, store.load('slides', []));
  if (p === '/slides' && req.method === 'PUT') {
    const lista = (await lerJson(req));
    if (!Array.isArray(lista) || lista.length > 8) return json(res, 400, { erro: 'Envie de 1 a 8 slides.' });
    const slides = lista.map(store.normalizarSlide);
    if (slides.some((x) => !x.titulo)) return json(res, 400, { erro: 'Todo slide precisa de título.' });
    if (!slides.some((x) => x.ativo)) return json(res, 400, { erro: 'Deixe pelo menos um slide ativo.' });
    store.save('slides', slides);
    return json(res, 200, slides);
  }
  // --- imagens (logos das operadoras e fotos dos slides) ---
  if (p === '/imagem' && req.method === 'POST') {
    const nome = String(url.searchParams.get('nome') || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
    if (!nome) return json(res, 400, { erro: 'Nome da imagem inválido.' });
    const buf = await lerBuffer(req, 1.5 * 1024 * 1024);
    const ext = tipoImagem(buf);
    if (!ext) return json(res, 400, { erro: 'Use uma imagem PNG, JPG ou WEBP.' });
    for (const e of ['png', 'jpg', 'webp']) { try { fs.unlinkSync(path.join(UPLOADS_DIR, `${nome}.${e}`)); } catch {} }
    fs.writeFileSync(path.join(UPLOADS_DIR, `${nome}.${ext}`), buf);
    return json(res, 200, { url: `/uploads/${nome}.${ext}?v=${Date.now()}` });
  }
  // --- monitor de ofertas ---
  if (p === '/monitor' && req.method === 'GET') return json(res, 200, store.load('monitor', {}));
  if (p === '/monitor/verificar' && req.method === 'POST') return json(res, 200, await monitor.verificarTodas());
  m = p.match(/^\/monitor\/([a-z0-9-]+)\/revisado$/);
  if (m && req.method === 'POST') return json(res, 200, monitor.marcarRevisado(m[1]) || {});
  // --- contatos ---
  if (p === '/contatos' && req.method === 'GET') return json(res, 200, store.load('leads', []).slice(-500).reverse());
  if (p === '/contatos/exportar' && req.method === 'GET') {
    return enviar(res, 200, csv.stringify(store.load('leads', []), COLUNAS_LEAD), 'text/csv; charset=utf-8', { 'content-disposition': 'attachment; filename="contatos-conecta-aqui.csv"' });
  }
  // --- faixas de CEP (para segmentar anúncios) ---
  if (p === '/faixas' && req.method === 'GET') {
    const r = faixas.resultado();
    return json(res, 200, { status: faixas.status(), geradoEm: r && r.geradoEm, operadoras: r && r.operadoras, quantidade: r ? r.linhas.length : 0, topo: r ? r.linhas.slice(0, 30) : [] });
  }
  if (p === '/faixas/gerar' && req.method === 'POST') {
    if (cobertura.MODO_DEMO) return json(res, 400, { erro: 'Ponte com o MCC não configurada' });
    return json(res, 200, { status: await faixas.gerar(operadoras) });
  }
  if (p === '/faixas/exportar' && req.method === 'GET') {
    const r = faixas.resultado();
    if (!r) return json(res, 404, { erro: 'Gere as faixas primeiro' });
    const cols = ['prefixo', 'uf', 'cidade', 'total', ...r.operadoras];
    return enviar(res, 200, csv.stringify(r.linhas, cols), 'text/csv; charset=utf-8', { 'content-disposition': 'attachment; filename="faixas-cep-cobertura.csv"' });
  }
  // --- testar cobertura ---
  if (p === '/testar' && req.method === 'GET') {
    cobertura.limparCache();
    const dados = await cobertura.consultar(url.searchParams.get('cep'), operadorasAtivas());
    return json(res, 200, dados);
  }
  return json(res, 404, { erro: 'Rota não encontrada' });
}

// ---------------- arquivos estáticos ----------------
const TIPOS_ARQ = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
function estatico(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel.startsWith('/uploads/')) {
    const nomeArq = path.basename(rel);
    if (!/^[a-z0-9-]+\.(png|jpg|webp)$/.test(nomeArq)) return json(res, 404, { erro: 'Não encontrado' });
    return fs.readFile(path.join(UPLOADS_DIR, nomeArq), (err, dados) => (err ? json(res, 404, { erro: 'Não encontrado' })
      : enviar(res, 200, dados, TIPOS_ARQ[path.extname(nomeArq)], { 'cache-control': 'public, max-age=604800' })));
  }
  if (rel === '/') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const alvo = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!alvo.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { erro: 'Não encontrado' });
  fs.readFile(alvo, (err, dados) => {
    if (err) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => (e2 ? json(res, 404, { erro: 'Não encontrado' }) : enviar(res, 404, idx, TIPOS_ARQ['.html'])));
    const ext = path.extname(alvo);
    enviar(res, 200, dados, TIPOS_ARQ[ext] || 'application/octet-stream', { 'cache-control': ['.html', '.css', '.js'].includes(ext) ? 'no-cache' : 'public, max-age=86400' });
  });
}

// ---------------- servidor ----------------
const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  try {
    if (url.pathname.startsWith('/admin/api/')) return await rotaAdmin(req, res, url);
    if (url.pathname.startsWith('/api/')) {
      const r = await rotaPublica(req, res, url);
      if (r === false) json(res, 404, { erro: 'Rota não encontrada' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { erro: 'Método não permitido' });
    estatico(req, res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(new Date().toISOString(), req.method, url.pathname, e.message);
    if (!res.headersSent) json(res, status, { erro: status === 500 ? 'Não foi possível concluir agora. Tente novamente.' : e.message });
  }
});

if (require.main === module) {
  servidor.listen(PORT, () => {
    if (process.env.MONITOR_OFERTAS !== 'off') monitor.iniciar();
    console.log(`Conecta Aqui rodando na porta ${PORT}`);
    if (cobertura.MODO_DEMO) console.warn('ATENÇÃO: MCC_EMAIL/MCC_PASSWORD não definidos. Cobertura em MODO DEMONSTRAÇÃO (dados fictícios).');
    if (!ADMIN_PASSWORD) console.warn('ATENÇÃO: ADMIN_PASSWORD não definida. O painel ficará bloqueado.');
  });
}
module.exports = servidor;
