// Resume as listas de CEP do MCC em faixas de 5 dígitos (ex.: 22790-xxx),
// para segmentar anúncios do Google Ads por região com cobertura.
// Só LÊ o MCC. Roda em segundo plano e guarda o resultado em DATA_DIR.
const mcc = require('./mcc');
const store = require('./store');

let estado = { rodando: false, inicio: null, fim: null, erro: null, progresso: {} };

async function lerLista(lista, aoAvancar, amostras) {
  const contagem = new Map();
  let pagina = 1;
  let lidos = 0;
  const TAM = 1000;
  for (;;) {
    const j = await mcc.get(`/api/mcc/admin/${lista}?page=${pagina}&pageSize=${TAM}`);
    const itens = j.items || [];
    for (const it of itens) {
      const cep = String(it.value || '').replace(/\D/g, '');
      if (cep.length !== 8) continue;
      const pre = cep.slice(0, 5);
      contagem.set(pre, (contagem.get(pre) || 0) + 1);
      if (amostras && !amostras.has(pre)) amostras.set(pre, cep);
    }
    lidos += itens.length;
    const total = Number(j.total ?? j.totalItems ?? j.count ?? 0) || null;
    aoAvancar({ lidos, total, pagina });
    if (!itens.length) break;
    if (total && lidos >= total) break;
    if (j.totalPages && pagina >= j.totalPages) break;
    if (pagina > 5000) break; // trava de segurança
    pagina++;
    await new Promise((r) => setTimeout(r, 80)); // não sobrecarregar o MCC
  }
  return contagem;
}

// Descobre cidade/UF de cada faixa consultando 1 CEP de exemplo no ViaCEP.
// Guarda em cache (faixas-cidades) para não repetir em gerações futuras.
async function cidadeDoCep(cep) {
  const e = await require('./cep').buscar(cep, 8000);
  if (e === undefined) return null; // nenhuma fonte respondeu: tenta de novo na próxima geração
  return e ? { uf: e.uf, cidade: e.cidade } : { uf: '', cidade: '' };
}

async function gerar(operadoras) {
  if (estado.rodando) return estado;
  const alvo = operadoras.filter((o) => o.ativo !== false && String(o.cobertura || '').startsWith('mcc:'));
  estado = { rodando: true, inicio: new Date().toISOString(), fim: null, erro: null, progresso: {} };
  (async () => {
    try {
      const porPrefixo = {};
      const amostras = new Map();
      for (const o of alvo) {
        const lista = o.cobertura.slice(4);
        const c = await lerLista(lista, (p) => { estado.progresso[o.id] = p; }, amostras);
        for (const [pre, n] of c) {
          porPrefixo[pre] = porPrefixo[pre] || { prefixo: pre, total: 0 };
          porPrefixo[pre][o.id] = n;
          porPrefixo[pre].total += n;
        }
      }
      const linhas = Object.values(porPrefixo).sort((a, b) => b.total - a.total);
      // cidade/UF de cada faixa
      const cache = store.load('faixas-cidades', {});
      const faltam = linhas.filter((l) => !(cache[l.prefixo] && cache[l.prefixo].cidade));
      estado.progresso.cidades = { lidos: 0, total: faltam.length };
      let desdeSalvar = 0;
      for (const l of faltam) {
        const info = await cidadeDoCep(amostras.get(l.prefixo));
        if (info) cache[l.prefixo] = info;
        estado.progresso.cidades.lidos++;
        if (++desdeSalvar >= 200) { store.save('faixas-cidades', cache); desdeSalvar = 0; }
        await new Promise((r) => setTimeout(r, 350));
      }
      store.save('faixas-cidades', cache);
      for (const l of linhas) { const c = cache[l.prefixo] || {}; l.uf = c.uf || ''; l.cidade = c.cidade || ''; }
      store.save('faixas-cep', { geradoEm: new Date().toISOString(), operadoras: alvo.map((o) => o.id), linhas });
      estado.fim = new Date().toISOString();
    } catch (e) {
      estado.erro = e.message;
    } finally {
      estado.rodando = false;
    }
  })();
  return estado;
}

const resultado = () => store.load('faixas-cep', null);
const status = () => estado;

module.exports = { gerar, resultado, status };
