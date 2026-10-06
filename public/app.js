(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const vel = (mb) => (mb >= 1000 ? { n: (mb / 1000).toLocaleString('pt-BR'), u: mb >= 2000 ? 'Gigas' : 'Giga' } : { n: mb, u: 'Mega' });

  const TIPO_NOME = { internet: 'Internet', 'combo-tv': 'Internet + TV', 'combo-movel': 'Internet + Celular', 'combo-completo': 'Combo completo', movel: 'Celular', tv: 'TV' };
  // cada aba mostra também o combo completo quando faz sentido
  const TIPO_ABA = { todos: null, internet: ['internet'], 'combo-tv': ['combo-tv', 'combo-completo'], 'combo-movel': ['combo-movel', 'combo-completo'], 'combo-completo': ['combo-completo'] };
  const passaTipo = (p) => !TIPO_ABA[estado.tipo] || TIPO_ABA[estado.tipo].includes(p.tipo);
  const estado = { tipo: 'todos', ordem: 'relevancia', ops: new Set(), resultado: null, config: {}, planoEscolhido: null, origemContato: 'contato' };
  $('#ano').textContent = new Date().getFullYear();

  // ---------- menu mobile ----------
  $('#hamb').addEventListener('click', () => {
    const aberto = $('#menu').classList.toggle('aberto');
    $('#hamb').setAttribute('aria-expanded', aberto);
  });
  $$('#menu a').forEach((a) => a.addEventListener('click', () => { $('#menu').classList.remove('aberto'); $('#hamb').setAttribute('aria-expanded', false); }));
  $$('a[data-tipo]').forEach((a) => a.addEventListener('click', () => selecionarAba(a.dataset.tipo)));
  $$('[data-ir-tipo]').forEach((b) => b.addEventListener('click', () => {
    selecionarAba(b.dataset.irTipo);
    if (estado.resultado) { $('#resultados').scrollIntoView({ behavior: 'smooth' }); return; }
    $('#buscar').scrollIntoView({ behavior: 'smooth' }); setTimeout(() => inputCep.focus({ preventScroll: true }), 450);
  }));

  // ---------- WhatsApp / contato ----------
  function linkWhats(msg) {
    const n = estado.config.whatsapp;
    return n ? `https://wa.me/${n}?text=${encodeURIComponent(msg)}` : null;
  }
  fetch('/api/config').then((r) => r.json()).then((c) => {
    estado.config = c;
    const l = linkWhats('Olá! Quero ajuda para escolher um plano de internet.');
    for (const id of ['waTopo', 'waFlutuante', 'waBanner']) { if (l) $('#' + id).href = l; else $('#' + id).classList.add('oculto'); }
    const box = $('#rodapeContato');
    if (l) box.insertAdjacentHTML('beforeend', `<a href="${esc(l)}" target="_blank" rel="noopener">WhatsApp</a>`);
    if (c.telefone) box.insertAdjacentHTML('beforeend', `<a href="tel:${esc(c.telefone.replace(/[^\d+]/g, ''))}">${esc(c.telefone)}</a>`);
    if (c.email) box.insertAdjacentHTML('beforeend', `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`);
  }).catch(() => {});

  // ---------- abas ----------
  function selecionarAba(tipo) {
    estado.tipo = tipo;
    $$('.aba').forEach((b) => { const on = b.dataset.tipo === tipo; b.classList.toggle('ativa', on); b.setAttribute('aria-selected', on); });
    renderChipsTipo();
    if (estado.resultado) renderResultados();
  }
  $$('.aba').forEach((b) => b.addEventListener('click', () => selecionarAba(b.dataset.tipo)));

  // ---------- CEP ----------
  const inputCep = $('#cep');
  inputCep.addEventListener('input', () => {
    const d = inputCep.value.replace(/\D/g, '').slice(0, 8);
    inputCep.value = d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d;
    inputCep.removeAttribute('aria-invalid');
  });

  $('#formBusca').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cep = inputCep.value.replace(/\D/g, '');
    if (cep.length !== 8) { inputCep.setAttribute('aria-invalid', 'true'); inputCep.focus(); return; }
    await buscar(cep);
  });

  async function buscar(cep) {
    const btn = $('#btnBuscar');
    btn.disabled = true; btn.textContent = 'Buscando…';
    $('#resultados').classList.remove('oculto');
    $('#semCobertura').classList.add('oculto');
    $('#chipsOperadoras').innerHTML = '';
    $('#gradePlanos').innerHTML = '<div class="esqueleto"></div><div class="esqueleto"></div><div class="esqueleto"></div>';
    $('#resTitulo').textContent = 'Buscando planos…';
    $('#resEndereco').textContent = '';
    $('#resultados').scrollIntoView({ behavior: 'smooth', block: 'start' });
    try {
      const r = await fetch('/api/cobertura?cep=' + cep);
      const j = await r.json();
      if (!r.ok) throw new Error(j.erro || 'Erro na busca');
      estado.resultado = j;
      estado.ops = new Set(j.operadoras.map((o) => o.id));
      history.replaceState(null, '', '?cep=' + cep + '#resultados');
      renderResultados();
    } catch (e) {
      $('#resTitulo').textContent = 'Não foi possível buscar agora';
      $('#gradePlanos').innerHTML = `<p class="vazio">${esc(e.message)}</p>`;
    } finally {
      btn.disabled = false; btn.textContent = 'Ver planos';
    }
  }

  function renderResultados() {
    const j = estado.resultado;
    const e = j.endereco;
    const cepFmt = j.cep.slice(0, 5) + '-' + j.cep.slice(5);
    $('#resEndereco').textContent = e ? [e.logradouro, e.bairro, e.cidade && `${e.cidade}/${e.uf}`].filter(Boolean).join(' · ') + ` · CEP ${cepFmt}` : `CEP ${cepFmt}`;
    $('#avisoDemo').classList.toggle('oculto', !j.demo);

    if (!j.planos.length) {
      $('#resTitulo').textContent = 'Nenhum plano encontrado';
      $('#gradePlanos').innerHTML = '';
      $('#chipsOperadoras').innerHTML = '';
      $('#semCobertura').classList.remove('oculto');
      return;
    }
    $('#semCobertura').classList.add('oculto');

    renderChipsTipo();
    $('#chipsOperadoras').innerHTML = j.operadoras.map((o) => `<button class="chip op" data-op="${esc(o.id)}" aria-pressed="${estado.ops.has(o.id)}"><span class="bola" style="background:${esc(o.cor)}"></span>${esc(o.nome)}</button>`).join('');
    $$('#chipsOperadoras .chip').forEach((c) => c.addEventListener('click', () => {
      const id = c.dataset.op;
      estado.ops.has(id) ? estado.ops.delete(id) : estado.ops.add(id);
      renderResultados();
    }));

    let planos = j.planos.filter((p) => estado.ops.has(p.operadora.id) && passaTipo(p));
    const efetivo = (p) => p.precoPromo ?? p.preco;
    if (estado.ordem === 'preco') planos = [...planos].sort((a, b) => efetivo(a) - efetivo(b));
    if (estado.ordem === 'velocidade') planos = [...planos].sort((a, b) => (b.velocidadeMbps || 0) - (a.velocidadeMbps || 0));

    const nOps = j.operadoras.length;
    $('#resTitulo').textContent = `${j.planos.length} ${j.planos.length === 1 ? 'plano' : 'planos'} de ${nOps} ${nOps === 1 ? 'operadora' : 'operadoras'} no seu endereço`;
    $('#gradePlanos').innerHTML = planos.length ? planos.map(cartao).join('') : '<p class="vazio">Nenhum plano com esses filtros. Tente outra aba ou operadora.</p>';
    ligarBotoesPlano($('#gradePlanos'), planos);
  }
  function renderChipsTipo() {
    const box = $('#chipsTipos');
    if (!estado.resultado || !estado.resultado.planos.length) { box.innerHTML = ''; return; }
    const tem = new Set(estado.resultado.planos.map((p) => p.tipo));
    const opcoes = ['todos', 'internet', 'combo-tv', 'combo-movel', 'combo-completo'].filter((t) => t === 'todos' || TIPO_ABA[t].some((x) => tem.has(x)));
    box.innerHTML = opcoes.map((t) => `<button class="chip tipo" data-t="${t}" aria-pressed="${estado.tipo === t}">${t === 'todos' ? 'Todos' : TIPO_NOME[t]}</button>`).join('');
    $$('.chip.tipo', box).forEach((c) => c.addEventListener('click', () => selecionarAba(c.dataset.t)));
  }
  $('#ordem').addEventListener('change', (e) => { estado.ordem = e.target.value; if (estado.resultado) renderResultados(); });

  function logoOp(o) {
    return o.logoUrl
      ? `<span class="op-logo"><img src="${esc(o.logoUrl)}" alt="" loading="lazy"></span>`
      : `<span class="op-logo" style="background:${esc(o.cor)}">${esc(o.nome.slice(0, 2).toUpperCase())}</span>`;
  }

  function cartao(p) {
    const v = p.velocidadeMbps ? vel(p.velocidadeMbps) : null;
    const temPromo = p.precoPromo != null;
    return `<article class="plano${p.destaque ? ' destaque' : ''}">
      ${p.destaque ? '<span class="tag">Mais escolhido</span>' : ''}
      <div class="op">${logoOp(p.operadora)}${esc(p.operadora.nome)}<span class="tipo-txt">${esc(TIPO_NOME[p.tipo] || 'Internet')}</span></div>
      ${v ? `<div class="vel">${esc(v.n)}<small>${v.u}</small></div>` : ''}
      <div class="nome">${esc(p.nome)}</div>
      ${p.beneficios?.length ? `<ul class="beneficios">${p.beneficios.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
      <div class="preco">
        ${temPromo ? `<div class="de">${brl(p.preco)}</div>` : ''}
        <div class="valor">${brl(temPromo ? p.precoPromo : p.preco)}<small>/mês</small></div>
        ${temPromo && p.mesesPromo ? `<div class="cond">nos ${p.mesesPromo} primeiros meses, depois ${brl(p.preco)}/mês</div>` : ''}
      </div>
      <button class="btn btn-prim largo" data-plano="${esc(p.id)}">Quero este plano</button>
    </article>`;
  }

  function ligarBotoesPlano(container, planos) {
    $$('[data-plano]', container).forEach((b) => b.addEventListener('click', () => {
      estado.planoEscolhido = planos.find((p) => p.id === b.dataset.plano);
      abrirContato('plano');
    }));
  }

  // ---------- destaques, operadoras e recomendação do hero ----------
  function irParaBusca(tipo) {
    if (tipo) selecionarAba(tipo);
    $('#buscar').scrollIntoView({ behavior: 'smooth' });
    setTimeout(() => inputCep.focus({ preventScroll: true }), 450);
  }
  fetch('/api/destaques').then((r) => r.json()).then((j) => {
    $('#gradeDestaques').innerHTML = j.planos.length ? j.planos.map(cartao).join('').replaceAll('Quero este plano', 'Ver se atende meu CEP') : '<p class="vazio">Em breve, novas ofertas.</p>';
    $$('#gradeDestaques [data-plano]').forEach((b) => b.addEventListener('click', () => irParaBusca()));

    const qtd = {}; j.planos.forEach((p) => { qtd[p.operadora.id] = (qtd[p.operadora.id] || 0) + 1; });
    $('#faixaOps').innerHTML = j.operadoras.map((o) => `<div class="op-card">
        <div class="op-nome">${logoOp(o)}${esc(o.nome)}</div>
        <p>Ofertas de internet e combos selecionadas pela Conecta Aqui.</p>
        <button class="btn btn-azul" data-op-buscar="${esc(o.id)}">Ver planos ${esc(o.nome)}</button>
      </div>`).join('');
    $$('[data-op-buscar]').forEach((b) => b.addEventListener('click', () => irParaBusca()));

    // recomendação rotativa sobre a foto do hero
    const recs = j.planos.slice(0, 4);
    if (!recs.length) return;
    let i = 0, timer;
    const box = $('#recomenda');
    const pontos = $('#recomendaPontos');
    pontos.innerHTML = recs.length > 1 ? recs.map((_, k) => `<button aria-label="Recomendação ${k + 1}"></button>`).join('') : '';
    function mostrar(k) {
      i = k; const p = recs[k]; const v = p.velocidadeMbps ? vel(p.velocidadeMbps) : null;
      $('#recomendaCorpo').innerHTML = `<div class="rec-op">${logoOp(p.operadora)}${esc(p.operadora.nome)} · ${esc(TIPO_NOME[p.tipo] || '')}</div>
        <div class="rec-linha">${v ? `<div class="rec-vel">${esc(v.n)}<small> ${v.u}</small></div>` : '<div></div>'}
        <div class="rec-preco"><small>a partir de</small>${brl(p.precoPromo ?? p.preco)}<small>por mês</small></div></div>
        <button class="btn btn-prim" type="button">Ver se atende meu CEP</button>`;
      $('#recomendaCorpo .btn').addEventListener('click', () => irParaBusca());
      $$('button', pontos).forEach((b, x) => b.classList.toggle('on', x === k));
    }
    $$('button', pontos).forEach((b, k) => b.addEventListener('click', () => { mostrar(k); clearInterval(timer); }));
    mostrar(0); box.classList.remove('oculto');
    if (recs.length > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) timer = setInterval(() => mostrar((i + 1) % recs.length), 5000);
  }).catch(() => {});

  // ---------- modal de contato ----------
  const modal = $('#modal');
  function abrirContato(origem) {
    estado.origemContato = origem;
    const p = estado.planoEscolhido;
    $('#modalTitulo').textContent = origem === 'plano' && p ? `${p.operadora.nome} · ${p.nome}` : 'Vamos te ajudar';
    $('#modalTexto').textContent = origem === 'sem-cobertura'
      ? 'Deixe seu nome e telefone. Avisamos quando houver uma opção para o seu endereço.'
      : 'Deixe seu nome e telefone. Em seguida abrimos o WhatsApp para você falar com um especialista.';
    $('#modalErro').textContent = '';
    modal.showModal();
  }
  $$('[data-abrir-contato]').forEach((b) => b.addEventListener('click', () => { estado.planoEscolhido = null; abrirContato(b.dataset.abrirContato); }));

  $('#formContato').addEventListener('submit', async (ev) => {
    if (ev.submitter && ev.submitter.value === 'cancel') return;
    ev.preventDefault();
    const f = new FormData(ev.target);
    const nome = String(f.get('nome') || '').trim();
    const telefone = String(f.get('telefone') || '').replace(/\D/g, '');
    if (nome.length < 2 || telefone.length < 10) { $('#modalErro').textContent = 'Informe seu nome e um WhatsApp com DDD.'; return; }
    const r = estado.resultado || {};
    const p = estado.planoEscolhido;
    const btn = $('#btnEnviar'); btn.disabled = true;
    try {
      const resp = await fetch('/api/contato', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nome, telefone, site: f.get('site'), cep: r.cep, cidade: r.endereco?.cidade, uf: r.endereco?.uf, planoNome: p?.nome, operadora: p?.operadora.nome, origem: estado.origemContato }),
      });
      if (!resp.ok) throw new Error((await resp.json()).erro);
    } catch (e) {
      $('#modalErro').textContent = e.message || 'Não foi possível enviar. Tente de novo.'; btn.disabled = false; return;
    }
    btn.disabled = false;
    modal.close();
    ev.target.reset();
    const msg = p
      ? `Olá! Sou ${nome}. Tenho interesse no plano ${p.nome} (${p.operadora.nome}) para o CEP ${r.cep}.`
      : `Olá! Sou ${nome}. Busquei internet para o CEP ${r.cep || ''} e quero ajuda.`;
    const destino = p?.linkContratacao && !estado.config.whatsapp ? p.linkContratacao : linkWhats(msg);
    if (destino && estado.origemContato !== 'sem-cobertura') window.open(destino, '_blank', 'noopener');
    else alertaOk();
  });
  function alertaOk() {
    $('#semCobertura').innerHTML = '<h3>Recebemos seu contato!</h3><p>Nossa equipe vai falar com você em breve.</p>';
  }

  // ---------- CEP na URL ----------
  const cepUrl = new URLSearchParams(location.search).get('cep');
  if (cepUrl && /^\d{8}$/.test(cepUrl)) { inputCep.value = cepUrl.slice(0, 5) + '-' + cepUrl.slice(5); buscar(cepUrl); }
})();
