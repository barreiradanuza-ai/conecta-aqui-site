(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const vel = (mb) => (mb >= 1000 ? { n: (mb / 1000).toLocaleString('pt-BR'), u: mb >= 2000 ? 'Gigas' : 'Giga' } : { n: mb, u: 'Mega' });

  const TIPO_NOME = { internet: 'Internet residencial', 'combo-tv': 'Internet + TV', 'combo-movel': 'Internet + Celular', 'combo-completo': 'Combo completo', movel: 'Celular', tv: 'TV' };
  // cada aba mostra também o combo completo quando faz sentido
  const TIPO_ABA = { todos: null, internet: ['internet'], 'combo-tv': ['combo-tv', 'combo-completo'], 'combo-movel': ['combo-movel', 'combo-completo'], 'combo-completo': ['combo-completo'] };
  const passaTipo = (p) => !TIPO_ABA[estado.tipo] || TIPO_ABA[estado.tipo].includes(p.tipo);
  const estado = { soStreaming: false, endereco: null, tipo: 'todos', ordem: 'relevancia', ops: new Set(), resultado: null, config: {}, planoEscolhido: null, origemContato: 'contato' };
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
    for (const id of ['waTopo', 'waFlutuante', 'waBanner', 'waHero']) { const el = $('#' + id); if (!el) continue; if (l) el.href = l; else el.classList.add('oculto'); }
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

  // ---------- busca em 2 passos: CEP → número ----------
  const inputCep = $('#cep');
  const inputRua = $('#rua');
  const inputNum = $('#numero');
  const local = $('#local');
  const passoCep = $('#passoCep');
  const passoNum = $('#passoNum');
  let ultimoCep = '';

  function aviso(txt, erro = false) { local.className = 'local' + (erro ? ' erro' : ''); local.textContent = txt || ''; }
  function carregando(btn, on) { btn.classList.toggle('carregando', on); btn.disabled = on; }

  function irParaNumero(endereco) {
    estado.endereco = endereco;
    const temRua = !!(endereco && endereco.logradouro);
    $('#endRua').textContent = temRua ? endereco.logradouro : 'CEP ' + inputCep.value;
    $('#endLocal').textContent = endereco ? [endereco.bairro, endereco.cidade && `${endereco.cidade}/${endereco.uf}`].filter(Boolean).join(' · ') : 'Não encontramos o nome da rua. Digite abaixo.';
    inputRua.value = temRua ? endereco.logradouro : '';
    $('#ruaWrap').classList.toggle('oculto', temRua);
    passoCep.classList.add('oculto'); passoNum.classList.remove('oculto');
    $('#naoSei').classList.add('oculto');
    aviso('');
    (temRua ? inputNum : inputRua).focus({ preventScroll: true });
  }
  function voltarParaCep() {
    passoNum.classList.add('oculto'); passoCep.classList.remove('oculto');
    $('#naoSei').classList.remove('oculto');
    ultimoCep = ''; aviso(''); inputCep.select(); inputCep.focus();
  }
  $('#trocarCep').addEventListener('click', voltarParaCep);

  async function verificarCep(cep) {
    if (cep === ultimoCep) return;
    ultimoCep = cep;
    const btn = $('#btnCep'); carregando(btn, true); aviso('');
    try {
      const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: AbortSignal.timeout(6000) });
      const j = await r.json();
      if (cep !== ultimoCep) return;
      if (j.erro) { ultimoCep = ''; inputCep.setAttribute('aria-invalid', 'true'); aviso('CEP não encontrado. Confira os números.', true); return; }
      irParaNumero({ logradouro: j.logradouro || '', bairro: j.bairro || '', cidade: j.localidade || '', uf: j.uf || '' });
    } catch {
      if (cep === ultimoCep) irParaNumero(null); // sem internet para o ViaCEP: a pessoa digita a rua
    } finally { carregando(btn, false); }
  }
  const completarEndereco = verificarCep;

  inputCep.addEventListener('input', () => {
    const d = inputCep.value.replace(/\D/g, '').slice(0, 8);
    inputCep.value = d.length > 5 ? d.slice(0, 5) + '-' + d.slice(5) : d;
    inputCep.removeAttribute('aria-invalid'); aviso('');
    if (d.length === 8) verificarCep(d);
  });
  inputNum.addEventListener('input', () => { inputNum.removeAttribute('aria-invalid'); aviso(''); });

  $('#formBusca').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cep = inputCep.value.replace(/\D/g, '');
    if (!passoNum.classList.contains('oculto')) {
      if (!inputRua.value.trim()) { inputRua.focus(); aviso('Informe o nome da rua.', true); return; }
      if (!inputNum.value.trim()) { inputNum.setAttribute('aria-invalid', 'true'); aviso('Informe o número do imóvel.', true); inputNum.focus(); return; }
      return buscar(cep);
    }
    if (cep.length !== 8) { inputCep.setAttribute('aria-invalid', 'true'); aviso('Digite os 8 números do CEP.', true); inputCep.focus(); return; }
    ultimoCep = ''; verificarCep(cep);
  });
  const enderecoDigitado = () => ({ rua: inputRua.value.trim(), numero: inputNum.value.trim() });

  async function buscar(cep) {
    const btn = $('#btnBuscar');
    carregando(btn, true);
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
      history.replaceState(null, '', '?cep=' + cep);
      renderResultados();
    } catch (e) {
      $('#resTitulo').textContent = 'Não foi possível buscar agora';
      $('#gradePlanos').innerHTML = `<p class="vazio">${esc(e.message)}</p>`;
    } finally {
      carregando(btn, false);
    }
  }

  function renderResultados() {
    const j = estado.resultado;
    const e = j.endereco;
    const cepFmt = j.cep.slice(0, 5) + '-' + j.cep.slice(5);
    const d = enderecoDigitado();
    const rua = [d.rua || e?.logradouro, d.numero].filter(Boolean).join(', ');
    $('#resEndereco').textContent = [rua, e?.bairro, e?.cidade && `${e.cidade}/${e.uf}`, `CEP ${cepFmt}`].filter(Boolean).join(' · ');
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

    let planos = j.planos.filter((p) => estado.ops.has(p.operadora.id) && passaTipo(p) && (!estado.soStreaming || p.streaming?.length));
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
    box.innerHTML = opcoes.map((t) => `<button class="chip tipo" data-t="${t}" aria-pressed="${estado.tipo === t}">${t === 'todos' ? 'Todos' : TIPO_NOME[t]}</button>`).join('')
      + (estado.resultado.planos.some((p) => p.streaming?.length) ? `<button class="chip tipo" data-stream aria-pressed="${estado.soStreaming}">Com streaming</button>` : '');
    $$('.chip.tipo[data-t]', box).forEach((c) => c.addEventListener('click', () => selecionarAba(c.dataset.t)));
    const cs = $('[data-stream]', box); if (cs) cs.addEventListener('click', () => { estado.soStreaming = !estado.soStreaming; renderChipsTipo(); renderResultados(); });
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
      ${p.streaming?.length ? `<div class="streams">${p.streaming.map((x) => `<span class="stream">${esc(x.nome)} incluso${p.mesesStreaming ? ` <small>por ${esc(p.mesesStreaming)} meses</small>` : ''}</span>`).join('')}</div>` : ''}
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
    if (!recs.length || !$('#recomenda')) return;
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
        body: JSON.stringify({ nome, telefone, site: f.get('site'), cep: r.cep, rua: enderecoDigitado().rua || r.endereco?.logradouro, numero: enderecoDigitado().numero, bairro: r.endereco?.bairro, cidade: r.endereco?.cidade, uf: r.endereco?.uf, planoNome: p?.nome, operadora: p?.operadora.nome, origem: estado.origemContato }),
      });
      if (!resp.ok) throw new Error((await resp.json()).erro);
    } catch (e) {
      $('#modalErro').textContent = e.message || 'Não foi possível enviar. Tente de novo.'; btn.disabled = false; return;
    }
    btn.disabled = false;
    modal.close();
    ev.target.reset();
    const d = enderecoDigitado();
    const end = [[d.rua || r.endereco?.logradouro, d.numero].filter(Boolean).join(', '), r.endereco?.bairro, r.endereco?.cidade && `${r.endereco.cidade}/${r.endereco.uf}`, r.cep && `CEP ${r.cep}`].filter(Boolean).join(' - ');
    const msg = p
      ? `Olá! Sou ${nome}. Tenho interesse no plano ${p.nome} (${p.operadora.nome}). Endereço: ${end}.`
      : `Olá! Sou ${nome}. Busquei internet para o endereço ${end} e quero ajuda.`;
    const destino = p?.linkContratacao && !estado.config.whatsapp ? p.linkContratacao : linkWhats(msg);
    if (destino && estado.origemContato !== 'sem-cobertura') window.open(destino, '_blank', 'noopener');
    else alertaOk();
  });
  function alertaOk() {
    $('#semCobertura').innerHTML = '<h3>Recebemos seu contato!</h3><p>Nossa equipe vai falar com você em breve.</p>';
  }

  // ---------- slides do topo ----------
  const tituloHtml = (t) => esc(t).replace(/\*([^*]+)\*/g, '<em>$1</em>');
  fetch('/api/slides').then((r) => r.json()).then((slides) => {
    if (!slides.length) return;
    const hero = $('.hero');
    let atual = 0, timer = null, pausado = false;
    const reduz = matchMedia('(prefers-reduced-motion: reduce)').matches;
    slides.forEach((x) => { const im = new Image(); im.src = x.imagem; }); // pré-carrega
    function aplicar(k, animar = true) {
      const x = slides[k];
      const troca = () => {
        $('#heroSelo').textContent = x.selo || '';
        $('#heroTitulo').innerHTML = tituloHtml(x.titulo);
        $('#heroSub').textContent = x.subtitulo || '';
        $('#heroImg').src = x.imagem;
        $$('#slidePontos button').forEach((b, i) => { b.classList.toggle('on', i === k); b.setAttribute('aria-current', i === k); });
        hero.classList.remove('trocando');
      };
      atual = k;
      if (!animar || reduz) return troca();
      hero.classList.add('trocando'); setTimeout(troca, 300);
    }
    function proximo(d = 1) { aplicar((atual + d + slides.length) % slides.length); }
    function agendar() { clearInterval(timer); if (!reduz && slides.length > 1) timer = setInterval(() => { if (!pausado) proximo(); }, 6500); }
    aplicar(0, false);
    if (slides.length > 1) {
      $('#slideNav').classList.remove('oculto');
      $('#slidePontos').innerHTML = slides.map((_, i) => `<button type="button" aria-label="Slide ${i + 1}"></button>`).join('');
      $$('#slidePontos button').forEach((b, i) => b.addEventListener('click', () => { aplicar(i); agendar(); }));
      $('#slideAnt').addEventListener('click', () => { proximo(-1); agendar(); });
      $('#slideProx').addEventListener('click', () => { proximo(1); agendar(); });
      $$('#slidePontos button')[0].classList.add('on');
      // pausa enquanto a pessoa preenche a busca ou passa o mouse no topo
      $('#formBusca').addEventListener('focusin', () => { pausado = true; });
      $('#formBusca').addEventListener('focusout', () => { pausado = false; });
      hero.addEventListener('mouseenter', () => { pausado = true; });
      hero.addEventListener('mouseleave', () => { pausado = document.activeElement && $('#formBusca').contains(document.activeElement); });
      agendar();
    }
  }).catch(() => {});

  // ---------- CEP na URL ----------
  const cepUrl = new URLSearchParams(location.search).get('cep');
  if (cepUrl && /^\d{8}$/.test(cepUrl)) { inputCep.value = cepUrl.slice(0, 5) + '-' + cepUrl.slice(5); completarEndereco(cepUrl); buscar(cepUrl); }
})();
