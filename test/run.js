// Teste ponta a ponta: sobe um "MCC falso" (mesmo formato do app real) e a ponte apontando para ele.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

const LISTAS = {
  'ceps-claro': ['01002000', '01002001', '20040002'],
  'ceps-nio': ['20040002'],
  'ceps-tim': ['01002000'],
  'cidades-promo-claro': ['SAO PAULO'],
};
let logins = 0;
const mcc = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const ck = req.headers.cookie || '';
  if (u.pathname === '/api/auth/csrf') {
    res.setHeader('set-cookie', '__Host-next-auth.csrf-token=abc%7Chash; Path=/; HttpOnly');
    return res.end(JSON.stringify({ csrfToken: 'abc' }));
  }
  if (u.pathname === '/api/auth/callback/credentials' && req.method === 'POST') {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      const p = new URLSearchParams(b);
      logins++;
      if (p.get('csrfToken') === 'abc' && ck.includes('csrf-token') && p.get('email') === 'ponte@x.com' && p.get('password') === 'segredo') {
        res.setHeader('set-cookie', `__Secure-next-auth.session-token=tok${logins}; Path=/; HttpOnly; Secure`);
        res.end(JSON.stringify({ url: '/mcc' }));
      } else { res.end(JSON.stringify({ url: '/mcc/login?error=CredentialsSignin' })); }
    });
    return;
  }
  const m = u.pathname.match(/^\/api\/mcc\/admin\/([a-z-]+)$/);
  if (m) {
    if (!/session-token=tok\d+/.test(ck)) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Não autenticado' })); }
    if (ck.includes('session-token=tok1;') || ck.endsWith('session-token=tok1')) { if (global.expirarPrimeira) { global.expirarPrimeira = false; res.statusCode = 401; return res.end('{}'); } }
    const q = (u.searchParams.get('q') || '').replace(/-/g, '');
    const items = (LISTAS[m[1]] || []).filter((v) => v.includes(q)).map((v) => ({ id: v, value: v }));
    return res.end(JSON.stringify({ items, total: items.length, page: 1, pageSize: 100 }));
  }
  res.statusCode = 404; res.end('{}');
});

