// Relatório do painel de tráfego: junta gasto (Google/Meta), funil do DataCrazy e cliques do site.
const store = require('./store');
const gasto = require('./gasto');
const funil = require('./funil');
const { VERSAO_SCRIPT } = require('./script-google');

const CANAIS = ['google', 'meta', 'disparos', 'outros'];
const dia = (iso) => (iso ? new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10) : '');
const hoje = () => dia(new Date().toISOString());
const somaDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5) + 1;
const div = (a, b) => (b ? a / b : null);
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

const CONFIG_PADRAO = { receitaPorVenda: 200, metaVendasMes: 0, metaCpv: 100, metaCpl: 30, orcamentoMes: 0 };
const config = () => ({ ...CONFIG_PADRAO, ...store.load('trafego-config', {}) });
function salvarConfig(b) {
  const c = config();
  for (const k of Object.keys(CONFIG_PADRAO)) if (b[k] != null && b[k] !== '') { const n = Number(b[k]); if (Number.isFinite(n) && n >= 0) c[k] = n; }
  store.save('trafego-config', c);
  return c;
}

const vazio = () => ({ gasto: 0, impressoes: 0, cliques: 0, convPlataforma: 0, enviados: 0, leads: 0, vendas: 0, instalados: 0, pagos: 0, semCobertura: 0 });
function kpis(t, cfg) {
  return { ...t, gasto: r2(t.gasto), cpl: r2(div(t.gasto, t.leads)), cpv: r2(div(t.gasto, t.vendas)), cpi: r2(div(t.gasto, t.instalados)), receita: r2(t.vendas * cfg.receitaPorVenda), roas: r2(div(t.vendas * cfg.receitaPorVenda, t.gasto)), taxaVenda: r2(div(t.vendas * 100, t.leads)) };
}

function numeros(de, ate, linhasGasto, leads) {
  const por = Object.fromEntries(CANAIS.map((c) => [c, vazio()]));
  const dentro = (d) => d && d >= de && d <= ate;
  for (const g of linhasGasto) {
    if (!dentro(g.data) || !por[g.canal]) continue;
    const t = por[g.canal];
    t.gasto += g.gasto; t.impressoes += g.impressoes; t.cliques += g.cliques; t.convPlataforma += g.conversoes;
  }
  for (const l of leads) {
    const t = por[l.origem] || por.outros;
    if (l.origem === 'disparos') { if (dentro(dia(l.criado))) t.enviados++; if (funil.respondeu(l) && dentro(dia(funil.quandoRespondeu(l)))) t.leads++; }
    else if (dentro(dia(l.criado))) t.leads++;
    if (dentro(dia(l.passos.venda))) t.vendas++;
    if (dentro(dia(l.passos.instalado))) t.instalados++;
    if (dentro(dia(l.passos.pago))) t.pagos++;
    if (l.perdido && /viabilidade/i.test(l.perdido) && dentro(dia(l.perdidoEm))) t.semCobertura++;
  }
  const total = vazio();
  for (const c of CANAIS) for (const k of Object.keys(total)) total[k] += por[c][k];
  return { ...por, total };
}

