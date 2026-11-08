// Nio: a home (https://www.niointernet.com.br/) já vem com os cards renderizados no HTML.
// Cada card tem as classes new-home__plans-card__badge (nome), __speed (velocidade), __price-value (preço),
// __price-sub ("ou R$ 95/mês no cartão") e uma lista de benefícios; os com "--off" NÃO estão inclusos.
const { baixar, paraMbps, paraNumero, texto, plano, unicos } = require('./comum');

const BASE = (process.env.NIO_BASE_URL || 'https://www.niointernet.com.br').replace(/\/$/, '');

function cards(html) {
  const out = [];
  const re = /<article class="new-home__plans-card[^"]*"[\s\S]*?<\/article>/g;
  let m;
  while ((m = re.exec(html))) out.push(m[0]);
  return out;
}
const pega = (html, re) => { const m = html.match(re); return m ? texto(m[1]) : ''; };

function converterCard(html) {
  const nome = pega(html, /class="new-home__plans-card__badge"[^>]*>([\s\S]*?)<\/span>/);
  const velTxt = pega(html, /class="new-home__plans-card__speed"[^>]*>([\s\S]*?)<\/p>/); // primeira __speed é a da fibra
  const preco = paraNumero(pega(html, /class="new-home__plans-card__price-value"[^>]*>([\s\S]*?)<\/span>/));
  const sub = pega(html, /class="new-home__plans-card__price-sub"[^>]*>([\s\S]*?)<\/p>/);
  const cartao = /cart[aã]o/i.test(sub) ? paraNumero(sub) : null;
  const link = (html.match(/class="new-home__plans-card__link"[^>]*href="([^"]+)"/) || [])[1] || '';
  const chave = (html.match(/data-plan="([^"]+)"/) || [])[1] || (html.match(/\bplan="([^"]+)"/) || [])[1] || `${nome}-${velTxt}`;
  const beneficios = [];
  let streaming = [], mesesStreaming = null;
  for (const li of html.match(/<li class="new-home__plans-card__benefit[^"]*"[\s\S]*?<\/li>/g) || []) {
    if (/benefit--off/.test(li)) continue;
    const globo = /alt="Globoplay"|__globoplay/.test(li);
    const t = texto(li.replace(/<small>[\s\S]*?<\/small>/g, ''));
    if (globo) { streaming.push('globoplay'); const mm = t.match(/(\d+)\s*meses/); mesesStreaming = mm ? Number(mm[1]) : null; continue; }
    if (t) beneficios.push(t.replace(/\s+/g, ' '));
  }
  const chip = pega(html, /class="new-home__plans-card__chip-title"[^>]*>([\s\S]*?)<\/p>/);
  const tipo = chip ? 'combo-movel' : 'internet';
  if (chip) beneficios.push(chip.replace(/\s+/g, ' '));
  if (cartao && preco && cartao < preco) beneficios.push(`R$ ${cartao} pagando no cartão`);
  beneficios.push('Preço fixo até 2030');
  const vel = paraMbps(velTxt);
  return plano('nio', chave, {
    nome: [nome || 'Nio', velTxt, streaming.length ? '+ Globoplay' : '', chip ? '+ Chip 5G' : ''].filter(Boolean).join(' '),
    tipo, velocidadeMbps: vel, preco, beneficios, streaming, mesesStreaming,
    linkContratacao: link ? (link.startsWith('http') ? link : BASE + link) : BASE + '/',
    fonte: BASE + '/',
  });
}

function converter(html) {
  return unicos(cards(html).map(converterCard).filter((p) => p.velocidadeMbps && p.preco));
}

async function sincronizar() {
  const planos = converter(await baixar(BASE + '/'));
  if (!planos.length) throw new Error('nenhum card de plano reconhecido na home da Nio');
  return planos;
}

module.exports = { sincronizar, converter };
