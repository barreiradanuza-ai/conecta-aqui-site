// Guarda os cliques que vieram de anúncio do Google: código "G-XXXXX" → gclid/gbraid/wbraid e UTMs.
const store = require('./store');

const limpa = (v, n = 200) => String(v || '').replace(/[^\w\-.~:]/g, '').slice(0, n);
const limpaTexto = (v, n = 120) => String(v || '').slice(0, n);

function normalizar(b) {
  const r = b && typeof b.rastreio === 'object' ? b.rastreio : {};
  const ref = String(r.ref || '').toUpperCase();
  if (!/^G-[A-Z0-9]{5}$/.test(ref)) return null;
  const o = { ref, gclid: limpa(r.gclid), gbraid: limpa(r.gbraid), wbraid: limpa(r.wbraid), utm_source: limpaTexto(r.utm_source, 60), utm_medium: limpaTexto(r.utm_medium, 60), utm_campaign: limpaTexto(r.utm_campaign), utm_term: limpaTexto(r.utm_term), chegada: limpaTexto(r.em, 30) };
  if (!o.gclid && !o.gbraid && !o.wbraid && !/google/i.test(o.utm_source)) return null;
  return o;
}

function registrarClique(b, extra = {}) {
  const o = normalizar(b);
  if (!o) return null;
  const mapa = store.load('ads-cliques', {});
  mapa[o.ref] = { ...(mapa[o.ref] || {}), ...o, ...extra, em: new Date().toISOString() };
  // mantém só os últimos 90 dias
  const limite = Date.now() - 90 * 864e5;
  for (const [k, v] of Object.entries(mapa)) if (new Date(v.em).getTime() < limite) delete mapa[k];
  store.save('ads-cliques', mapa);
  return o;
}

const buscar = (ref) => store.load('ads-cliques', {})[String(ref || '').toUpperCase()] || null;

function registrarFormulario(lead, b) {
  const o = registrarClique(b, { formulario: true });
  if (!o) return null;
  const pend = store.load('ads-formularios', []);
  pend.push({ id: lead.id, nome: lead.nome, telefone: lead.telefone, ...o });
  store.save('ads-formularios', pend.slice(-2000));
  return o;
}
const formulariosPendentes = () => store.load('ads-formularios', []);
function formularioEnviado(id) { store.save('ads-formularios', formulariosPendentes().filter((f) => f.id !== id)); }

module.exports = { normalizar, registrarClique, buscar, registrarFormulario, formulariosPendentes, formularioEnviado };