function relatorio(de, ate) {
  const cfg = config();
  ate = ate || hoje();
  de = de || somaDias(ate, -6);
  if (de > ate) [de, ate] = [ate, de];
  const n = Math.min(diasEntre(de, ate), 400);
  const linhasGasto = gasto.linhas();
  const leads = funil.leads();
  const atual = numeros(de, ate, linhasGasto, leads);
  const antDe = somaDias(de, -n); const antAte = somaDias(de, -1);
  const anterior = numeros(antDe, antAte, linhasGasto, leads);
  const canais = {};
  for (const c of [...CANAIS, 'total']) canais[c] = { ...kpis(atual[c], cfg), anterior: kpis(anterior[c], cfg) };

  // série diária
  const serie = [];
  for (let i = 0; i < n; i++) {
    const d = somaDias(de, i);
    serie.push({ data: d, gasto: { google: 0, meta: 0, disparos: 0 }, leads: { google: 0, meta: 0, disparos: 0, outros: 0 }, vendas: { google: 0, meta: 0, disparos: 0, outros: 0 } });
  }
  const idx = Object.fromEntries(serie.map((s, i) => [s.data, i]));
  for (const g of linhasGasto) if (idx[g.data] != null && serie[idx[g.data]].gasto[g.canal] != null) serie[idx[g.data]].gasto[g.canal] = r2(serie[idx[g.data]].gasto[g.canal] + g.gasto);
  for (const l of leads) {
    const o = CANAIS.includes(l.origem) ? l.origem : 'outros';
    const dc = funil.respondeu(l) ? idx[dia(funil.quandoRespondeu(l))] : null; if (dc != null) serie[dc].leads[o]++;
    const dv = idx[dia(l.passos.venda)]; if (dv != null) serie[dv].vendas[o]++;
  }

  // funil (coorte: leads que chegaram no período e até onde foram)
  const funilCanal = {};
  for (const c of [...CANAIS, 'total']) funilCanal[c] = { passos: funil.PASSOS.map(() => 0), perdidos: 0, semCobertura: 0 };
  for (const l of leads) {
    if (!(dia(l.criado) >= de && dia(l.criado) <= ate)) continue;
    if (!funil.respondeu(l)) continue; // disparo sem resposta não entra no funil
    for (const c of [CANAIS.includes(l.origem) ? l.origem : 'outros', 'total']) {
      const f = funilCanal[c];
      for (let i = 0; i <= l.passo; i++) f.passos[i]++;
      if (l.perdido) { f.perdidos++; if (/viabilidade/i.test(l.perdido)) f.semCobertura++; }
    }
  }

  // campanhas (dados da plataforma) + vendas do CRM ligadas pelo código do Google
  const cliques = store.load('ads-cliques', {});
  const crmPorCampanha = {};
  for (const l of leads) {
    if (l.origem !== 'google' || !l.ref) continue;
    const c = cliques[l.ref]; const camp = c && (c.utm_campaign || '');
    if (!camp) continue;
    const k = funil.norm(camp);
    crmPorCampanha[k] = crmPorCampanha[k] || { leads: 0, vendas: 0 };
    if (dia(l.criado) >= de && dia(l.criado) <= ate) crmPorCampanha[k].leads++;
    if (dia(l.passos.venda) >= de && dia(l.passos.venda) <= ate) crmPorCampanha[k].vendas++;
  }
  const camps = {};
  for (const g of linhasGasto) {
    if (!(g.data >= de && g.data <= ate)) continue;
    const k = g.canal + '|' + g.campanhaId;
    const c = camps[k] || (camps[k] = { canal: g.canal, campanhaId: g.campanhaId, campanha: g.campanha, status: g.status, gasto: 0, impressoes: 0, cliques: 0, conversoes: 0, ultimaData: '' });
    c.gasto += g.gasto; c.impressoes += g.impressoes; c.cliques += g.cliques; c.conversoes += g.conversoes;
    if (g.data >= c.ultimaData) { c.ultimaData = g.data; c.campanha = g.campanha; c.status = g.status || c.status; }
  }
  const campanhas = Object.values(camps).map((c) => {
    const crm = crmPorCampanha[funil.norm(c.campanhaId)] || crmPorCampanha[funil.norm(c.campanha)] || null;
    return { ...c, gasto: r2(c.gasto), conversoes: r2(c.conversoes), ctr: r2(div(c.cliques * 100, c.impressoes)), cpc: r2(div(c.gasto, c.cliques)), custoConv: r2(div(c.gasto, c.conversoes)), leadsCrm: crm ? crm.leads : null, vendasCrm: crm ? crm.vendas : null, cpvCrm: crm && crm.vendas ? r2(c.gasto / crm.vendas) : null };
  }).sort((a, b) => b.gasto - a.gasto);

  // termos de pesquisa que gastaram e não converteram
  const tg = gasto.termosGoogle();
  const termosSemConversao = tg ? tg.termos.filter((t) => !t.conversoes && t.gasto > 0).sort((a, b) => b.gasto - a.gasto).slice(0, 25) : [];

  // meta do mês
  const mesIni = hoje().slice(0, 8) + '01';
  const mes = numeros(mesIni, hoje(), linhasGasto, leads).total;
  const diasMes = new Date(Date.UTC(+hoje().slice(0, 4), +hoje().slice(5, 7), 0)).getUTCDate();
  const passados = Number(hoje().slice(8, 10));
  const metaMes = { vendas: mes.vendas, gasto: r2(mes.gasto), metaVendas: cfg.metaVendasMes, orcamento: cfg.orcamentoMes, previsaoVendas: Math.round((mes.vendas / passados) * diasMes), previsaoGasto: r2((mes.gasto / passados) * diasMes), diasPassados: passados, diasMes };

  const busca = pesquisa(de, ate, linhasGasto, cfg, canais);
  return { pesquisa: busca, de, ate, dias: n, anteriorDe: antDe, anteriorAte: antAte, config: cfg, canais, serie, funil: { passos: funil.PASSOS.map((p) => funil.ROTULOS[p]), canais: funilCanal }, campanhas, termosSemConversao, metaMes, alertas: alertas(canais, cfg), conexoes: conexoes() };
}

