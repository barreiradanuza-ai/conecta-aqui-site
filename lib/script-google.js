// Texto do script que vai dentro do Google Ads (Ferramentas → Ações em massa → Scripts).
// Ele envia, de hora em hora, o gasto por campanha e por dia (últimos 30 dias) e os termos de pesquisa.
function scriptGoogle(urlEnvio) {
  return `/**
 * Conecta Aqui · envia o gasto do Google Ads para o painel.
 * Programar: a cada hora.
 */
var URL_PAINEL = '${urlEnvio}';

function main() {
  var fuso = AdsApp.currentAccount().getTimeZone();
  var hoje = new Date();
  var fim = Utilities.formatDate(hoje, fuso, 'yyyy-MM-dd');
  var ini = Utilities.formatDate(new Date(hoje.getTime() - 30 * 864e5), fuso, 'yyyy-MM-dd');

  var linhas = [];
  var it = AdsApp.search(
    "SELECT segments.date, campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions " +
    "FROM campaign WHERE segments.date BETWEEN '" + ini + "' AND '" + fim + "'");
  while (it.hasNext()) {
    var r = it.next();
    linhas.push({
      data: r.segments.date, campanhaId: String(r.campaign.id), campanha: r.campaign.name, status: r.campaign.status,
      gasto: Number(r.metrics.costMicros || 0) / 1e6, impressoes: Number(r.metrics.impressions || 0),
      cliques: Number(r.metrics.clicks || 0), conversoes: Number(r.metrics.conversions || 0)
    });
  }

  var termos = [];
  try {
    var it2 = AdsApp.search(
      "SELECT search_term_view.search_term, campaign.name, ad_group.name, metrics.cost_micros, metrics.clicks, metrics.conversions " +
      "FROM search_term_view WHERE segments.date BETWEEN '" + ini + "' AND '" + fim + "' AND metrics.clicks > 0 " +
      "ORDER BY metrics.cost_micros DESC LIMIT 3000");
    while (it2.hasNext()) {
      var t = it2.next();
      termos.push({ termo: t.searchTermView.searchTerm, campanha: t.campaign.name, grupo: t.adGroup.name,
        gasto: Number(t.metrics.costMicros || 0) / 1e6, cliques: Number(t.metrics.clicks || 0), conversoes: Number(t.metrics.conversions || 0) });
    }
  } catch (e) { Logger.log('termos de pesquisa: ' + e); }

  var resp = UrlFetchApp.fetch(URL_PAINEL, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ conta: AdsApp.currentAccount().getCustomerId(), linhas: linhas, termos: termos })
  });
  Logger.log('Painel respondeu ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
}
`;
}
module.exports = { scriptGoogle };
