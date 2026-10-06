// Armazenamento simples em arquivos JSON (planos, operadoras e contatos).
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
  { id: 'claro', nome: 'Claro', cor: '#E3262E', logoUrl: '', cobertura: 'mcc:ceps-claro', linkContratacao: '', siteOfertas: 'https://www.claro.com.br/internet', ativo: true },
  { id: 'nio', nome: 'Nio', cor: '#6C2BD9', logoUrl: '', cobertura: 'mcc:ceps-nio', linkContratacao: '', siteOfertas: 'https://www.niointernet.com.br/', ativo: true },
  { id: 'tim', nome: 'TIM', cor: '#004691', logoUrl: '', cobertura: 'mcc:ceps-tim', linkContratacao: '', siteOfertas: 'https://internet.tim.com.br/', ativo: true },
];

// Planos de EXEMPLO: preços e velocidades fictícios, para testar o site. Substitua pelo painel.
const PLANOS_EXEMPLO = [
  { operadoraId: 'claro', nome: 'Exemplo Claro 500 Mega', tipo: 'internet', velocidadeMbps: 500, preco: 119.9, precoPromo: 99.9, mesesPromo: 6, beneficios: ['Wi-Fi incluso', 'Instalação grátis'], destaque: true, apenasCidadePromo: false },
  { operadoraId: 'claro', nome: 'Exemplo Claro 1 Giga Promo', tipo: 'internet', velocidadeMbps: 1000, preco: 159.9, precoPromo: 119.9, mesesPromo: 12, beneficios: ['Wi-Fi 6', 'Oferta de cidade promocional'], destaque: false, apenasCidadePromo: true },
  { operadoraId: 'nio', nome: 'Exemplo Nio 600 Mega', tipo: 'internet', velocidadeMbps: 600, preco: 109.9, precoPromo: null, mesesPromo: null, beneficios: ['Sem fidelidade'], destaque: true, apenasCidadePromo: false },
  { operadoraId: 'tim', nome: 'Exemplo TIM Ultrafibra 1 Giga', tipo: 'internet', velocidadeMbps: 1000, preco: 149.9, precoPromo: 129.9, mesesPromo: 3, beneficios: ['Wi-Fi incluso'], destaque: true, apenasCidadePromo: false },
  { operadoraId: 'claro', nome: 'Exemplo Claro Internet + TV', tipo: 'combo-tv', velocidadeMbps: 500, preco: 199.9, precoPromo: 179.9, mesesPromo: 6, beneficios: ['Canais abertos e fechados', 'App de TV'], destaque: false, apenasCidadePromo: false },
  { operadoraId: 'tim', nome: 'Exemplo TIM Internet + Celular', tipo: 'combo-movel', velocidadeMbps: 500, preco: 169.9, precoPromo: 149.9, mesesPromo: 6, beneficios: ['Chip com 25 GB', 'Ligações ilimitadas'], destaque: false, apenasCidadePromo: false },
  { operadoraId: 'claro', nome: 'Exemplo Claro Combo Completo', tipo: 'combo-completo', velocidadeMbps: 1000, preco: 279.9, precoPromo: 249.9, mesesPromo: 12, beneficios: ['TV com app', 'Chip com 30 GB', 'Wi-Fi 6'], destaque: true, apenasCidadePromo: false },
];

// ---------- Slides do topo ----------
// No título, o trecho entre *asteriscos* aparece em destaque (ciano).
const SLIDES_PADRAO = [
  { titulo: 'Encontre o *melhor plano* de internet em sua cidade', subtitulo: 'Digite o seu CEP abaixo, compare e escolha a internet ideal para a sua casa', selo: 'Internet residencial, TV e celular', imagem: '/images/garoto-hero.webp', aba: 'todos', ativo: true },
  { titulo: 'Internet fibra com *Globoplay* incluso', subtitulo: 'Planos com novelas, séries e esportes já inclusos na mensalidade. Veja se chegam no seu endereço.', selo: 'Streaming incluso', imagem: '/images/garoto-atendimento.webp', aba: 'todos', ativo: true },
  { titulo: 'Ultrafibra com *Paramount+* incluso', subtitulo: 'Mais velocidade e um streaming de filmes e séries sem pagar nada a mais.', selo: 'Streaming incluso', imagem: '/images/garoto-corpo.webp', aba: 'internet', ativo: true },
  { titulo: 'Internet + celular *numa conta só*', subtitulo: 'Wi-Fi em casa e internet no chip, com desconto no pacote. Compare os combos da sua região.', selo: 'Combos', imagem: '/images/garoto-hero.webp', aba: 'combo-movel', ativo: true },
];
const ABAS_SLIDE = ['todos', 'internet', 'combo-tv', 'combo-movel', 'combo-completo'];
function normalizarSlide(x) {
  const img = String(x.imagem || '');
  return {
    titulo: String(x.titulo || '').trim().slice(0, 120),
    subtitulo: String(x.subtitulo || '').trim().slice(0, 220),
    selo: String(x.selo || '').trim().slice(0, 50),
    imagem: /^\/(images|uploads)\/[\w.-]+$/.test(img) || /^https:\/\//.test(img) ? img : '/images/garoto-hero.webp',
    aba: ABAS_SLIDE.includes(x.aba) ? x.aba : 'todos',
    ativo: x.ativo === undefined ? true : bool(x.ativo),
  };
}

