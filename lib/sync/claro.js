// Claro: as páginas /internet e /multi (Next.js) listam cards cujos IDs ficam no __NEXT_DATA__.
// Os preços vêm de https://www.claro.com.br/api/catalog?state=UF&city=cidade&component=card_360&uuids=...
// e variam por cidade, por isso o catálogo da Claro é guardado por região ("RJ/rio_de_janeiro").
const { baixar, paraMbps, centavos, streamingDe, plano, unicos } = require('./comum');

const BASE = (process.env.CLARO_BASE_URL || 'https://www.claro.com.br').replace(/\/$/, '');
const PAGINAS = ['/internet', '/multi'];
const REGIAO_PADRAO = { uf: 'RJ', cidade: 'Rio de Janeiro' };

const slugCidade = (c) => String(c || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const chaveRegiao = (uf, cidade) => `${String(uf || '').toUpperCase()}/${slugCidade(cidade)}`;

// IDs (uuids) dos componentes card_360 presentes no HTML da página
function extrairUuids(html) {
  const m = String(html).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  let nd; try { nd = JSON.parse(m[1]); } catch { return []; }
  const ids = [];
  (function anda(o) {
    if (!o || typeof o !== 'object') return;
    if (o.component === 'card_360' && o.data && Array.isArray(o.data.data)) for (const c of o.data.data) if (c && c._uid) ids.push(c._uid);
    for (const k in o) anda(o[k]);
  })(nd);
  return [...new Set(ids)];
}

const STREAM_RE = /globoplay|paramount|\bmax\b|hbo|netflix|youtube|disney|amazon prime|prime video|deezer|apple/i;
const nomeParte = (p) => (p && (p.nome || p.nomeAutomatico)) || '';
const precoParte = (p) => centavos(p.precoCombo ?? p.preco);

function converterItem(item, regiao) {
  const c = item && item.catalog;
  if (!c || c.notFound || !c.internet) return null;
  const net = c.internet;
  const partes = { tv: c.tv, celular: c.celular };
  const tem = (k) => partes[k] && typeof partes[k] === 'object' && partes[k].id;
  const tipo = tem('tv') && tem('celular') ? 'combo-completo' : tem('tv') ? 'combo-tv' : tem('celular') ? 'combo-movel' : 'internet';
  const preco = [net, tem('tv') && c.tv, tem('celular') && c.celular].filter(Boolean).reduce((a, p) => a + (precoParte(p) || 0), 0);
  const precoDe = [net, tem('tv') && c.tv, tem('celular') && c.celular].filter(Boolean).reduce((a, p) => a + (centavos(p.precoDe ?? p.preco) || 0), 0);
  const recursos = Object.values(net.recursos || {}).map((r) => r.nome).filter(Boolean);
  const streaming = streamingDe(recursos.filter((r) => STREAM_RE.test(r)).concat(tem('celular') ? Object.values(c.celular.recursos || {}).map((r) => r.nome).filter((r) => STREAM_RE.test(r)) : []));
  const desc = net.recursosDescritivos || {};
  const upload = desc['604'] && paraMbps(desc['604'].description);
  const beneficios = recursos.filter((r) => !STREAM_RE.test(r) && !/claro v[ií]deo|skeelo|mcafee|busuu|claro banca/i.test(r));
  if (upload) beneficios.unshift(`Upload de ${upload >= 1000 ? upload / 1000 + ' Giga' : upload + ' Mega'}`);
  if (tem('celular')) beneficios.push(`Celular ${nomeParte(c.celular)}`);
  if (tem('tv')) beneficios.push(`TV ${nomeParte(c.tv)}`);
  const vel = paraMbps(desc['602'] && desc['602'].description) || paraMbps(nomeParte(net));
  const nome = ['Claro Fibra', nomeParte(net), tem('celular') ? `+ Celular ${nomeParte(c.celular)}` : '', tem('tv') ? '+ TV' : ''].filter(Boolean).join(' ');
  const chave = `${net.id}${tem('celular') ? '+c' + c.celular.id : ''}${tem('tv') ? '+t' + c.tv.id : ''}`; // sem a região: o mesmo plano em outra cidade mantém o id
  return plano('claro', chave, {
    nome, tipo, velocidadeMbps: vel, uploadMbps: upload || null,
    preco: precoDe > preco ? precoDe : preco, precoPromo: precoDe > preco ? preco : null,
    beneficios, streaming,
    selo: (item.chips || []).map((x) => x.children).filter(Boolean)[0] || (net.isLimitedTimeOffer ? 'Oferta por tempo limitado' : ''),
    linkContratacao: `${BASE}/internet`, fonte: `${BASE}/api/catalog`,
  });
}

function converter(resposta, regiao) {
  return unicos(((resposta && resposta.data) || []).map((it) => converterItem(it, regiao)).filter((p) => p && p.velocidadeMbps && p.preco));
}

async function sincronizar(uf = REGIAO_PADRAO.uf, cidade = REGIAO_PADRAO.cidade) {
  const uuids = [];
  for (const pag of PAGINAS) {
    try { uuids.push(...extrairUuids(await baixar(BASE + pag))); } catch (e) { if (pag === '/internet') throw e; }
  }
  if (!uuids.length) throw new Error('não achei os cards de planos na página da Claro');
  const regiao = chaveRegiao(uf, cidade);
  const [state, city] = regiao.split('/');
  const planos = [];
  for (let i = 0; i < uuids.length; i += 12) {
    const lote = uuids.slice(i, i + 12);
    const r = await baixar(`${BASE}/api/catalog?state=${state}&city=${city}&environment=public&component=card_360&uuids=${lote.join(',')}&editMode=false`, { tipo: 'json' });
    planos.push(...converter(r, regiao));
  }
  const lista = unicos(planos);
  if (!lista.length) throw new Error('catálogo da Claro vazio para ' + regiao);
  return lista;
}

module.exports = { sincronizar, converter, extrairUuids, chaveRegiao, slugCidade, REGIAO_PADRAO };