// ---------- Rede de pesquisa (Google): domínio do leilão e recomendações ----------
const UFS = { acre: 'AC', alagoas: 'AL', amapa: 'AP', amazonas: 'AM', bahia: 'BA', ceara: 'CE', 'federal district': 'DF', 'espirito santo': 'ES', goias: 'GO', maranhao: 'MA', 'mato grosso': 'MT', 'mato grosso do sul': 'MS', 'minas gerais': 'MG', para: 'PA', paraiba: 'PB', parana: 'PR', pernambuco: 'PE', piaui: 'PI', 'rio de janeiro': 'RJ', 'rio grande do norte': 'RN', 'rio grande do sul': 'RS', rondonia: 'RO', roraima: 'RR', 'santa catarina': 'SC', 'sao paulo': 'SP', sergipe: 'SE', tocantins: 'TO' };
// "Sete Lagoas,State of Minas Gerais,Brazil" → "Sete Lagoas/MG"
function nomeCidade(n) {
  const p = String(n || '').split(',').map((x) => x.trim()).filter((x) => x && x !== 'Brazil');
  if (p.length < 2) return p[0] || String(n || '');
  const uf = UFS[funil.norm(p[p.length - 1].replace(/^State of /i, ''))];
  return uf ? `${p[0]}/${uf}` : p.join(', ');
}
const pc = (x) => (x == null ? null : Math.round(x * 1000) / 10); // fração → %
function pesquisa(de, ate, linhasGasto, cfg, canais) {
  const porCamp = {};
  const tot = { imp: 0, parcela: 0, perdidaOrcamento: 0, perdidaRanking: 0, topo: 0, topoAbsoluto: 0, gasto: 0, dias: new Set() };
  for (const g of linhasGasto) {
    if (g.canal !== 'google' || g.data < de || g.data > ate || g.parcela == null) continue;
    const w = g.impBusca || g.impressoes || 0;
    if (!w) continue;
    const c = porCamp[g.campanhaId] || (porCamp[g.campanhaId] = { campanhaId: g.campanhaId, campanha: g.campanha, imp: 0, parcela: 0, perdidaOrcamento: 0, perdidaRanking: 0, topo: 0, topoAbsoluto: 0, gasto: 0 });
    for (const x of [c, tot]) { x.imp += w; x.gasto += g.gasto; for (const k of ['parcela', 'perdidaOrcamento', 'perdidaRanking', 'topo', 'topoAbsoluto']) x[k] += (g[k] || 0) * w; }
    tot.dias.add(g.data);
  }
  const media = (x) => ({ parcela: pc(div(x.parcela, x.imp)), perdidaOrcamento: pc(div(x.perdidaOrcamento, x.imp)), perdidaRanking: pc(div(x.perdidaRanking, x.imp)), topo: pc(div(x.topo, x.imp)), topoAbsoluto: pc(div(x.topoAbsoluto, x.imp)) });
  const resumo = tot.imp ? media(tot) : null;
  const campanhas = Object.values(porCamp).map((c) => ({ campanhaId: c.campanhaId, campanha: c.campanha, gasto: r2(c.gasto), ...media(c) })).sort((a, b) => b.gasto - a.gasto);
  const kw = gasto.palavrasGoogle();
  const palavras = kw ? kw.palavras.map((k) => ({ ...k, gasto: r2(k.gasto), cpa: r2(div(k.gasto, k.conversoes)), ctr: r2(div(k.cliques * 100, k.impressoes)), parcela: pc(k.parcela), perdidaRanking: pc(k.perdidaRanking), topoAbsoluto: pc(k.topoAbsoluto) })).sort((a, b) => b.gasto - a.gasto) : [];
  const cg = gasto.cidadesGoogle();
  const cidades = cg ? cg.cidades.map((c) => ({ ...c, nome: nomeCidade(c.nome), gasto: r2(c.gasto), cpa: r2(div(c.gasto, c.conversoes)) })).sort((a, b) => b.gasto - a.gasto) : [];
  const termos = (gasto.termosGoogle() || { termos: [] }).termos;
  return { resumo, campanhas, palavras: palavras.slice(0, 200), cidades: cidades.slice(0, 200), palavrasEm: kw && kw.em, cidadesEm: cg && cg.em, recomendacoes: recomendacoes({ resumo, campanhas, palavras, cidades, termos, cfg, google: canais.google, dias: tot.dias.size, gasto: tot.gasto }) };
}

