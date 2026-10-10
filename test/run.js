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
  if (u.pathname === '/oferta-tim') {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.end(`<html><body><script>var x="999 MEGA R$ 1,00"</script><div class="card"><h3>500 MEGA</h3><p>de R$ 129,99 por <b>R$&nbsp;89,99</b>/mês</p><li>Wi-Fi grátis</li></div>
      <div class="card"><h3>600 MEGA</h3><p>Com Paramount+ incluso</p><p>R$ 149,99 por R$ 109,99</p></div><div><h3>1 GIGA</h3><p>R$ ${global.precoGiga || '199,99'}</p></div></body></html>`);
  }
  const m = u.pathname.match(/^\/api\/mcc\/admin\/([a-z-]+)$/);
  if (m) {
    if (!/session-token=tok\d+/.test(ck)) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'Não autenticado' })); }
    if (ck.includes('session-token=tok1;') || ck.endsWith('session-token=tok1')) { if (global.expirarPrimeira) { global.expirarPrimeira = false; res.statusCode = 401; return res.end('{}'); } }
    const q = (u.searchParams.get('q') || '').replace(/-/g, '');
    const items = (LISTAS[m[1]] || []).filter((v) => v.includes(q)).map((v) => ({ id: v, value: v }));
    return res.end(JSON.stringify({ items, total: items.length, page: 1, pageSize: 100 }));
  }
  // rota interna da tela do DataCrazy (aceita o token da API): campos do negócio
  if (u.pathname.startsWith('/api/crm/additional-fields/business/B1')) {
    if (req.headers.authorization !== 'Bearer dc_teste') { res.statusCode = 401; return res.end('{}'); }
    const DC = global.DC;
    if (req.method === 'GET') return res.end(JSON.stringify({ data: DC.camposNegocio.map((c) => ({ id: 'v' + c.id, additionalField: { id: c.id, name: c.name, type: 'string' }, value: c.value ?? null })) }));
    const id = u.pathname.split('/').pop();
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { DC.camposNegocio.find((c) => c.id === id).value = JSON.parse(b).value; res.end('{}'); }); return;
  }
  if (u.pathname.startsWith('/v23.0/') && !['meta_teste', 'meta_bm2'].includes(u.searchParams.get('access_token'))) { res.statusCode = 400; return res.end(JSON.stringify({ error: { message: 'token inválido' } })); }
  if (u.pathname === '/v23.0/me/adaccounts') return res.end(JSON.stringify({ data: u.searchParams.get('access_token') === 'meta_teste' ? [{ account_id: '111', name: 'Conecta Aqui' }, { account_id: '999', name: 'Outra empresa' }] : [] }));
  if (u.pathname === '/v23.0/me/businesses') return res.end(JSON.stringify({ data: u.searchParams.get('access_token') === 'meta_bm2' ? [{ id: 'BM2', name: 'Conecta Aqui Ltda' }] : [] }));
  if (u.pathname === '/v23.0/BM2/owned_whatsapp_business_accounts') return res.end(JSON.stringify({ data: [{ id: 'W1', name: 'Conecta WA', currency: 'BRL' }] }));
  if (u.pathname === '/v23.0/BM2/client_whatsapp_business_accounts') return res.end(JSON.stringify({ data: [] }));
  if (u.pathname === '/v23.0/W1') {
    const t = (d) => Math.floor(Date.parse(d + 'T03:00:00Z') / 1000);
    return res.end(JSON.stringify({ id: 'W1', pricing_analytics: { data: [{ data_points: [{ start: t('2026-10-06'), end: t('2026-10-07'), pricing_category: 'MARKETING', volume: 500, cost: 31.25 }, { start: t('2026-10-07'), end: t('2026-10-08'), pricing_category: 'MARKETING', volume: 300, cost: 18.75 }] }] } }));
  }
  if (u.pathname === '/v23.0/act_111/insights') {
    return res.end(JSON.stringify({ data: [
      { date_start: '2026-10-06', campaign_id: 'M1', campaign_name: 'Meta WhatsApp', spend: '40.50', impressions: '5000', clicks: '120', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '20' }] },
      { date_start: '2026-10-07', campaign_id: 'M1', campaign_name: 'Meta WhatsApp', spend: '59.50', impressions: '6000', clicks: '140', actions: [{ action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '30' }] },
    ] }));
  }
  if (u.pathname.startsWith('/api/v1/')) {
    if (req.headers.authorization !== 'Bearer dc_teste') { res.statusCode = 401; return res.end('{}'); }
    const DC = global.DC;
    // negócio: a API pública não tem /additional-fields/business (404); o negócio traz additionalFields.
    // O fake só aceita { additionalFields: [{ additionalFieldId, value }] } (testa a troca de formato).
    const negJson = () => ({ ...DC.negocio, additionalFields: [] }); // a API pública devolve os campos vazios
    if (u.pathname === '/api/v1/businesses/B1' && req.method === 'GET') return res.end(JSON.stringify(negJson()));
    if (u.pathname === '/api/v1/products' && req.method === 'GET') return res.end(JSON.stringify({ count: DC.produtos.length, data: DC.produtos }));
    if (u.pathname === '/api/v1/products' && req.method === 'POST') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const p = { id: 'P' + (DC.produtos.length + 1), ...JSON.parse(b) }; DC.produtos.push(p); res.end(JSON.stringify(p)); }); return; }
    if (u.pathname === '/api/v1/leads/L1/businesses') return res.end(JSON.stringify({ data: [DC.negocio] }));
    if (u.pathname === '/api/v1/businesses/B1' && req.method === 'PATCH') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const j = JSON.parse(b); DC.tentativas.push(Object.keys(j).join(',')); if (j.products && j.products[0].product) DC.negocio.products = j.products.map((x) => ({ id: 'bp1', product: { id: x.product.id, name: x.product.name }, quantity: x.quantity, price: x.price, total: x.total })); res.end(JSON.stringify(negJson())); }); return; }
    if (u.pathname === '/api/v1/pipelines') return res.end(JSON.stringify({ data: [{ id: 'p1', name: 'Vendas' }] }));
    if (u.pathname === '/api/v1/pipelines/p1/stages') return res.end(JSON.stringify({ data: [{ id: 's1', name: 'Novo' }, { id: 's9', name: 'Pendente de Instalacao' }] }));
    if (u.pathname === '/api/v1/tags' && req.method === 'GET') return res.end(JSON.stringify({ data: DC.tags }));
    if (u.pathname === '/api/v1/tags' && req.method === 'POST') { const t = { id: 't' + (DC.tags.length + 1), name: 'googleads' }; DC.tags.push(t); return res.end(JSON.stringify(t)); }
    if (u.pathname === '/api/v1/conversations') return res.end(JSON.stringify({ data: !Number(u.searchParams.get('skip')) ? [{ id: 'c1', lastReceivedMessageDate: new Date().toISOString(), contact: { name: 'Ana', phoneNumber: '5521999991234' } }] : [] }));
    if (u.pathname === '/api/v1/conversations/c1/messages') return res.end(JSON.stringify({ data: DC.msgs || [{ id: 'm1', body: 'Olá! Quero contratar o plano X\n(Ref: G-ABCDE)', received: true }] }));
    if (u.pathname === '/api/v1/leads' && req.method === 'GET') return res.end(JSON.stringify({ data: u.searchParams.get('search') === 'TESTE API' ? [{ id: 'L1', name: 'TESTE API' }] : (u.searchParams.get('search') || '').endsWith('999991234') ? [DC.lead] : [] }));
    if (u.pathname === '/api/v1/leads/L1' && req.method === 'PATCH') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { const j = JSON.parse(b); if (j.tags) DC.lead.tags = j.tags; if (j.address) DC.lead.address = j.address; if (j.additionalFields) DC.lead.extras = j.additionalFields; res.end('{}'); }); return; }
    if (u.pathname === '/api/v1/businesses') return res.end(JSON.stringify({ data: u.searchParams.get('skip') === '0' ? [{ id: 'B1', code: 101, leadId: 'L1', stageId: 's9', lastMovedAt: '2026-10-07T15:30:00.000Z', total: 120 }] : [] }));
    res.statusCode = 404; return res.end('{}');
  }
  const vc = u.pathname.match(/^\/ws\/(\d{8})\/json\/$/);
  if (vc) return res.end(JSON.stringify({ cep: vc[1], uf: vc[1] < '20000000' ? 'SP' : 'RJ', localidade: vc[1] < '20000000' ? 'São Paulo' : 'Rio de Janeiro' }));
  res.statusCode = 404; res.end('{}');
});

