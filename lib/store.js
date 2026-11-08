// Armazenamento simples em arquivos JSON (catálogo sincronizado, curadoria, operadoras, slides e contatos).
// Em produção, DATA_DIR deve apontar para um volume persistente (ex.: /data no Railway).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function file(name) { return path.join(DATA_DIR, name + '.json'); }

function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch { return fallback; }
}

function save(name, data) {
  const tmp = file(name) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name)); // escrita atômica
}

const newId = () => crypto.randomBytes(6).toString('hex');

// ---------- Operadoras ----------
// cobertura: "mcc:ceps-claro" (lista do app MCC), "todas" (atende qualquer CEP) ou "nenhuma"
const OPERADORAS_PADRAO = [
  { id: 'claro', nome: 'Claro', cor: '#E3262E', logoUrl: '/images/operadoras/claro.png', cobertura: 'mcc:ceps-claro', linkContratacao: '', siteOfertas: 'https://www.claro.com.br/internet', ativo: true },
  { id: 'nio', nome: 'Nio', cor: '#2BD900', logoUrl: '/images/operadoras/nio.png', cobertura: 'mcc:ceps-nio', linkContratacao: '', siteOfertas: 'https://www.niointernet.com.br/', ativo: true },
  { id: 'tim', nome: 'TIM', cor: '#004691', logoUrl: '/images/operadoras/tim.png', cobertura: 'mcc:ceps-tim', linkContratacao: '', siteOfertas: 'https://internet.tim.com.br/', ativo: true },
  // Vivo ainda não tem lista de CEPs no app Minha Casa Conectada: aparece na vitrine, mas não nos resultados por CEP.
  { id: 'vivo', nome: 'Vivo', cor: '#660099', logoUrl: '/images/operadoras/vivo.png', cobertura: 'nenhuma', linkContratacao: '', siteOfertas: '', ativo: true },
];

// ---------- Slides do topo ----------
// No título, o trecho entre *asteriscos* aparece em destaque (ciano).
const SLIDES_PADRAO = [
  { titulo: 'Encontre o *melhor plano* de internet em sua cidade', subtitulo: 'Digite o seu CEP abaixo, compare e escolha a internet ideal para a sua casa', selo: 'Internet residencial, TV e celular', visual: 'persona', imagem: '/images/banner-persona.webp', ativo: true },
  { titulo: 'Internet fibra com *Globoplay* incluso', subtitulo: 'Novelas, séries e esportes já inclusos na mensalidade. Veja se chega no seu endereço.', selo: 'Oferta da semana', visual: 'plano', filtro: 'streaming:globoplay', ativo: true },
  { titulo: 'Ultrafibra com *Paramount+* incluso', subtitulo: 'Mais velocidade e um streaming de filmes e séries sem pagar nada a mais.', selo: 'Oferta da semana', visual: 'plano', filtro: 'streaming:paramount', ativo: true },
  { titulo: 'Internet + celular *numa conta só*', subtitulo: 'Wi-Fi em casa e internet no chip, com desconto no pacote.', selo: 'Combos', visual: 'plano', filtro: 'tipo:combo-movel', ativo: true },
];
const ABAS_SLIDE = ['todos', 'internet', 'combo-tv', 'combo-movel', 'combo-completo'];
function normalizarSlide(x) {
  const img = String(x.imagem || '');
  return {
    titulo: String(x.titulo || '').trim().slice(0, 120),
    subtitulo: String(x.subtitulo || '').trim().slice(0, 220),
    selo: String(x.selo || '').trim().slice(0, 50),
    imagem: /^\/(images|uploads)\/[\w.-]+$/.test(img) || /^https:\/\//.test(img) ? img : '/images/banner-persona.webp',
    aba: ABAS_SLIDE.includes(x.aba) ? x.aba : 'todos',
    visual: x.visual === 'plano' ? 'plano' : 'persona',
    planoId: /^[a-f0-9]{12}$/.test(x.planoId || '') ? x.planoId : '',
    filtro: /^(streaming|tipo|operadora):[a-z-]+$/.test(x.filtro || '') ? x.filtro : '',
    ativo: x.ativo === undefined ? true : bool(x.ativo),
  };
}

// ---------- Streaming incluso nos planos ----------
const STREAMING = { globoplay: 'Globoplay', paramount: 'Paramount+', max: 'Max', netflix: 'Netflix', youtube: 'YouTube Premium', disney: 'Disney+', prime: 'Prime Video', deezer: 'Deezer', apple: 'Apple TV+' };

