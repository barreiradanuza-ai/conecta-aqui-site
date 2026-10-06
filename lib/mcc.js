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

async function get(caminho, tentativa = 0) {
  await garantirLogin();
  const res = await fetch(`${BASE}${caminho}`, { headers: { cookie: cookieHeader(), accept: 'application/json' } });
  if (res.status === 401 && tentativa === 0) { cookies = {}; return get(caminho, 1); } // sessão expirou: entra de novo
  if (!res.ok) throw new Error(`MCC respondeu ${res.status} em ${caminho}`);
  guardarCookies(res);
  return res.json();
}

// Procura um valor EXATO numa lista do MCC (a busca do app é por "contém").
async function existeNaLista(lista, valor) {
  if (!/^[a-z0-9-]+$/.test(lista)) throw new Error('lista inválida');
  const j = await get(`/api/mcc/admin/${lista}?page=1&pageSize=100&q=${encodeURIComponent(valor)}`);
  return (j.items || []).some((it) => String(it.value).trim().toUpperCase() === String(valor).trim().toUpperCase());
}

const configurado = () => Boolean(EMAIL && PASSWORD);

module.exports = { existeNaLista, configurado, login, BASE };