function recomendacoes({ resumo, palavras, cidades, termos, cfg, google, dias, gasto: gastoBusca }) {
  const r = [];
  const cpl = cfg.metaCpl || 30;
  const real = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');
  const cpvOk = !google.vendas || !cfg.metaCpv || google.cpv <= cfg.metaCpv;
  if (resumo) {
    if (resumo.perdidaOrcamento >= 10) {
      const diario = dias ? gastoBusca / dias : 0;
      const fator = resumo.parcela ? (resumo.parcela + resumo.perdidaOrcamento) / resumo.parcela : 1;
      r.push({ prioridade: cpvOk ? 1 : 2, tipo: 'Orçamento', texto: `Você perde ${resumo.perdidaOrcamento}% das buscas por falta de verba.` + (cpvOk ? ` Com o custo por venda dentro da meta, vale aumentar o orçamento: para cobrir essas buscas, o gasto diário iria de cerca de ${real(diario)} para ${real(diario * fator)}.` : ' Antes de aumentar, baixe o custo por venda (está acima da meta).') });
    }
    if (resumo.perdidaRanking >= 30) r.push({ prioridade: 1, tipo: 'Posição', texto: `Você perde ${resumo.perdidaRanking}% dos leilões por posição (lance ou qualidade do anúncio). Para dominar a pesquisa: suba o teto de CPC nas palavras que dão lead e melhore os anúncios das palavras com qualidade baixa.` });
    if (resumo.topoAbsoluto != null && resumo.topoAbsoluto < 30 && resumo.parcela > 0) r.push({ prioridade: 2, tipo: 'Topo da página', texto: `O seu anúncio aparece em 1º lugar só ${resumo.topoAbsoluto}% das vezes. A 1ª posição concentra a maior parte dos cliques em buscas com intenção de compra.` });
  }
  const vencedoras = palavras.filter((k) => k.conversoes >= 1 && k.cpa != null && k.cpa <= cpl * 0.7 && k.perdidaRanking >= 20).slice(0, 5);
  for (const k of vencedoras) r.push({ prioridade: 1, tipo: 'Palavra vencedora', texto: `"${k.palavra}" traz lead a ${real(k.cpa)} mas perde ${k.perdidaRanking}% dos leilões por posição. Aumente o lance dessa palavra em 20% a 30%.` });
  const ralos = palavras.filter((k) => !k.conversoes && k.gasto >= cpl * 2).slice(0, 5);
  for (const k of ralos) r.push({ prioridade: 1, tipo: 'Palavra sem resultado', texto: `"${k.palavra}" (${k.grupo}) gastou ${real(k.gasto)} em 30 dias sem nenhum lead. Pause ou troque para correspondência exata.` });
  const baixaQual = palavras.filter((k) => k.qualidade && k.qualidade <= 4 && k.gasto > 0).slice(0, 5);
  if (baixaQual.length) r.push({ prioridade: 2, tipo: 'Índice de qualidade', texto: `Palavras com qualidade baixa (pagam mais caro por clique): ${baixaQual.map((k) => `"${k.palavra}" (${k.qualidade}/10)`).join(', ')}. Coloque a palavra no título do anúncio e na página.` });
  const neg = termos.filter((t) => !t.conversoes && t.gasto >= cpl * 0.5).sort((a, b) => b.gasto - a.gasto).slice(0, 8);
  if (neg.length) r.push({ prioridade: 2, tipo: 'Palavras negativas', texto: `Termos que gastaram sem gerar lead: ${neg.map((t) => `"${t.termo}" (${real(t.gasto)})`).join(', ')}. Adicione como palavras negativas.` });
  const cidRuins = cidades.filter((c) => !c.conversoes && c.gasto >= cpl * 2).slice(0, 5);
  if (cidRuins.length) r.push({ prioridade: 2, tipo: 'Cidades', texto: `Cidades com gasto e nenhum lead: ${cidRuins.map((c) => `${c.nome} (${real(c.gasto)})`).join('; ')}. Reduza o lance ou exclua.` });
  const cidBoas = cidades.filter((c) => c.conversoes >= 2 && c.cpa <= cpl * 0.7).slice(0, 5);
  if (cidBoas.length) r.push({ prioridade: 3, tipo: 'Cidades', texto: `Cidades com lead barato: ${cidBoas.map((c) => `${c.nome} (${real(c.cpa)}/lead)`).join('; ')}. Aumente o lance nelas em 20%.` });
  return r.sort((a, b) => a.prioridade - b.prioridade).slice(0, 15);
}

