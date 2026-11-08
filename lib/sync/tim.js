// TIM Ultrafibra: o site é um app Vue que lê os planos de arquivos JSON públicos.
//   https://internet.tim.com.br/json/plans.json  (tabela nacional)
//   https://internet.tim.com.br/json/sp.json     (tabela de São Paulo)
// Cada item traz velocidade, upload, preço cheio (price_full), preço (price) e preço com débito automático (price_with_dacc).
const { baixar, paraMbps, paraNumero, streamingDe, plano, unicos } = require('./comum');

const BASE = (process.env.TIM_BASE_URL || 'https://internet.tim.com.br').replace(/\/$/, '');
const ARQUIVOS = { br: 'plans.json', sp: 'sp.json' };
const SITE = 'https://internet.tim.com.br/';

function converter(lista, regiao) {
  return (Array.isArray(lista) ? lista : [])
    .filter((p) => p && p.active !== false && p.showOnLanding !== false && p.price)
    .map((p) => {
      const preco = paraNumero(p.price_full) || paraNumero(p.price);
      const promo = paraNumero(p.price_with_dacc) || paraNumero(p.price);
      const streaming = streamingDe((p.subscriptions || []).map((s) => s.subscription || s.slug));
      const movel = (p.mobilePlans || []).filter((m) => m.active !== false);
      const beneficios = [];
      if (p.plan_upload) beneficios.push(`Upload de ${String(p.plan_upload).replace(/\s*Mbps/i, ' Mega').replace(/\s*Gbps/i, ' Giga')}`);
      beneficios.push('Wi-Fi e instalação grátis');
      for (const m of movel) beneficios.push(`Chip ${m.plan_download} (${m.mobilePlanName})`);
      for (const i of p.infos || []) if (i && i.info) beneficios.push(String(i.info));
      const vel = paraMbps(p.plan_download) || paraMbps(p.plan);
      const nomeVel = vel >= 1000 ? `${vel / 1000} Giga` : `${vel} Mega`;
      const nome = ['TIM Ultrafibra', nomeVel, streaming.length ? '+ ' + (p.subscriptions || []).map((s) => s.subscription).join(' + ') : '', movel.length ? '+ Celular' : ''].filter(Boolean).join(' ');
      return plano('tim', p.sku || p.id, { // mesmo id nas tabelas BR e SP: o destaque do painel vale para as duas
        nome, tipo: movel.length ? 'combo-movel' : 'internet',
        velocidadeMbps: vel, uploadMbps: paraMbps(p.plan_upload),
        preco, precoPromo: promo < preco ? promo : null,
        mesesPromo: /12 meses/i.test((p.infos || []).map((i) => i.info).join(' ')) ? 12 : null,
        beneficios, streaming, selo: p.flag && p.flag !== 'region' ? String(p.flag) : '',
        linkContratacao: SITE, fonte: `${BASE}/json/${ARQUIVOS[regiao]}`,
      });
    })
    .filter((p) => p.velocidadeMbps && p.preco);
}

// regiao: 'br' (padrão) ou 'sp'
async function sincronizar(regiao = 'br') {
  const arq = ARQUIVOS[regiao] || ARQUIVOS.br;
  const lista = await baixar(`${BASE}/json/${arq}`, { tipo: 'json' });
  const planos = unicos(converter(lista, ARQUIVOS[regiao] ? regiao : 'br'));
  if (!planos.length) throw new Error('nenhum plano reconhecido em ' + arq);
  return planos;
}

module.exports = { sincronizar, converter, REGIOES: Object.keys(ARQUIVOS), SITE };
