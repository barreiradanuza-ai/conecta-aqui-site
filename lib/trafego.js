// Relatório do painel de tráfego: junta gasto (Google/Meta), funil do DataCrazy e cliques do site.
const store = require('./store');
const gasto = require('./gasto');
const funil = require('./funil');

const CANAIS = ['google', 'meta', 'outros'];
const dia = (iso) => (iso ? new Date(new Date(iso).getTime() - 3 * 3600e3).toISOString().slice(0, 10) : '');
const hoje = () => dia(new Date().toISOString());
const somaDias = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5) + 1;
const div = (a, b) => (b ? a / b : null);
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

const CONFIG_PADRAO = { receitaPorVenda: 200, metaVendasMes: 0, metaCpv: 100, orcamentoMes: 0 };
const config = () => ({ ...CONFIG_PADRAO, ...store.load('trafego-config', {}) });
function salvarConfig(b) {
  const c = config();
  for (const k of Object.keys(CONFIG_PADRAO)) if (b[k] != null && b[k] !== '') { const n = Number(b[k]); if (Number.isFinite(n) && n >= 0) c[k] = n; }
  store.save('trafego-config', c);
  return c;
}

const vazio = () => ({ gasto: 0, impressoes: 0, cliques: 0, convPlataforma: 0, leads: 0, vendas: 0, instalados: 0, pagos: 0, semCobertura: 0 });
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
    if (dentro(dia(l.criado))) t.leads++;
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
    serie.push({ data: d, gasto: { google: 0, meta: 0 }, leads: { google: 0, meta: 0, outros: 0 }, vendas: { google: 0, meta: 0, outros: 0 } });
  }
  const idx = Object.fromEntries(serie.map((s, i) => [s.data, i]));
  for (const g of linhasGasto) if (idx[g.data] != null && serie[idx[g.data]].gasto[g.canal] != null) serie[idx[g.data]].gasto[g.canal] = r2(serie[idx[g.data]].gasto[g.canal] + g.gasto);
  for (const l of leads) {
    const o = CANAIS.includes(l.origem) ? l.origem : 'outros';
    const dc = idx[dia(l.criado)]; if (dc != null) serie[dc].leads[o]++;
    const dv = idx[dia(l.passos.venda)]; if (dv != null) serie[dv].vendas[o]++;
  }

  // funil (coorte: leads que chegaram no período e até onde foram)
  const funilCanal = {};
  for (const c of [...CANAIS, 'total']) funilCanal[c] = { passos: funil.PASSOS.map(() => 0), perdidos: 0, semCobertura: 0 };
  for (const l of leads) {
    if (!(dia(l.criado) >= de && dia(l.criado) <= ate)) continue;
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

  return { de, ate, dias: n, anteriorDe: antDe, anteriorAte: antAte, config: cfg, canais, serie, funil: { passos: funil.PASSOS.map((p) => funil.ROTULOS[p]), canais: funilCanal }, campanhas, termosSemConversao, metaMes, alertas: alertas(canais, cfg), conexoes: conexoes() };
}

function conexoes() {
  const g = gasto.status();
  const f = funil.status();
  return { google: g.google, meta: g.meta, funil: f, termosEm: (gasto.termosGoogle() || {}).em || null };
}

function alertas(canais, cfg) {
  const a = [];
  const c = conexoes();
  const horas = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600e3 : Infinity);
  if (horas(c.google.ultima) > 3) a.push({ nivel: 'aviso', texto: c.google.ultima ? 'O script do Google Ads não envia dados há mais de 3 horas.' : 'O script do Google Ads ainda não foi instalado (sem gasto do Google).' });
  if (!c.meta.configurado) a.push({ nivel: 'aviso', texto: 'Meta Ads ainda não conectado (falta META_TOKEN e META_CONTAS).' });
  else if (c.meta.erro) a.push({ nivel: 'erro', texto: 'Erro ao ler o Meta Ads: ' + c.meta.erro });
  if (!c.funil || !c.funil.completo) a.push({ nivel: 'info', texto: 'Carregando o histórico de negócios do DataCrazy; os números do funil ainda podem estar incompletos.' });
  for (const k of ['google', 'meta']) {
    const x = canais[k];
    if (cfg.metaCpv && x.vendas && x.cpv > cfg.metaCpv) a.push({ nivel: 'erro', texto: `${k === 'google' ? 'Google' : 'Meta'}: custo por venda R$ ${x.cpv.toFixed(2).replace('.', ',')} acima da meta (R$ ${cfg.metaCpv}).` });
    if (x.gasto > 3 * (cfg.metaCpv || 100) && !x.vendas) a.push({ nivel: 'erro', texto: `${k === 'google' ? 'Google' : 'Meta'}: R$ ${x.gasto.toFixed(2).replace('.', ',')} gastos no período sem nenhuma venda.` });
  }
  return a;
}

module.exports = { relatorio, config, salvarConfig, dia };
