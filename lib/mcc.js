// Cliente do app Minha Casa Conectada (MCC).
// Faz login com um usuário dedicado (NextAuth, e-mail + senha) e consulta as listas de CEP.
// Só LÊ dados. Nunca altera nada no app.

const BASE = (process.env.MCC_BASE_URL || 'https://minhacasaconectada.net.br').replace(/\/$/, '');
const EMAIL = process.env.MCC_EMAIL || '';
const PASSWORD = process.env.MCC_PASSWORD || '';

let cookies = {}; // nome -> valor
let loginEmAndamento = null;

function guardarCookies(res) {
  const lista = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of lista) {
    const [par] = c.split(';');
    const i = par.indexOf('=');
    if (i > 0) cookies[par.slice(0, i).trim()] = par.slice(i + 1).trim();
  }
}
const cookieHeader = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
const temSessao = () => Object.keys(cookies).some((k) => k.includes('session-token'));

async function login() {
  if (!EMAIL || !PASSWORD) throw new Error('MCC_EMAIL e MCC_PASSWORD não configurados');
  cookies = {};
  const r1 = await fetch(`${BASE}/api/auth/csrf`, { headers: { accept: 'application/json' } });
  guardarCookies(r1);
  const { csrfToken } = await r1.json();
  const corpo = new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, callbackUrl: `${BASE}/mcc`, json: 'true' });
  const r2 = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(), 'x-auth-return-redirect': '1' },
    body: corpo,
  });
  guardarCookies(r2);
  if (!temSessao()) throw new Error(`Login no MCC falhou (status ${r2.status}). Confira e-mail e senha do usuário da ponte.`);
}

async function garantirLogin() {
  if (temSessao()) return;
  if (!loginEmAndamento) loginEmAndamento = login().finally(() => { loginEmAndamento = null; });
  await loginEmAndamento;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const ESPERAS_MS = [400, 1000, 2500]; // 429/5xx: a borda da Railway na frente do MCC às vezes limita por alguns segundos

// Uma chamada de cada vez ao MCC: evita rajadas (cada CEP consulta 3 ou 4 listas) que disparam o limite da borda
let fila = Promise.resolve();
const emFila = (fn) => { const p = fila.then(fn, fn); fila = p.catch(() => {}); return p; };

async function get(caminho, tentativa = 0, relogou = false) {
  await garantirLogin();
  const res = await fetch(`${BASE}${caminho}`, { headers: { cookie: cookieHeader(), accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 && !relogou) { cookies = {}; return get(caminho, tentativa, true); } // sessão expirou: entra de novo
  if ((res.status === 429 || res.status >= 500) && tentativa < ESPERAS_MS.length) {
    const retryAfter = Number(res.headers.get('retry-after')) * 1000;
    await dormir(Math.min(Math.max(retryAfter || 0, ESPERAS_MS[tentativa]), 5000));
    return get(caminho, tentativa + 1, relogou);
  }
  if (!res.ok) throw new Error(`MCC respondeu ${res.status} em ${caminho}`);
  guardarCookies(res);
  return res.json();
}

// Respostas por lista+valor ficam guardadas por 6 horas (também as negativas): uma nova busca do mesmo CEP não volta ao MCC
const CACHE_MS = 6 * 60 * 60 * 1000;
const respostas = new Map();
const limparCache = () => respostas.clear();

// Procura um valor EXATO numa lista do MCC (a busca do app é por "contém").
async function existeNaLista(lista, valor) {
  if (!/^[a-z0-9-]+$/.test(lista)) throw new Error('lista inválida');
  const chave = `${lista}|${String(valor).trim().toUpperCase()}`;
  const c = respostas.get(chave);
  if (c && Date.now() - c.em < CACHE_MS) return c.existe;
  const existe = await emFila(async () => {
    const j = await get(`/api/mcc/admin/${lista}?page=1&pageSize=100&q=${encodeURIComponent(valor)}`);
    return (j.items || []).some((it) => String(it.value).trim().toUpperCase() === String(valor).trim().toUpperCase());
  });
  respostas.set(chave, { existe, em: Date.now() });
  if (respostas.size > 50000) respostas.delete(respostas.keys().next().value);
  return existe;
}

const configurado = () => Boolean(EMAIL && PASSWORD);

module.exports = { existeNaLista, configurado, login, get, limparCache, BASE };