// Ajustes automáticos ao iniciar, sem apagar nada que a equipe já cadastrou.
function migrar() {
  // 1) logos oficiais e Vivo
  const ops = load('operadoras', []);
  let mudou = false;
  for (const padrao of OPERADORAS_PADRAO) {
    const o = ops.find((x) => x.id === padrao.id);
    if (!o) { ops.push(padrao); mudou = true; }
    else if (!o.logoUrl && padrao.logoUrl) { o.logoUrl = padrao.logoUrl; mudou = true; }
    if (o && o.siteOfertas === undefined) { o.siteOfertas = padrao.siteOfertas; mudou = true; }
  }
  if (mudou) save('operadoras', ops);
  // 1b) slides antigos (com as fotos antigas) viram os novos slides
  const slides = load('slides', []);
  if (slides.length && slides.every((x) => !x.visual && /garoto-/.test(x.imagem || ''))) save('slides', SLIDES_PADRAO);
  // 1c) foto recortada antiga do slide 1 vira o banner novo
  else if (slides.some((x) => x.imagem === '/images/persona-meio.webp')) save('slides', slides.map((x) => (x.imagem === '/images/persona-meio.webp' ? { ...x, imagem: '/images/banner-persona.webp' } : x)));
  // 2) os planos agora vêm dos sites das operadoras (lib/sync). O cadastro manual antigo fica guardado como backup.
  if (fs.existsSync(file('planos'))) {
    try { fs.renameSync(file('planos'), path.join(DATA_DIR, 'planos-manual-backup.json')); } catch {}
  }
}

function init() {
  if (!fs.existsSync(file('slides'))) save('slides', SLIDES_PADRAO);
  if (!fs.existsSync(file('operadoras'))) save('operadoras', OPERADORAS_PADRAO);
  if (!fs.existsSync(file('curadoria'))) save('curadoria', CURADORIA_PADRAO);
  if (!fs.existsSync(file('leads'))) save('leads', []);
  migrar();
}

const TIPOS = ['internet', 'combo-tv', 'combo-movel', 'combo-completo', 'movel', 'tv'];

// ---------- Curadoria do painel ----------
// O painel não cadastra mais planos: só escolhe o que destacar e, para a Nio, o preço nas cidades promocionais.
const CURADORIA_PADRAO = { destaques: {}, promoNio: {}, ocultos: {}, descontoPromoNio: 50 };
const bool = (v) => v === true || ['1', 'true', 'sim', 's', 'yes', 'x'].includes(String(v ?? '').trim().toLowerCase());
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const idPlano = (k) => /^[a-f0-9]{12}$/.test(String(k || ''));
function normalizarCuradoria(c) {
  const mapaBool = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => idPlano(k) && bool(v)).map(([k]) => [k, true]));
  const promo = Object.fromEntries(Object.entries((c && c.promoNio) || {}).map(([k, v]) => [k, num(v)]).filter(([k, v]) => idPlano(k) && v && v > 0));
  return {
    destaques: mapaBool(c && c.destaques),
    ocultos: mapaBool(c && c.ocultos),
    promoNio: promo,
    // desconto padrão (%) da Nio nas cidades promocionais; o site da Nio mostra "50% de desconto" nelas (nov/2026)
    descontoPromoNio: Math.min(90, Math.max(0, num(c && c.descontoPromoNio) ?? 50)),
  };
}
const curadoria = () => normalizarCuradoria(load('curadoria', CURADORIA_PADRAO));

function normalizarOperadora(o) {
  return {
    id: String(o.id || o.nome || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    nome: String(o.nome || '').trim(),
    cor: /^#[0-9a-f]{6}$/i.test(o.cor) ? o.cor : '#0F3A89',
    logoUrl: /^https:\/\//i.test(o.logoUrl || '') || /^\/(uploads|images\/operadoras)\/[\w.-]+(\?v=\d+)?$/.test(o.logoUrl || '') ? o.logoUrl : '',
    siteOfertas: /^https:\/\//i.test(o.siteOfertas || '') ? String(o.siteOfertas).slice(0, 300) : '',
    cobertura: /^(mcc:[a-z0-9-]+|todas|nenhuma)$/.test(o.cobertura) ? o.cobertura : 'nenhuma',
    linkContratacao: /^https:\/\//i.test(o.linkContratacao || '') ? o.linkContratacao : '',
    ativo: o.ativo === undefined ? true : bool(o.ativo),
  };
}

module.exports = { load, save, init, newId, normalizarOperadora, normalizarSlide, normalizarCuradoria, curadoria, STREAMING, TIPOS, DATA_DIR };
