// Gasto dos anúncios por dia e por campanha.
//  - Google: um script dentro da conta do Google Ads envia os números para /ads/gasto/google/<ADS_FEED_TOKEN>
//    (de hora em hora). Não precisa de token de desenvolvedor.
//  - Meta: o servidor lê a Marketing API com META_TOKEN nas contas META_CONTAS (ids separados por vírgula).
// Guarda em DATA_DIR/trafego-gasto.json: { "<canal>|<campanhaId>|<data>": { ... } }
const store = require('./store');

const CHAVE = 'trafego-gasto';
const num = (v) => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const txt = (v, n = 160) => String(v ?? '').slice(0, n);
const dataOk = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d));

let estado = { google: { ultima: null, linhas: 0, erro: null }, meta: { ultima: null, linhas: 0, erro: null, rodando: false } };
const salvarEstado = () => store.save('trafego-gasto-estado', estado);
try { estado = { ...estado, ...store.load('trafego-gasto-estado', {}) }; estado.meta.rodando = false; } catch { /* primeira vez */ }

function gravar(canal, linhas) {
  const mapa = store.load(CHAVE, {});
  let n = 0;
  for (const l of linhas) {
    if (!dataOk(l.data) || !l.campanhaId) continue;
    mapa[`${canal}|${l.campanhaId}|${l.data}`] = {
      canal, data: l.data, conta: txt(l.conta, 40), campanhaId: txt(l.campanhaId, 40), campanha: txt(l.campanha),
      status: txt(l.status, 20), gasto: Math.round(num(l.gasto) * 100) / 100, impressoes: Math.round(num(l.impressoes)),
      cliques: Math.round(num(l.cliques)), conversoes: Math.round(num(l.conversoes) * 100) / 100,
    };
    n++;
  }
  // guarda 400 dias
  const limite = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(mapa)) if (v.data < limite) delete mapa[k];
  store.save(CHAVE, mapa);
  return n;
}

// ---------- Google (recebido do script) ----------
function receberGoogle(corpo) {
  const linhas = Array.isArray(corpo && corpo.linhas) ? corpo.linhas.slice(0, 20000) : null;
  if (!linhas) throw Object.assign(new Error('formato inválido: esperado { linhas: [...] }'), { status: 400 });
  const n = gravar('google', linhas.map((l) => ({ ...l, campanhaId: String(l.campanhaId || '') })));
  // termos de pesquisa (últimos 30 dias), se o script mandar
  if (Array.isArray(corpo.termos)) {
    store.save('trafego-termos-google', { em: new Date().toISOString(), termos: corpo.termos.slice(0, 3000).map((t) => ({ termo: txt(t.termo, 120), campanha: txt(t.campanha), grupo: txt(t.grupo), gasto: num(t.gasto), cliques: Math.round(num(t.cliques)), conversoes: num(t.conversoes) })) });
  }
  estado.google = { ultima: new Date().toISOString(), linhas: n, erro: null, conta: txt(corpo.conta, 40) };
  salvarEstado();
  return { ok: true, linhas: n };
}

// ---------- Meta (lido pela API) ----------
const META_VERSAO = () => process.env.META_API_VERSION || 'v23.0';
const metaContas = () => String(process.env.META_CONTAS || '').split(',').map((s) => s.trim().replace(/^act_/, '')).filter(Boolean);
const metaConfigurado = () => Boolean(process.env.META_TOKEN && metaContas().length);
// conversas iniciadas no WhatsApp / leads, conforme o objetivo da campanha
const ACOES_LEAD = ['onsite_conversion.messaging_conversation_started_7d', 'lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];

async function lerMeta(dias = null) {
  if (!metaConfigurado()) return { erro: 'META_TOKEN / META_CONTAS não configurados' };
  if (estado.meta.rodando) return estado.meta;
  estado.meta.rodando = true;
  const jaTem = Object.values(store.load(CHAVE, {})).some((v) => v.canal === 'meta');
  const periodo = dias || (jaTem ? 7 : 90);
  const ate = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const de = new Date(Date.now() - 3 * 3600e3 - (periodo - 1) * 864e5).toISOString().slice(0, 10);
  const linhas = [];
  const erros = [];
  try {
    for (const conta of metaContas()) {
      const qs = new URLSearchParams({
        level: 'campaign', time_increment: '1', limit: '500',
        fields: 'campaign_id,campaign_name,spend,impressions,clicks,actions',
        time_range: JSON.stringify({ since: de, until: ate }),
        access_token: process.env.META_TOKEN,
      });
      let url = `${(process.env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '')}/${META_VERSAO()}/act_${conta}/insights?${qs}`;
      for (let p = 0; url && p < 50; p++) {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.error) { erros.push(`conta ${conta}: ${(j.error && j.error.message) || r.status}`.slice(0, 200)); break; }
        for (const x of j.data || []) {
          const conv = (x.actions || []).filter((a) => ACOES_LEAD.includes(a.action_type)).reduce((s, a) => Math.max(s, num(a.value)), 0);
          linhas.push({ data: x.date_start, conta, campanhaId: x.campaign_id, campanha: x.campaign_name, gasto: x.spend, impressoes: x.impressions, cliques: x.clicks, conversoes: conv });
        }
        url = j.paging && j.paging.next ? j.paging.next : null;
      }
    }
    const n = gravar('meta', linhas);
    estado.meta = { ultima: new Date().toISOString(), linhas: n, erro: erros.length ? erros.join(' · ') : null, rodando: false };
  } catch (e) {
    estado.meta = { ...estado.meta, erro: e.message, rodando: false };
  } finally { estado.meta.rodando = false; salvarEstado(); }
  return estado.meta;
}

function iniciar() {
  if (!metaConfigurado()) return;
  setTimeout(() => lerMeta().catch(() => {}), 30_000).unref();
  setInterval(() => lerMeta().catch(() => {}), 60 * 60_000).unref();
}

const linhas = () => Object.values(store.load(CHAVE, {}));
const termosGoogle = () => store.load('trafego-termos-google', null);
const status = () => ({ google: estado.google, meta: { ...estado.meta, configurado: metaConfigurado(), contas: metaContas() } });

module.exports = { receberGoogle, lerMeta, iniciar, linhas, termosGoogle, status, gravar };