(async () => {
  await new Promise((r) => mcc.listen(0, r));
  process.env.MCC_BASE_URL = `http://127.0.0.1:${mcc.address().port}`;
  process.env.MCC_EMAIL = 'ponte@x.com';
  process.env.VIACEP_URL = process.env.MCC_BASE_URL;
  process.env.CEP_FONTES = 'viacep';
  process.env.DATACRAZY_URL = process.env.MCC_BASE_URL;
  process.env.DATACRAZY_TOKEN = 'dc_teste';
  process.env.DATACRAZY_ESPACO_MS = '0';
  process.env.DATACRAZY_CRM_URL = process.env.MCC_BASE_URL;
  process.env.ADS_FEED_TOKEN = 'feedtoken1234567890';
  process.env.META_GRAPH_URL = process.env.MCC_BASE_URL; process.env.META_TOKEN = 'meta_teste'; process.env.META_TOKEN_2 = 'meta_bm2'; process.env.META_CONTAS = 'act_111';
  process.env.ADS_FEED_USER = 'conectaaqui';
  process.env.ADS_FEED_PASS = 'senhaFeed';
  global.DC = { tags: [{ id: 't1', name: 'Cliente' }], lead: { id: 'L1', name: 'Ana', phone: '+5521999991234', tags: [{ id: 't1', name: 'Cliente' }] }, produtos: [{ id: 'P0', name: 'Nio Fibra 600', id_sku: 'nf500', price: 110 }], negocio: { id: 'B1', code: 101, leadId: 'L1', status: 'in_process', products: [] }, tentativas: [], camposNegocio: [{ id: 'f1', name: 'Plano' }, { id: 'f2', name: 'Operadora escolhida' }, { id: 'f3', name: 'Vendedor', value: 'Ana' }] };
  process.env.MCC_PASSWORD = 'segredo';
  process.env.ADMIN_PASSWORD = 'admin123';
  process.env.WHATSAPP_NUMBER = '5521900000000';
  process.env.MANTER_EXEMPLOS = '1';
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
    const imp = await send('/admin/api/planos/importar', 'POST', 'operadoraId;nome;preco\nclaro;Ok;99,9\noi-inexistente;Ruim;10', { ...H, 'content-type': 'text/csv' });
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
  await t('Faixas de CEP: gera resumo por prefixo e exporta CSV', async () => {
    assert.equal((await send('/admin/api/faixas/gerar', 'POST', {}, H)).s, 200);
    let f; for (let i = 0; i < 50; i++) { f = (await get('/admin/api/faixas', H)).j; if (!f.status.rodando) break; await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(!f.status.erro, f.status.erro); assert.ok(f.quantidade > 0);
    assert.ok(f.topo.every((l) => /^\d{5}$/.test(l.prefixo)));
    const r = await fetchOrig(B + '/admin/api/faixas/exportar', { headers: { cookie } });
    assert.ok((await r.text()).includes('prefixo;uf;cidade;total;'));
  });
  await t('Google Ads → DataCrazy: código no WhatsApp vira tag e venda vira conversão offline', async () => {
    // clique em "Quero este plano" vindo de anúncio
    await send('/api/clique', 'POST', { planoNome: 'Nio Fibra', operadora: 'Nio', valor: 110, cep: '35700-001', rua: 'Rua A', numero: '12', bairro: 'Centro', cidade: 'Sete Lagoas', uf: 'MG', rastreio: { ref: 'G-ABCDE', gclid: 'Cj0KCQabc123', utm_source: 'google' } });
    // clique sem anúncio não registra
    await send('/api/clique', 'POST', { planoNome: 'Nio Fibra', rastreio: { ref: 'G-ZZZZZ' } });
    const st = (await send('/admin/api/datacrazy/sincronizar', 'POST', {}, H)).j;
    assert.ok(!st.erro, st.erro);
    assert.deepEqual(global.DC.lead.tags.map((x) => x.id).sort(), ['t1', 't2'], 'tag googleads adicionada mantendo as outras');
    assert.deepEqual(global.DC.lead.address, { zip: '35700001', address: 'Rua A, 12', block: 'Centro', city: 'Sete Lagoas', state: 'MG', country: 'Brasil' });
    assert.deepEqual(global.DC.camposNegocio.map((c) => [c.name, c.value]), [['Plano', 'Nio Fibra'], ['Operadora escolhida', 'Nio'], ['Vendedor', 'Ana']], 'campos do negócio');
    assert.deepEqual(global.DC.produtos.map((p) => p.name), ['Nio Fibra 600', 'Nio Fibra'], 'plano sem velocidade não acha no catálogo: cria');
    assert.deepEqual(global.DC.negocio.products.map((p) => [p.product.name, p.price]), [['Nio Fibra', 110]], 'produto no negócio');
    const d = (await get('/admin/api/datacrazy', H)).j;
    assert.equal(d.cliquesGoogle, 1); assert.equal(d.vinculos, 1); assert.equal(d.conversoes.length, 1);
    assert.ok(d.feedUrl.endsWith('/ads/conversoes/feedtoken1234567890.csv'));
    assert.equal((await fetchOrig(B + '/ads/conversoes/feedtoken1234567890.csv')).status, 401, 'sem senha recusa');
    const csvR = await fetchOrig(B + '/ads/conversoes/feedtoken1234567890.csv', { headers: { authorization: 'Basic ' + Buffer.from('conectaaqui:senhaFeed').toString('base64') } }); const csvT = await csvR.text();
    assert.ok(csvT.startsWith('Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency'));
    assert.ok(csvT.includes('Cj0KCQabc123,Venda - Pendente de instalação,2026-10-07 12:30:00-03:00,120.00,BRL'), csvT);
    assert.equal((await fetchOrig(B + '/ads/conversoes/tokenerrado123456789.csv')).status, 404);
    // segunda sincronização não duplica
    await send('/admin/api/datacrazy/sincronizar', 'POST', {}, H);
    assert.equal((await get('/admin/api/datacrazy', H)).j.conversoes.length, 1);
    const diag = (await get('/admin/api/datacrazy/diagnostico', H)).j;
    assert.ok(diag.etapaEncontrada && diag.tagExiste && diag.temTelefoneNaConversa, JSON.stringify(diag));
  });
  await t('Botão de teste grava campos e produto no negócio TESTE API', async () => {
    global.DC.camposNegocio.forEach((c) => { if (c.id !== 'f3') c.value = null; }); global.DC.negocio.products = [];
    const r = (await send('/admin/api/datacrazy/testar-negocio', 'POST', { nome: 'TESTE API' }, H)).j;
    assert.ok(!r.erro, r.erro);
    assert.equal(r.camposGravados, 2); assert.equal(r.produtoColocado, true); assert.equal(r.produto, 'Nio Fibra 600');
    assert.deepEqual(r.tentativas.map((x) => [x.etapa, x.ok]), [['campo', true], ['campo', true], ['produto', true]]);
    assert.deepEqual(r.camposAgora, { Plano: 'Nio Fibra 600 Mega', 'Operadora escolhida': 'Nio' });
    assert.equal(global.DC.camposNegocio[0].value, 'Nio Fibra 600 Mega');
  });
  await t('Nova mensagem do site na mesma conversa é processada de novo', async () => {
    global.DC.msgs = [{ id: 'm1', body: 'Olá! Quero contratar o plano X\n(Ref: G-ABCDE)', received: true, createdAt: '2026-10-07T10:00:00Z' }, { id: 'm2', body: 'Olá! Quero contratar o plano Claro Fibra 500 Mega (Claro) de R$ 69,90/mês.\nEndereço: Rua B, 5 - Centro - Niterói/RJ - CEP 24000-000', received: true, createdAt: '2026-10-08T02:30:00Z' }];
    await send('/admin/api/datacrazy/sincronizar', 'POST', {}, H);
    const log = (await get('/admin/api/datacrazy', H)).j.log.join('\n');
    assert.ok(log.includes('plano Claro Fibra 500 Mega (Claro) na fila'), log);
    await send('/admin/api/datacrazy/sincronizar', 'POST', {}, H);
    const log2 = (await get('/admin/api/datacrazy', H)).j.log;
    assert.equal(log2.filter((l) => l.includes('Claro Fibra 500 Mega (Claro) na fila')).length, 1, 'não repete a mesma mensagem');
    // a escolha nova substitui o que o sistema tinha preenchido (mas não o que a equipe preencheu)
    assert.deepEqual(global.DC.camposNegocio.map((c) => c.value), ['Claro Fibra 500 Mega', 'Claro', 'Ana']);
    assert.deepEqual(global.DC.negocio.products.map((p) => p.product.name), ['Claro Fibra 500 Mega'].map(() => global.DC.negocio.products[0].product.name));
    assert.ok(/claro/i.test(global.DC.negocio.products[0].product.name), JSON.stringify(global.DC.negocio.products));
    assert.equal(global.DC.lead.address.zip, '24000000', 'endereço novo substitui o antigo');
    delete global.DC.msgs;
  });
  await t('Tráfego: gasto do Google (script) e do Meta (API) + funil do DataCrazy', async () => {
    assert.equal((await fetchOrig(B + '/ads/gasto/google/tokenerrado123456789', { method: 'POST', body: '{}' })).status, 404);
    const linhas = [
      { data: '2026-10-06', campanhaId: '24330418004', campanha: 'CA | Pesquisa', status: 'ENABLED', gasto: 120.5, impressoes: 900, cliques: 40, conversoes: 3 },
      { data: '2026-10-07', campanhaId: '24330418004', campanha: 'CA | Pesquisa', status: 'ENABLED', gasto: 79.5, impressoes: 700, cliques: 30, conversoes: 2 },
    ];
    const r = await fetchOrig(B + '/ads/gasto/google/feedtoken1234567890', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versao: 2, conta: '1037631507', linhas, termos: [{ termo: 'claro boleto', campanha: 'CA', grupo: 'Op', gasto: 12, cliques: 3, conversoes: 0 }],
      parcela: [{ data: '2026-10-06', campanhaId: '24330418004', impressoes: 900, parcela: 0.4, perdidaOrcamento: 0.15, perdidaRanking: 0.45, topo: 0.6, topoAbsoluto: 0.2 }, { data: '2026-10-07', campanhaId: '24330418004', impressoes: 700, parcela: 0.5, perdidaOrcamento: 0.1, perdidaRanking: 0.4, topo: 0.7, topoAbsoluto: 0.25 }],
      palavras: [{ id: '1', palavra: 'internet fibra sete lagoas', tipo: 'PHRASE', qualidade: 8, campanha: 'CA', grupo: 'Fibra', gasto: 40, impressoes: 300, cliques: 20, conversoes: 3, parcela: 0.5, perdidaRanking: 0.35, topoAbsoluto: 0.3 }, { id: '2', palavra: 'planos de internet', tipo: 'BROAD', qualidade: 3, campanha: 'CA', grupo: 'Fibra', gasto: 90, impressoes: 900, cliques: 30, conversoes: 0, parcela: 0.2, perdidaRanking: 0.6, topoAbsoluto: 0.1 }],
      cidades: [{ id: '1001773', nome: 'Sete Lagoas,State of Minas Gerais,Brazil', gasto: 60, impressoes: 400, cliques: 25, conversoes: 4 }, { id: '1031703', nome: 'Montes Claros,State of Minas Gerais,Brazil', gasto: 70, impressoes: 500, cliques: 20, conversoes: 0 }] }) });
    assert.equal((await r.json()).linhas, 2);
    // reenviar não duplica
    await fetchOrig(B + '/ads/gasto/google/feedtoken1234567890', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ versao: 2, linhas }) });
    const at = (await send('/admin/api/trafego/atualizar', 'POST', {}, H)).j;
    assert.equal(at.meta.linhas, 4, JSON.stringify(at));
    assert.deepEqual(at.meta.wabas, ['Conecta WA']); assert.deepEqual(at.meta.contasLidas, ['Conecta Aqui (111)'], 'META_CONTAS filtra a conta de outra empresa');
    const rel = (await get('/admin/api/trafego?de=2026-10-01&ate=2026-10-31', H)).j;
    assert.equal(rel.canais.google.gasto, 200); assert.equal(rel.canais.meta.gasto, 100); assert.equal(rel.canais.disparos.gasto, 50); assert.equal(rel.canais.total.gasto, 350);
    assert.equal(rel.canais.meta.convPlataforma, 50);
    assert.equal(rel.canais.google.vendas, 1, 'negócio em Pendente de Instalação conta como venda do Google');
    assert.equal(rel.canais.google.cpv, 200);
    assert.equal(rel.funil.canais.google.passos[3], 1);
    assert.equal(rel.campanhas.length, 3); assert.ok(rel.campanhas.some((c) => c.canal === 'disparos' && c.campanha === 'WhatsApp API · Conecta WA · Marketing' && c.gasto === 50 && c.impressoes === 800)); assert.equal(rel.termosSemConversao[0].termo, 'claro boleto');
    assert.equal(rel.serie.length, 31); assert.equal(rel.serie.find((x) => x.data === '2026-10-07').gasto.meta, 59.5);
    const ps = rel.pesquisa;
    assert.equal(ps.resumo.parcela, 44.4); assert.equal(ps.resumo.perdidaRanking, 42.8);
    const tipos = ps.recomendacoes.map((x) => x.tipo);
    for (const t of ['Orçamento', 'Posição', 'Palavra vencedora', 'Palavra sem resultado', 'Índice de qualidade', 'Cidades']) assert.ok(tipos.includes(t), t + ' em ' + tipos.join(','));
    assert.equal(ps.cidades[0].nome, 'Montes Claros/MG');
    assert.ok(!rel.alertas.some((a) => /versão nova do script/.test(a.texto)), 'script v2 não pede atualização');
    const pub = await fetchOrig(B + '/ads/relatorio/feedtoken1234567890.json?de=2026-10-01&ate=2026-10-31');
    assert.equal((await pub.json()).canais.total.gasto, 350);
    assert.equal((await fetchOrig(B + '/ads/relatorio/tokenerrado123456789.json')).status, 404);
    const tx = await (await fetchOrig(B + '/ads/relatorio/feedtoken1234567890.txt?de=2026-10-01&ate=2026-10-31')).text();
    assert.ok(tx.includes('REDE DE PESQUISA') && tx.includes('"planos de internet"') && tx.includes('- google: gasto R$ 200,00'), tx.slice(0, 600));
    const cfg = (await send('/admin/api/trafego/config', 'PUT', { metaVendasMes: 40, metaCpv: '150' }, H)).j;
    assert.equal(cfg.metaVendasMes, 40); assert.equal(cfg.metaCpv, 150);
    const sc = await fetchOrig(B + '/admin/api/trafego/script-google', { headers: { cookie, 'x-requested-with': 'painel' } });
    const txt = await sc.text();
    assert.ok(txt.includes('/ads/gasto/google/feedtoken1234567890') && txt.includes('function main()') && txt.includes('search_impression_share') && txt.includes('versao: 2'), txt.slice(0, 200));
    const f = require('../lib/funil');
    assert.equal(f.respondeu({ origem: 'disparos', passo: 0, etapa: 'Lead API', passos: {} }), false);
    assert.equal(f.respondeu({ origem: 'disparos', passo: 0, etapa: 'ATENDIMENTO IA', passos: {} }), true);
    assert.equal(f.respondeu({ origem: 'disparos', passo: 0, etapa: 'Sem interação template', perdido: 'Sem interação template', passos: {} }), false);
    assert.equal(f.respondeu({ origem: 'disparos', passo: 1, etapa: 'Plano Claro', passos: {} }), true);
    assert.equal(f.respondeu({ origem: 'meta', passo: 0, etapa: 'Lead Meta', passos: {} }), true);
    assert.deepEqual(f.classificar('Sem viabilidade', 'CANCELAMENTOS'), { passo: null, perdido: 'Sem viabilidade' });
    assert.equal(f.classificar('Instalado', 'OPERAÇÃO').passo, 'instalado');
    assert.equal(f.classificar('Etapa 1 - Análise de Crédito', 'OPERAÇÃO').passo, 'credito');
    assert.equal(f.origemDe({ lead: { tags: [{ name: 'meta_ads' }, { name: 'api_5667' }] } }, 'Lead API', false), 'meta');
    assert.equal(f.origemDe({ lead: { tags: [{ name: 'api_5667' }] } }, 'Plano Claro', false), 'disparos');
    assert.equal(f.origemDe({ lead: { tags: [] } }, 'Lead API', false), 'disparos');
    assert.equal(f.origemDe({ lead: { tags: [] } }, 'DISPARO 2', false), 'disparos');
  });
  await t('Clique e formulário sem anúncio (rastreio nulo) não dão erro', async () => {
    assert.equal((await send('/api/clique', 'POST', { planoNome: 'Nio Fibra', operadora: 'Nio', rastreio: null })).s, 200);
    assert.equal((await send('/api/contato', 'POST', { nome: 'Teste Sem Anuncio', telefone: '21988887777', rastreio: null })).s, 200);
  });
  await t('Texto da mensagem em formatos diferentes (API oficial)', async () => {
    const dc = require('../lib/datacrazy');
    assert.equal(dc.textoMsg({ body: 'oi' }), 'oi');
    assert.equal(dc.textoMsg({ id: 'abcdef0123456789abcdef', content: { text: 'Quero contratar o plano X (Nio)' } }), 'Quero contratar o plano X (Nio)');
    assert.equal(dc.textoMsg({ message: { conversation: 'Olá! Quero contratar o plano Y (Claro)' }, createdAt: '2026-10-08T10:00:00Z' }), 'Olá! Quero contratar o plano Y (Claro)');
    const d = (await fetchOrig(B + '/ads/diagnostico/feedtoken1234567890.json')).status; assert.equal(d, 200);
    assert.equal((await fetchOrig(B + '/ads/diagnostico/tokenerrado123456789.json')).status, 404);
  });
  await t('Lê plano e endereço da mensagem do site', async () => {
    const { lerMensagemSite } = require('../lib/datacrazy');
    const d = lerMensagemSite('Olá! Quero contratar o plano Nio Fibra 600 Mega (Nio) de R$\u00a0110,00/mês.\nEndereço: Rua das Flores, 123 - Centro - Sete Lagoas/MG - CEP 35700-001\n(Ref: G-ABCDE)');
    assert.deepEqual(d, { plano: 'Nio Fibra 600 Mega', operadora: 'Nio', valor: 110, cep: '35700001', cidade: 'Sete Lagoas', uf: 'MG', rua: 'Rua das Flores', numero: '123', bairro: 'Centro' });
    assert.equal(lerMensagemSite('Olá! Quero ajuda para escolher um plano de internet.'), null);
    const dc = require('../lib/datacrazy');
    assert.equal(dc.nomeOperadora('TIM'), 'Tim'); assert.equal(dc.nomeOperadora('claro'), 'Claro');
    assert.equal(dc.valorParaCampo({ opcoes: [{ label: 'TIM' }] }, 'Tim'), 'TIM');
    assert.equal(dc.nomeProduto({ plano: 'Fibra 500 Mega', operadora: 'Claro' }), 'Claro Fibra 500');
    const cat = [{ name: 'Nio Fibra 600', price: 110 }, { name: 'Tim Fibra 600 + Paramount', price: 109.9 }, { name: 'Tim Fibra 600', price: 99 }, { name: 'Nio Fibra 1 GB Promo', price: 75 }];
    assert.equal(dc.acharNoCatalogo(cat, { plano: 'Nio Fibra 600 Mega', operadora: 'Nio', valor: 110 }).name, 'Nio Fibra 600');
    assert.equal(dc.acharNoCatalogo(cat, { plano: 'TIM Ultrafibra 600 Mega + Paramount+', operadora: 'TIM' }).name, 'Tim Fibra 600 + Paramount');
    assert.equal(dc.acharNoCatalogo(cat, { plano: 'TIM Ultrafibra 600 Mega', operadora: 'TIM' }).name, 'Tim Fibra 600');
    assert.equal(dc.acharNoCatalogo(cat, { plano: 'Nio 1 Giga Promo', operadora: 'Nio' }).name, 'Nio Fibra 1 GB Promo');
    assert.equal(dc.acharNoCatalogo(cat, { plano: 'Nio Essencial 700 Mega + chip 5G', operadora: 'Nio' }), null);
  });
  await t('Arquivos estáticos e proteção de caminho', async () => {
    assert.equal((await fetchOrig(B + '/')).status, 200);
    assert.equal((await fetchOrig(B + '/admin')).status, 200);
    const r = await fetchOrig(B + '/..%2f..%2fserver.js'); assert.notEqual(await r.text().then((t) => t.includes('require(')), true);
  });

  await t('Slides: público lista ativos; painel edita e valida', async () => {
    const pub = await get('/api/slides'); assert.ok(pub.j.length >= 1); assert.ok(pub.j[0].titulo.includes('*melhor plano*'));
    assert.equal((await send('/admin/api/slides', 'PUT', [{ titulo: '', ativo: true }], H)).s, 400);
    assert.equal((await send('/admin/api/slides', 'PUT', [{ titulo: 'A', ativo: false }], H)).s, 400);
    const r = await send('/admin/api/slides', 'PUT', [{ titulo: 'Novo *slide*', imagem: 'javascript:alert(1)', ativo: true }, { titulo: 'Oculto', ativo: false }], H);
    assert.equal(r.s, 200); assert.equal(r.j[0].imagem, '/images/banner-persona.webp');
    assert.equal((await get('/api/slides')).j.length, 1);
  });
  await t('Upload de logo: aceita PNG, recusa outros formatos, serve o arquivo', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a6a30000000049454e44ae426082', 'hex');
    const rr = await fetchOrig(B + '/admin/api/imagem?nome=logo-claro', { method: 'POST', body: png, headers: { ...H, 'content-type': 'image/png' } });
    const j = await rr.json(); assert.equal(rr.status, 200); assert.match(j.url, /^\/uploads\/logo-claro\.png\?v=\d+$/);
    const img = await fetchOrig(B + j.url); assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
    const bad = await fetchOrig(B + '/admin/api/imagem?nome=x', { method: 'POST', body: '<svg onload=alert(1)>', headers: { ...H, 'content-type': 'image/svg+xml' } });
    assert.equal(bad.status, 400);
    assert.equal((await fetchOrig(B + '/uploads/..%2fplanos.json')).status, 404);
    const ops = (await get('/admin/api/operadoras', H)).j; ops.find((o) => o.id === 'claro').logoUrl = j.url;
    const sv = await send('/admin/api/operadoras', 'PUT', ops, H); assert.equal(sv.j.find((o) => o.id === 'claro').logoUrl, j.url);
  });
  await t('Plano com streaming aparece com o nome do serviço', async () => {
    const r = await send('/admin/api/planos', 'POST', { operadoraId: 'tim', nome: 'TIM 600 c/ Paramount', preco: 149.99, precoPromo: 109.99, velocidadeMbps: 600, streaming: ['paramount', 'xyz'] }, H);
    assert.deepEqual(r.j.streaming, ['paramount']);
    const c = await get('/api/cobertura?cep=01002000');
    const p = c.j.planos.find((x) => x.nome === 'TIM 600 c/ Paramount'); assert.deepEqual(p.streaming, [{ id: 'paramount', nome: 'Paramount+' }]);
  });
  await t('Monitor: lê a página da operadora, extrai ofertas e detecta mudança', async () => {
    const monitor = require('../lib/monitor');
    const url = `http://127.0.0.1:${mcc.address().port}/oferta-tim`;
    let r = await monitor.verificarOperadora({ id: 'tim', siteOfertas: url });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ofertas.map((o) => o.velocidadeMbps), [500, 600, 1000]);
    assert.deepEqual(r.ofertas[0].precos, [129.99, 89.99]);
    assert.deepEqual(r.ofertas[1].streaming, ['paramount+']);
    assert.ok(!r.ofertas.some((o) => o.velocidadeMbps === 999), 'ignora texto dentro de <script>');
    const h1 = r.hash;
    await send('/admin/api/monitor/tim/revisado', 'POST', {}, H);
    r = await monitor.verificarOperadora({ id: 'tim', siteOfertas: url }); assert.equal(r.hash, h1); assert.equal(r.revisadoHash, h1);
    global.precoGiga = '179,99';
    r = await monitor.verificarOperadora({ id: 'tim', siteOfertas: url }); assert.notEqual(r.hash, h1); assert.notEqual(r.revisadoHash, r.hash);
    const viaPainel = await get('/admin/api/monitor', H); assert.equal(viaPainel.j.tim.ofertas[2].precos[0], 179.99);
  });

  await t('Migração: logos oficiais, Vivo e troca de exemplos por planos reais', async () => {
    const store = require('../lib/store');
    const ops = (await get('/admin/api/operadoras', H)).j;
    assert.ok(ops.find((o) => o.id === 'vivo'), 'Vivo adicionada');
    assert.equal(ops.find((o) => o.id === 'nio').logoUrl, '/images/operadoras/nio.png');
    assert.equal((await fetchOrig(B + '/images/operadoras/tim.png')).status, 200);
    // com só exemplos e sem MANTER_EXEMPLOS, troca pelos reais
    delete process.env.MANTER_EXEMPLOS;
    store.save('planos', store.load('planos', []).filter((p) => /^Exemplo /.test(p.nome)));
    store.init();
    const nomes = store.load('planos', []).map((p) => p.nome);
    assert.ok(nomes.includes('Nio Super 800 Mega + Globoplay'));
    assert.ok(!nomes.some((n) => /^Exemplo /.test(n)));
    // planos cadastrados pela equipe nunca são trocados
    store.init(); assert.equal(store.load('planos', []).length, nomes.length);
  });

  console.log(`\n${ok} testes passaram.`);
  servidor.close(); mcc.close();
})().catch((e) => { console.error('✗ FALHOU:', e); process.exit(1); });
