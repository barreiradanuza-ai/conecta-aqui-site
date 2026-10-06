// Resume as listas de CEP do MCC em faixas de 5 dígitos (ex.: 22790-xxx),
// para segmentar anúncios do Google Ads por região com cobertura.
// Só LÊ o MCC. Roda em segundo plano e guarda o resultado em DATA_DIR.
const mcc = require('./mcc');
const store = require('./store');

let estado = { rodando: false, inicio: null, fim: null, erro: null, progresso: {} };

async function lerLista(lista, aoAvancar) {
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

async function gerar(operadoras) {
  if (estado.rodando) return estado;
  const alvo = operadoras.filter((o) => o.ativo !== false && String(o.cobertura || '').startsWith('mcc:'));
  estado = { rodando: true, inicio: new Date().toISOString(), fim: null, erro: null, progresso: {} };
  (async () => {
    try {
      const porPrefixo = {};
      for (const o of alvo) {
        const lista = o.cobertura.slice(4);
        const c = await lerLista(lista, (p) => { estado.progresso[o.id] = p; });
        for (const [pre, n] of c) {
          porPrefixo[pre] = porPrefixo[pre] || { prefixo: pre, total: 0 };
          porPrefixo[pre][o.id] = n;
          porPrefixo[pre].total += n;
        }
      }
      const linhas = Object.values(porPrefixo).sort((a, b) => b.total - a.total);
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