// ---------- Streaming incluso nos planos ----------
const STREAMING = { globoplay: 'Globoplay', paramount: 'Paramount+', max: 'Max', netflix: 'Netflix', youtube: 'YouTube Premium', disney: 'Disney+', prime: 'Prime Video', deezer: 'Deezer', apple: 'Apple TV+' };

function init() {
  if (!fs.existsSync(file('slides'))) save('slides', SLIDES_PADRAO);
  if (!fs.existsSync(file('operadoras'))) save('operadoras', OPERADORAS_PADRAO);
  if (!fs.existsSync(file('planos'))) {
    const agora = new Date().toISOString();
    save('planos', PLANOS_EXEMPLO.map((p, i) => normalizarPlano({ ...p, id: newId(), ativo: true, ordem: i, atualizadoEm: agora })));
  }
  if (!fs.existsSync(file('leads'))) save('leads', []);
}

// ---------- Validação de planos ----------
const TIPOS = ['internet', 'combo-tv', 'combo-movel', 'combo-completo', 'movel', 'tv'];
const APELIDOS_TIPO = { combo: 'combo-tv', 'internet+tv': 'combo-tv', 'internet+celular': 'combo-movel', completo: 'combo-completo', celular: 'movel' };
const tipoValido = (t) => { const v = String(t || '').trim().toLowerCase().replace(/\s+/g, ''); const x = APELIDOS_TIPO[v] || v; return TIPOS.includes(x) ? x : 'internet'; };
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const bool = (v) => v === true || ['1', 'true', 'sim', 's', 'yes', 'x'].includes(String(v ?? '').trim().toLowerCase());

function normalizarPlano(p) {
  const beneficios = Array.isArray(p.beneficios)
    ? p.beneficios
    : String(p.beneficios || '').split(/[|;\n]/);
  return {
    id: p.id || newId(),
    operadoraId: String(p.operadoraId || '').trim().toLowerCase(),
    nome: String(p.nome || '').trim(),
    tipo: tipoValido(p.tipo),
    velocidadeMbps: num(p.velocidadeMbps),
    preco: num(p.preco),
    precoPromo: num(p.precoPromo),
    mesesPromo: num(p.mesesPromo),
    beneficios: beneficios.map((b) => String(b).trim()).filter(Boolean).slice(0, 8),
    streaming: (Array.isArray(p.streaming) ? p.streaming : String(p.streaming || '').split(/[|;,\s]+/))
      .map((x) => String(x).trim().toLowerCase().replace(/[^a-z]/g, '')).map((x) => (x === 'paramountplus' ? 'paramount' : x === 'youtubepremium' ? 'youtube' : x))
      .filter((x, i, a) => STREAMING[x] && a.indexOf(x) === i),
    mesesStreaming: num(p.mesesStreaming),
    destaque: bool(p.destaque),
    ativo: p.ativo === undefined ? true : bool(p.ativo),
    apenasCidadePromo: bool(p.apenasCidadePromo),
    linkContratacao: String(p.linkContratacao || '').trim(),
    ordem: num(p.ordem) ?? 0,
    atualizadoEm: p.atualizadoEm || new Date().toISOString(),
  };
}

function validarPlano(p, operadoras) {
  const erros = [];
  if (!p.nome) erros.push('nome é obrigatório');
  if (!operadoras.some((o) => o.id === p.operadoraId)) erros.push(`operadora "${p.operadoraId}" não existe`);
  if (p.preco === null || p.preco <= 0) erros.push('preço inválido');
  if (p.precoPromo !== null && p.precoPromo >= p.preco) erros.push('preço promocional deve ser menor que o preço');
  if (p.linkContratacao && !/^https:\/\//i.test(p.linkContratacao)) erros.push('link de contratação deve começar com https://');
  return erros;
}

function normalizarOperadora(o) {
  return {
    id: String(o.id || o.nome || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    nome: String(o.nome || '').trim(),
    cor: /^#[0-9a-f]{6}$/i.test(o.cor) ? o.cor : '#0F3A89',
    logoUrl: /^https:\/\//i.test(o.logoUrl || '') || /^\/uploads\/[\w.-]+(\?v=\d+)?$/.test(o.logoUrl || '') ? o.logoUrl : '',
    siteOfertas: /^https:\/\//i.test(o.siteOfertas || '') ? String(o.siteOfertas).slice(0, 300) : '',
    cobertura: /^(mcc:[a-z0-9-]+|todas|nenhuma)$/.test(o.cobertura) ? o.cobertura : 'nenhuma',
    linkContratacao: /^https:\/\//i.test(o.linkContratacao || '') ? o.linkContratacao : '',
    ativo: o.ativo === undefined ? true : bool(o.ativo),
  };
}

module.exports = { load, save, init, newId, normalizarPlano, validarPlano, normalizarOperadora, normalizarSlide, STREAMING, TIPOS, DATA_DIR };
