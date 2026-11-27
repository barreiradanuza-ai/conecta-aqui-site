// Meta (Facebook/Instagram): Pixel no navegador + API de Conversões no servidor.
// Variáveis: META_PIXEL_ID (id do conjunto de dados) e META_CAPI_TOKEN (token gerado no Gerenciador de Eventos).
// Opcional: META_TEST_EVENT_CODE (código "TEST…" da aba Testar eventos, só durante os testes).
// O mesmo event_id vai no Pixel e na API, então a Meta conta cada lead uma vez só (deduplicação).
const crypto = require('node:crypto');

const VERSAO = () => process.env.META_API_VERSION || 'v23.0';
const GRAPH = () => (process.env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, '');
const pixelId = () => String(process.env.META_PIXEL_ID || '').replace(/\D/g, '');
const configurado = () => Boolean(pixelId() && process.env.META_CAPI_TOKEN);

const sha = (v) => (v ? crypto.createHash('sha256').update(v).digest('hex') : undefined);
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const normTexto = (s) => semAcento(s).toLowerCase().replace(/[^a-z]/g, '');
function normTelefone(t) {
  const d = String(t || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) return '55' + d; // DDD + número, sem o 55
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d;
  return '';
}

// trecho do Pixel injetado no <head> das páginas públicas (PageView automático)
function snippet() {
  const id = pixelId();
  if (!id) return '';
  return `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');</script>
<noscript><img height="1" width="1" style="display:none" alt="" src="https://www.facebook.com/tr?id=${id}&ev=PageView&noscript=1"></noscript>`;
}

function cookie(req, nome) {
  const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + nome + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]).slice(0, 300) : undefined;
}

// monta user_data a partir da requisição (cookies _fbp/_fbc do Pixel, IP, navegador) e do lead
function dadosUsuario(req, lead = {}, ip) {
  const fbc = cookie(req, '_fbc') || (lead.fbclid ? `fb.1.${Date.now()}.${String(lead.fbclid).slice(0, 250)}` : undefined);
  const primeiroNome = String(lead.nome || '').trim().split(/\s+/)[0];
  const u = {
    client_ip_address: ip || undefined,
    client_user_agent: String(req.headers['user-agent'] || '').slice(0, 400) || undefined,
    fbp: cookie(req, '_fbp'),
    fbc,
    ph: sha(normTelefone(lead.telefone)),
    fn: sha(normTexto(primeiroNome)),
    ct: sha(normTexto(lead.cidade)),
    st: sha(normTexto(lead.uf)),
    zp: sha(String(lead.cep || '').replace(/\D/g, '').slice(0, 8)),
    country: sha('br'),
  };
  for (const k of Object.keys(u)) if (!u[k]) delete u[k];
  return u;
}

const idValido = (v) => (/^[\w-]{8,64}$/.test(String(v || '')) ? String(v) : null);

// envia um evento pela API de Conversões. Nunca lança erro: falha da Meta não pode derrubar o site.
async function enviar({ nome, eventId, req, ip, lead = {}, url, custom = {} }) {
  if (!configurado()) return { ok: false, motivo: 'não configurado' };
  const evento = {
    event_name: nome,
    event_time: Math.floor(Date.now() / 1000),
    event_id: idValido(eventId) || crypto.randomUUID(),
    action_source: 'website',
    event_source_url: String(url || req.headers.referer || 'https://conectaaqui.net.br/').slice(0, 500),
    user_data: dadosUsuario(req, lead, ip),
    custom_data: { currency: 'BRL', ...custom },
  };
  const corpo = { data: [evento] };
  if (process.env.META_TEST_EVENT_CODE) corpo.test_event_code = process.env.META_TEST_EVENT_CODE;
  try {
    const r = await fetch(`${GRAPH()}/${VERSAO()}/${pixelId()}/events?access_token=${encodeURIComponent(process.env.META_CAPI_TOKEN)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { console.error(new Date().toISOString(), `meta capi ${nome} falhou:`, (j.error && j.error.message) || 'HTTP ' + r.status); return { ok: false }; }
    return { ok: true, eventId: evento.event_id };
  } catch (e) {
    console.error(new Date().toISOString(), `meta capi ${nome} falhou:`, e.message);
    return { ok: false };
  }
}

module.exports = { pixelId, configurado, snippet, enviar, dadosUsuario, normTelefone, cookie, idValido };