(async () => {
  await new Promise((r) => mcc.listen(0, r));
  process.env.MCC_BASE_URL = `http://127.0.0.1:${mcc.address().port}`;
  process.env.MCC_EMAIL = 'ponte@x.com';
  process.env.MCC_PASSWORD = 'segredo';
  process.env.ADMIN_PASSWORD = 'admin123';
  process.env.WHATSAPP_NUMBER = '5521900000000';
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-'));

  // ViaCEP falso (o real fica bloqueado no ambiente de teste)
  const fetchOrig = global.fetch;
  global.fetch = (url, o) => (String(url).includes('viacep.com.br')
    ? Promise.resolve(new Response(JSON.stringify(String(url).includes('01002000') ? { logradouro: 'Rua Direita', bairro: 'Sé', localidade: 'São Paulo', uf: 'SP' } : { localidade: 'Rio de Janeiro', uf: 'RJ' })))
    : fetchOrig(url, o));

  const servidor = require('../server');
  await new Promise((r) => servidor.listen(0, r));
  const B = `http://127.0.0.1:${servidor.address().port}`;
  const get = async (p, h = {}) => { const r = await fetchOrig(B + p, { headers: h }); return { s: r.status, j: await r.json().catch(() => null), h: r.headers }; };
  const send = async (p, method, body, h = {}) => { const r = await fetchOrig(B + p, { method, body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...h } }); return { s: r.status, j: await r.json().catch(() => null), h: r.headers }; };

  let ok = 0; const t = async (nome, fn) => { await fn(); ok++; console.log('✓', nome); };

  await t('CEP inválido → 400', async () => { const r = await get('/api/cobertura?cep=123'); assert.equal(r.s, 400); });
  await t('SP 01002-000: Claro + TIM, com promo Claro (cidade com acento normalizada)', async () => {
    const r = await get('/api/cobertura?cep=01002-000');
    assert.equal(r.s, 200);
    assert.deepEqual(r.j.operadoras.map((o) => o.id).sort(), ['claro', 'tim']);
    assert.equal(r.j.demo, false);
    assert.ok(r.j.planos.some((p) => p.nome.includes('Promo')), 'plano de cidade promo deve aparecer');
    assert.ok(r.j.planos.every((p) => p.operadora.id !== 'nio'));
    assert.equal(r.j.endereco.cidade, 'São Paulo');
  });
  await t('Busca do MCC é "contém": 0100200 NÃO conta como coberto (match exato)', async () => {
    const r = await get('/api/cobertura?cep=01002002');
    assert.equal(r.j.operadoras.length, 0); assert.equal(r.j.planos.length, 0);
  });
  await t('RJ 20040-002: Claro + Nio, sem plano promo', async () => {
    const r = await get('/api/cobertura?cep=20040002');
    assert.deepEqual(r.j.operadoras.map((o) => o.id).sort(), ['claro', 'nio']);
    assert.ok(!r.j.planos.some((p) => p.nome.includes('Promo')));
  });
  await t('Sessão do MCC expirada → entra de novo sozinho', async () => {
    global.expirarPrimeira = true;
    const antes = logins;
    // força nova consulta sem cache
    const r = await get('/api/cobertura?cep=01002001');
    assert.equal(r.s, 200); assert.ok(logins > antes); assert.deepEqual(r.j.operadoras.map((o) => o.id), ['claro']);
  });
  await t('Destaques e config públicos', async () => {
    const d = await get('/api/destaques'); assert.ok(d.j.planos.length > 0); assert.ok(d.j.planos.every((p) => p.destaque));
    const c = await get('/api/config'); assert.equal(c.j.whatsapp, '5521900000000');
  });
  await t('Contato: valida e grava', async () => {
    assert.equal((await send('/api/contato', 'POST', { nome: 'A', telefone: '1' })).s, 400);
    assert.equal((await send('/api/contato', 'POST', { nome: 'Maria', telefone: '(21) 99999-0000', cep: '20040002', origem: 'plano' })).s, 200);
  });
  await t('Painel bloqueado sem login', async () => { assert.equal((await get('/admin/api/planos')).s, 401); });
  await t('Senha errada → 401', async () => { assert.equal((await send('/admin/api/login', 'POST', { senha: 'x' })).s, 401); });

  const login = await send('/admin/api/login', 'POST', { senha: 'admin123' });
  const cookie = login.h.get('set-cookie').split(';')[0];
  const H = { cookie, 'x-requested-with': 'painel' };
  await t('Login no painel', async () => { assert.equal(login.s, 200); assert.equal((await get('/admin/api/status', H)).j.modoDemo, false); });
  await t('Cookie adulterado é recusado', async () => { assert.equal((await get('/admin/api/planos', { cookie: cookie.slice(0, -2) + '00' })).s, 401); });
  await t('Escrita sem cabeçalho do painel é recusada (CSRF)', async () => { assert.equal((await send('/admin/api/planos', 'POST', {}, { cookie })).s, 403); });

  let novo;
  await t('Criar plano (valida preço/operadora)', async () => {
    assert.equal((await send('/admin/api/planos', 'POST', { operadoraId: 'xxx', nome: 'a', preco: 10 }, H)).s, 400);
    assert.equal((await send('/admin/api/planos', 'POST', { operadoraId: 'nio', nome: 'a', preco: 10, precoPromo: 20 }, H)).s, 400);
    const r = await send('/admin/api/planos', 'POST', { operadoraId: 'nio', nome: 'Nio 1 Giga', preco: '139,90', velocidadeMbps: '1000', beneficios: ['Wi-Fi 6', ''], ativo: true }, H);
    assert.equal(r.s, 201); assert.equal(r.j.preco, 139.9); assert.deepEqual(r.j.beneficios, ['Wi-Fi 6']); novo = r.j;
  });
  await t('Plano novo aparece na busca; desativado some', async () => {
    let r = await get('/api/cobertura?cep=20040002'); assert.ok(r.j.planos.some((p) => p.id === novo.id));
    assert.equal((await send('/admin/api/planos/' + novo.id, 'PUT', { ativo: false }, H)).s, 200);
    r = await get('/api/cobertura?cep=20040002'); assert.ok(!r.j.planos.some((p) => p.id === novo.id));
  });
  await t('Exportar e reimportar CSV (formato brasileiro)', async () => {
    const r = await fetchOrig(B + '/admin/api/planos/exportar', { headers: H });
    const texto = await r.text();
    assert.ok(texto.includes('139,9'));
    const editado = texto.replace('139,9', '129,9');
    const imp = await send('/admin/api/planos/importar', 'POST', editado, { ...H, 'content-type': 'text/csv' });
    assert.equal(imp.s, 200); assert.equal(imp.j.criados, 0);
    const planos = (await get('/admin/api/planos', H)).j;
    assert.equal(planos.find((p) => p.id === novo.id).preco, 129.9);
  });
  await t('Importação com erro não altera nada', async () => {
    const antes = (await get('/admin/api/planos', H)).j.length;
    const imp = await send('/admin/api/planos/importar', 'POST', 'operadoraId;nome;preco\nclaro;Ok;99,9\nvivo;Ruim;10', { ...H, 'content-type': 'text/csv' });
    assert.equal(imp.s, 400); assert.ok(imp.j.detalhes[0].includes('Linha 3'));
    assert.equal((await get('/admin/api/planos', H)).j.length, antes);
  });
  await t('Operadora com planos não pode ser removida', async () => {
    const ops = (await get('/admin/api/operadoras', H)).j;
    assert.equal((await send('/admin/api/operadoras', 'PUT', ops.filter((o) => o.id !== 'tim'), H)).s, 400);
    assert.equal((await send('/admin/api/operadoras', 'PUT', [...ops, { nome: 'Fibra Local', cobertura: 'todas' }], H)).s, 200);
  });
  await t('Contatos listados e exportados', async () => {
    assert.equal((await get('/admin/api/contatos', H)).j[0].nome, 'Maria');
  });
  await t('Arquivos estáticos e proteção de caminho', async () => {
    assert.equal((await fetchOrig(B + '/')).status, 200);
    assert.equal((await fetchOrig(B + '/admin')).status, 200);
    const r = await fetchOrig(B + '/..%2f..%2fserver.js'); assert.notEqual(await r.text().then((t) => t.includes('require(')), true);
  });

  console.log(`\n${ok} testes passaram.`);
  servidor.close(); mcc.close();
})().catch((e) => { console.error('✗ FALHOU:', e); process.exit(1); });