function conexoes() {
  const g = gasto.status();
  const f = funil.status();
  let dc = null; try { dc = require('./datacrazy').resumo(); } catch { /* sem DataCrazy */ }
  return { google: g.google, meta: g.meta, funil: f, datacrazy: dc, termosEm: (gasto.termosGoogle() || {}).em || null };
}

function alertas(canais, cfg) {
  const a = [];
  const c = conexoes();
  const horas = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600e3 : Infinity);
  if (horas(c.google.ultima) > 3) a.push({ nivel: 'aviso', texto: c.google.ultima ? 'O script do Google Ads não envia dados há mais de 3 horas.' : 'O script do Google Ads ainda não foi instalado (sem gasto do Google).' });
  if (c.google.ultima && (c.google.versao || 1) < VERSAO_SCRIPT) a.push({ nivel: 'aviso', texto: 'Há uma versão nova do script do Google Ads (com parcela de impressões, palavras e cidades). Em Metas e conexões, clique em "Ver script do Google Ads" e troque o texto no Google Ads.' });
  if (!c.meta.configurado) a.push({ nivel: 'aviso', texto: 'Meta ainda não conectado: falta o token da BM (META_TOKEN no Railway). Ele traz o gasto dos anúncios e o custo dos disparos da API do WhatsApp.' });
  else if (c.meta.erro) a.push({ nivel: 'erro', texto: 'Erro ao ler o Meta Ads: ' + c.meta.erro });
  if (c.datacrazy && c.datacrazy.ultimoErro && horas(c.datacrazy.ultimoErro.em) < 24) a.push({ nivel: 'erro', texto: `DataCrazy: erro ao preencher o lead/negócio (${c.datacrazy.ultimoErro.onde}): ${c.datacrazy.ultimoErro.erro}` });
  if (c.datacrazy && c.datacrazy.hoje && c.datacrazy.hoje.semTelefone) a.push({ nivel: 'aviso', texto: `DataCrazy: ${c.datacrazy.hoje.semTelefone} mensagem(ns) do site hoje sem telefone do cliente na conversa; plano e endereço não foram gravados.` });
  if (!c.funil || !c.funil.completo) a.push({ nivel: 'info', texto: 'Carregando o histórico de negócios do DataCrazy; os números do funil ainda podem estar incompletos.' });
  for (const k of ['google', 'meta']) {
    const x = canais[k];
    if (cfg.metaCpv && x.vendas && x.cpv > cfg.metaCpv) a.push({ nivel: 'erro', texto: `${k === 'google' ? 'Google' : 'Meta'}: custo por venda R$ ${x.cpv.toFixed(2).replace('.', ',')} acima da meta (R$ ${cfg.metaCpv}).` });
    if (x.gasto > 3 * (cfg.metaCpv || 100) && !x.vendas) a.push({ nivel: 'erro', texto: `${k === 'google' ? 'Google' : 'Meta'}: R$ ${x.gasto.toFixed(2).replace('.', ',')} gastos no período sem nenhuma venda.` });
  }
  return a;
}

