// Texto do script que vai dentro do Google Ads (Ferramentas → Ações em massa → Scripts).
// De hora em hora envia (últimos 30 dias): gasto por campanha e dia, parcela de impressões,
// palavras-chave (com índice de qualidade), cidades e termos de pesquisa.
const VERSAO_SCRIPT = 2;
function scriptGoogle(urlEnvio) {
  return `/**
 * Conecta Aqui · envia os números do Google Ads para o painel (versão ${VERSAO_SCRIPT}).
 * Programar: de hora em hora.
 */
var URL_PAINEL = '${urlEnvio}';

function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }
function busca(q, f) { try { var it = AdsApp.search(q); while (it.hasNext()) f(it.next()); } catch (e) { Logger.log('consulta: ' + e); } }

function main() {
  var fuso = AdsApp.currentAccount().getTimeZone();
  var hoje = new Date();
  var fim = Utilities.formatDate(hoje, fuso, 'yyyy-MM-dd');
  var ini = Utilities.formatDate(new Date(hoje.getTime() - 30 * 864e5), fuso, 'yyyy-MM-dd');
  var periodo = " segments.date BETWEEN '" + ini + "' AND '" + fim + "' ";

  // 1) gasto por campanha e dia
  var linhas = [];
  busca("SELECT segments.date, campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM campaign WHERE" + periodo, function (r) {
    linhas.push({ data: r.segments.date, campanhaId: String(r.campaign.id), campanha: r.campaign.name, status: r.campaign.status,
      gasto: n(r.metrics.costMicros) / 1e6, impressoes: n(r.metrics.impressions), cliques: n(r.metrics.clicks), conversoes: n(r.metrics.conversions) });
  });

  // 2) parcela de impressões (quanto do leilão você ganha) por campanha e dia
  var parcela = [];
  busca("SELECT segments.date, campaign.id, metrics.impressions, metrics.search_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share, metrics.search_top_impression_share, metrics.search_absolute_top_impression_share FROM campaign WHERE campaign.advertising_channel_type = 'SEARCH' AND" + periodo, function (r) {
    var m = r.metrics;
    parcela.push({ data: r.segments.date, campanhaId: String(r.campaign.id), impressoes: n(m.impressions), parcela: n(m.searchImpressionShare), perdidaOrcamento: n(m.searchBudgetLostImpressionShare),
      perdidaRanking: n(m.searchRankLostImpressionShare), topo: n(m.searchTopImpressionShare), topoAbsoluto: n(m.searchAbsoluteTopImpressionShare) });
  });

  // 3) palavras-chave (30 dias somados)
  var palavras = [];
  busca("SELECT campaign.name, ad_group.name, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.quality_info.quality_score, " +
    "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.search_impression_share, metrics.search_rank_lost_impression_share, metrics.search_absolute_top_impression_share " +
    "FROM keyword_view WHERE" + periodo + "AND metrics.impressions > 0", function (r) {
    var c = r.adGroupCriterion, m = r.metrics;
    palavras.push({ id: String(c.criterionId), palavra: c.keyword.text, tipo: c.keyword.matchType, status: c.status, qualidade: c.qualityInfo ? n(c.qualityInfo.qualityScore) : 0,
      campanha: r.campaign.name, grupo: r.adGroup.name, gasto: n(m.costMicros) / 1e6, impressoes: n(m.impressions), cliques: n(m.clicks), conversoes: n(m.conversions),
      parcela: n(m.searchImpressionShare), perdidaRanking: n(m.searchRankLostImpressionShare), topoAbsoluto: n(m.searchAbsoluteTopImpressionShare) });
  });

  // 4) cidades (onde as pessoas estavam)
  var cidades = [], ids = {};
  busca("SELECT segments.geo_target_city, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions FROM geographic_view WHERE" + periodo + "AND metrics.impressions > 0", function (r) {
    var g = r.segments.geoTargetCity || '';
    var id = g.split('/').pop();
    if (!id) return;
    if (!ids[id]) { ids[id] = { id: id, gasto: 0, impressoes: 0, cliques: 0, conversoes: 0 }; cidades.push(ids[id]); }
    var x = ids[id], m = r.metrics;
    x.gasto += n(m.costMicros) / 1e6; x.impressoes += n(m.impressions); x.cliques += n(m.clicks); x.conversoes += n(m.conversions);
  });
  for (var i = 0; i < cidades.length; i += 100) {
    var lote = cidades.slice(i, i + 100).map(function (c) { return "'geoTargetConstants/" + c.id + "'"; }).join(',');
    busca("SELECT geo_target_constant.id, geo_target_constant.canonical_name FROM geo_target_constant WHERE geo_target_constant.resource_name IN (" + lote + ")", function (r) {
      var c = ids[String(r.geoTargetConstant.id)]; if (c) c.nome = r.geoTargetConstant.canonicalName;
    });
  }

  // 5) termos de pesquisa
  var termos = [];
  busca("SELECT search_term_view.search_term, campaign.name, ad_group.name, metrics.cost_micros, metrics.clicks, metrics.conversions FROM search_term_view WHERE" + periodo + "AND metrics.clicks > 0 ORDER BY metrics.cost_micros DESC LIMIT 3000", function (t) {
    termos.push({ termo: t.searchTermView.searchTerm, campanha: t.campaign.name, grupo: t.adGroup.name, gasto: n(t.metrics.costMicros) / 1e6, cliques: n(t.metrics.clicks), conversoes: n(t.metrics.conversions) });
  });

  var resp = UrlFetchApp.fetch(URL_PAINEL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ versao: ${VERSAO_SCRIPT}, conta: AdsApp.currentAccount().getCustomerId(), linhas: linhas, parcela: parcela, palavras: palavras, cidades: cidades, termos: termos })
  });
  Logger.log('Painel respondeu ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
}
`;
}
module.exports = { scriptGoogle, VERSAO_SCRIPT };
