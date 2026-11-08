// Vivo: a página de internet residencial (AEM) traz os cards renderizados no HTML.
//   https://vivo.com.br/para-voce/produtos-e-servicos/para-casa/internet
// Classes: unique-card (card), __plan (nome), __header-benefit-text-big (velocidade), __features-cobranded-title (brinde),
// total-card-price-value (preço), __price-description ("Após 1 ano: R$ 120/mês"), __label (selo).
// Cards "Fibra + TV" têm o preço dependente da TV escolhida (rádios); entram como combo-tv com o preço inicial.
const { baixar, paraMbps, paraNumero, texto, streamingDe, plano, unicos } = require('./comum');

const BASE = (process.env.VIVO_BASE_URL || 'https://vivo.com.br').replace(/\/$/, '');
const PAGINA = '/para-voce/produtos-e-servicos/para-casa/internet';

function cards(html) {
  // card = <div class="unique-card unique-card__bordered ..."> até o próximo card (ou fim)
  const partes = String(html).split(/(?=<div class="unique-card unique-card__bordered)/);
  return partes.slice(1).map((p) => p.slice(0, 40000));
}
const pega = (html, re) => { const m = html.match(re); return m ? texto(m[1]) : ''; };

function converterCard(html) {
  const nome = pega(html, /class="unique-card__plan"[^>]*>([\s\S]*?)<\/(?:h\d|p)>/);
  const velTxt = pega(html, /class="unique-card__header-benefit-text-big"[^>]*>([\s\S]*?)<\/span>/);
  const brinde = pega(html, /class="unique-card__features-cobranded-title[^"]*"[^>]*>([\s\S]*?)<\/p>/);
  const precoAttr = (html.match(/data-original-price="([\d.,]+)"/) || [])[1];
  const preco = paraNumero(precoAttr) || paraNumero(pega(html, /class="total-card-price-value"[^>]*>([\s\S]*?)<\/span>/));
  const depois = pega(html, /class="unique-card__price-description"[^>]*>([\s\S]*?)<\/p>/);
  const selo = pega(html, /class="unique-card__label[^"]*"[^>]*>([\s\S]*?)<\/p>/).replace(/^Oferta Recomendada\s*/i, '');
  const link = ((html.match(/<a class="btn-orange[^"]*"[^>]*href="([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
  const temTv = /Fibra \+ TV/i.test(nome) || /unique-card__benefit-benefit"[^>]*>\s*TV/i.test(html);
  const vel = paraMbps(velTxt);
  // "Após 1 ano: R$ 120/mês" => preço cheio 120, promocional = preço atual por 12 meses
  const cheio = /ap[óo]s/i.test(depois) ? paraNumero(depois.replace(/.*R\$/, 'R$')) : null;
  const beneficios = ['Wi-Fi e instalação inclusos'];
  if (brinde && !/gemini/i.test(brinde)) beneficios.unshift(brinde);
  else if (brinde) beneficios.push(brinde);
  if (temTv) beneficios.push('TV por assinatura (Vivo TV Avançado)');
  const streaming = streamingDe([brinde]);
  const mesesStreaming = streaming.length ? (brinde.match(/(\d+)\s*(ano|anos|m[eê]s|meses)/i) ? (/ano/i.test(brinde) ? 12 * Number(brinde.match(/(\d+)\s*ano/i)[1]) : Number(brinde.match(/(\d+)\s*m/i)[1])) : null) : null;
  const offers = (link.match(/offers=([^&]+)/) || [])[1] || (link.match(/productsIds=(\d+)/) || [])[1];
  const chave = offers ? `${temTv ? 'tv:' : ''}${offers}` : `${nome}|${velTxt}|${preco}|${brinde}`;
  return plano('vivo', chave, {
    nome: [temTv ? 'Vivo Fibra + TV' : (nome || 'Vivo Fibra'), velTxt, streaming.length ? '+ ' + brinde.replace(/^\d+\s*(ano|anos|meses?)\s*(de)?\s*/i, '').replace(/\s*(padr[aã]o )?com an[úu]ncios/i, '') : ''].filter(Boolean).join(' '),
    tipo: temTv ? 'combo-tv' : 'internet',
    velocidadeMbps: vel,
    preco: cheio && cheio > preco ? cheio : preco, precoPromo: cheio && cheio > preco ? preco : null, mesesPromo: cheio && cheio > preco ? 12 : null,
    beneficios, streaming, mesesStreaming, selo: /wi-?fi 7/i.test(selo) ? '' : selo,
    linkContratacao: link || BASE + PAGINA, fonte: BASE + PAGINA,
  });
}

function converter(html) {
  return unicos(cards(html).map(converterCard).filter((p) => p.velocidadeMbps && p.preco));
}

async function sincronizar() {
  const planos = converter(await baixar(BASE + PAGINA));
  if (!planos.length) throw new Error('nenhum card de plano reconhecido na página da Vivo');
  return planos;
}

module.exports = { sincronizar, converter, PAGINA };