// Versão em texto do relatório (para a IA estrategista ler pela web sem perder números)
function texto(r) {
  const R = (n) => (n == null ? '—' : 'R$ ' + Number(n).toFixed(2).replace('.', ','));
  const P = (n) => (n == null ? '—' : String(n).replace('.', ',') + '%');
  const V = (a, b) => (a == null || b == null || !b ? '' : ` (${a >= b ? '+' : ''}${Math.round(((a - b) / Math.abs(b)) * 100)}% vs anterior)`);
  const L = [];
  L.push(`RELATÓRIO CONECTA AQUI · ${r.de} a ${r.ate} (${r.dias} dias) · comparação ${r.anteriorDe} a ${r.anteriorAte}`);
  L.push(`Metas: custo por venda até ${R(r.config.metaCpv)} · custo por lead até ${R(r.config.metaCpl)} · receita por venda ${R(r.config.receitaPorVenda)} · meta de vendas no mês ${r.config.metaVendasMes || '—'} · orçamento do mês ${R(r.config.orcamentoMes)}`);
  L.push('', 'CANAIS');
  for (const k of ['google', 'meta', 'disparos', 'outros', 'total']) {
    const c = r.canais[k];
    L.push(`- ${k}: gasto ${R(c.gasto)}${V(c.gasto, c.anterior.gasto)} | leads ${c.leads}${V(c.leads, c.anterior.leads)}${k === 'disparos' ? ` (de ${c.enviados} disparos enviados; lead = quem respondeu)` : ''} | custo/lead ${R(c.cpl)} | vendas ${c.vendas}${V(c.vendas, c.anterior.vendas)} | custo/venda ${R(c.cpv)}${V(c.cpv, c.anterior.cpv)} | lead→venda ${P(c.taxaVenda)} | instalados ${c.instalados} | sem cobertura ${c.semCobertura} | conversões na plataforma ${Math.round(c.convPlataforma)}`);
  }
  const m = r.metaMes;
  L.push('', `MÊS ATUAL (dia ${m.diasPassados}/${m.diasMes}): vendas ${m.vendas} (previsão ${m.previsaoVendas}) · gasto ${R(m.gasto)} (previsão ${R(m.previsaoGasto)})`);
  L.push('', 'FUNIL (leads que chegaram no período → até onde foram)');
  for (const k of ['google', 'meta', 'disparos', 'outros']) L.push(`- ${k}: ${r.funil.passos.map((p, i) => `${p} ${r.funil.canais[k].passos[i]}`).join(' → ')} · perdidos ${r.funil.canais[k].perdidos} · sem cobertura ${r.funil.canais[k].semCobertura}`);
  const ps = r.pesquisa;
  L.push('', 'REDE DE PESQUISA (Google)');
  if (ps.resumo) L.push(`Parcela de impressões ${P(ps.resumo.parcela)} · perdida por orçamento ${P(ps.resumo.perdidaOrcamento)} · perdida por posição ${P(ps.resumo.perdidaRanking)} · topo ${P(ps.resumo.topo)} · 1º lugar ${P(ps.resumo.topoAbsoluto)}`);
  else L.push('Sem dados de parcela de impressões ainda.');
  L.push('', 'CAMPANHAS (período)');
  for (const c of r.campanhas.slice(0, 15)) L.push(`- [${c.canal}] ${c.campanha} (${c.status || '—'}): gasto ${R(c.gasto)} · impr ${c.impressoes} · cliques ${c.cliques} · CTR ${P(c.ctr)} · CPC ${R(c.cpc)} · conv ${c.conversoes} · custo/conv ${R(c.custoConv)}${c.vendasCrm != null ? ` · vendas CRM ${c.vendasCrm}` : ''}`);
  L.push('', 'PALAVRAS-CHAVE (30 dias, maiores gastos)');
  for (const k of ps.palavras.slice(0, 30)) L.push(`- "${k.palavra}" [${k.tipo}] grupo ${k.grupo} · qualidade ${k.qualidade || '—'} · gasto ${R(k.gasto)} · cliques ${k.cliques} · CTR ${P(k.ctr)} · leads ${k.conversoes} · custo/lead ${R(k.cpa)} · parcela ${P(k.parcela)} · perdida posição ${P(k.perdidaRanking)} · 1º lugar ${P(k.topoAbsoluto)}`);
  L.push('', 'CIDADES (30 dias)');
  for (const c of ps.cidades.slice(0, 30)) L.push(`- ${c.nome}: gasto ${R(c.gasto)} · cliques ${c.cliques} · leads ${c.conversoes} · custo/lead ${R(c.cpa)}`);
  L.push('', 'TERMOS DE PESQUISA COM GASTO E SEM LEAD (30 dias)');
  for (const t of r.termosSemConversao.slice(0, 25)) L.push(`- "${t.termo}" (${t.grupo}): ${R(t.gasto)}, ${t.cliques} cliques`);
  L.push('', 'RECOMENDAÇÕES AUTOMÁTICAS DO PAINEL');
  for (const x of ps.recomendacoes) L.push(`- [${x.tipo}] ${x.texto}`);
  L.push('', 'ALERTAS');
  for (const a of r.alertas) L.push(`- ${a.texto}`);
  const cx = r.conexoes;
  L.push('', `CONEXÕES: Google último envio ${cx.google.ultima || 'nunca'} (script v${cx.google.versao || 1}) · Meta ${cx.meta.configurado ? 'conectado' : 'não conectado'}${cx.meta.erro ? ' (erro: ' + cx.meta.erro + ')' : ''} · funil ${cx.funil && cx.funil.completo ? 'em dia' : 'carregando'}${cx.funil && cx.funil.ultima ? ` (última leitura ${cx.funil.ultima})` : ''}`);
  const dc = cx.datacrazy;
  if (dc) {
    const h = dc.hoje || {};
    L.push(`DATACRAZY (site → lead/negócio): última sincronização ${dc.ultima || 'nunca'}${dc.erro ? ` · ERRO: ${dc.erro}` : ''} · linhas de WhatsApp vistas: ${(dc.linhasWhatsApp || []).join(', ') || 'nenhuma'} · hoje: conversas com resposta do cliente lidas ${h.conversasComRespostaLidas || 0} · mensagens do site ${h.mensagensDoSite || 0} · sem telefone ${h.semTelefone || 0} · lead não encontrado ${h.leadNaoEncontrado || 0} · leads atualizados ${h.leadsAtualizados || 0} · campos gravados no negócio ${h.camposGravados || 0} · campos com erro ${h.camposComErro || 0} · negócios movidos para a etapa do plano ${h.negociosMovidos || 0} · negócios aguardando ${dc.negociosAguardando}${dc.ultimoErro ? ` · último erro ${dc.ultimoErro.em} (${dc.ultimoErro.onde}): ${dc.ultimoErro.erro}` : ''}`);
    const dg = dc.diagConversa;
    if (dg) L.push(`DATACRAZY DIAGNÓSTICO (última conversa da linha do site sem mensagem do site reconhecida, ${dg.em}): ${dg.mensagens} mensagens (${dg.recebidas} do cliente), da ${dg.primeira || '?'} até ${dg.ultima || '?'} · com a palavra "plano": ${dg.comPalavraPlano} · amostra (números trocados por #): "${dg.amostra}"`);
  }
  return L.join('\n');
}

module.exports = { texto, relatorio, config, salvarConfig, dia };
