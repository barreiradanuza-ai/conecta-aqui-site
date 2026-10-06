// Junta: endereço (ViaCEP) + cobertura por operadora (listas do MCC) + cidade promocional da Claro.
const mcc = require('./mcc');

const CACHE_MS = 6 * 60 * 60 * 1000; // 6 horas
const cache = new Map();

// Modo demonstração: sem usuário do MCC configurado, responde cobertura fictícia
// para que o site possa ser testado. NUNCA usar em produção.
const MODO_DEMO = !mcc.configurado();

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const limparCep = (cep) => String(cep || '').replace(/\D/g, '');

async function buscarEndereco(cep) {
  try {
    const ctrl = AbortSignal.timeout(4000);
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: ctrl });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.erro) return null;
    return { logradouro: j.logradouro || '', bairro: j.bairro || '', cidade: j.localidade || '', uf: j.uf || '' };
  } catch {
    return null; // sem endereço, a cobertura por CEP ainda funciona
  }
}

function demoCobertura(cep, operadoras) {
  // determinístico pelo CEP, só para testes
  const n = Number(cep.slice(-3));
  const res = {};
  operadoras.forEach((o, i) => { res[o.id] = o.cobertura === 'todas' || (o.cobertura.startsWith('mcc:') && (n + i) % 3 !== 0); });
  return { operadoras: res, promoClaro: n % 2 === 0 };
}

async function consultar(cepBruto, operadoras) {
  const cep = limparCep(cepBruto);
  if (!/^\d{8}$/.test(cep)) { const e = new Error('CEP inválido'); e.status = 400; throw e; }

  const chave = cep + '|' + operadoras.map((o) => o.id + ':' + o.cobertura).join(',');
  const emCache = cache.get(chave);
  if (emCache && Date.now() - emCache.em < CACHE_MS) return emCache.dados;

  const enderecoP = buscarEndereco(cep);
  let resultado;
  if (MODO_DEMO) {
    resultado = demoCobertura(cep, operadoras);
  } else {
    const pares = await Promise.all(operadoras.map(async (o) => {
      if (o.cobertura === 'todas') return [o.id, true];
      if (o.cobertura.startsWith('mcc:')) return [o.id, await mcc.existeNaLista(o.cobertura.slice(4), cep)];
      return [o.id, false];
    }));
    resultado = { operadoras: Object.fromEntries(pares), promoClaro: false };
  }

  const endereco = await enderecoP;
  if (!MODO_DEMO && endereco && endereco.cidade) {
    try { resultado.promoClaro = await mcc.existeNaLista('cidades-promo-claro', semAcento(endereco.cidade)); }
    catch { resultado.promoClaro = false; }
  }

  const dados = { cep, endereco, ...resultado, demo: MODO_DEMO };
  cache.set(chave, { em: Date.now(), dados });
  if (cache.size > 20000) cache.delete(cache.keys().next().value);
  return dados;
}

const limparCache = () => cache.clear();

module.exports = { consultar, limparCep, MODO_DEMO, limparCache };
