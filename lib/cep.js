// Consulta de endereço por CEP com mais de uma fonte.
// Se uma fonte falhar (fora do ar ou bloqueando), tenta a próxima e deixa a que falhou de lado por 10 min.
const FONTES = {
  viacep: {
    url: (cep) => `${(process.env.VIACEP_URL || 'https://viacep.com.br').replace(/\/$/, '')}/ws/${cep}/json/`,
    ler: (j) => (j.erro ? false : { logradouro: j.logradouro || '', bairro: j.bairro || '', cidade: j.localidade || '', uf: j.uf || '' }),
  },
  brasilapi: {
    url: (cep) => `https://brasilapi.com.br/api/cep/v2/${cep}`,
    ler: (j) => (j.cep || j.city ? { logradouro: j.street || '', bairro: j.neighborhood || '', cidade: j.city || '', uf: j.state || '' } : false),
    naoAchou: 404,
  },
  opencep: {
    url: (cep) => `https://opencep.com/v1/${cep}`,
    ler: (j) => (j.error || j.erro ? false : { logradouro: j.logradouro || '', bairro: j.bairro || '', cidade: j.localidade || '', uf: j.uf || '' }),
    naoAchou: 404,
  },
};
const ordem = () => (process.env.CEP_FONTES || 'viacep,brasilapi,opencep').split(',').map((s) => s.trim()).filter((s) => FONTES[s]);
const pausa = {}; // fonte -> até quando ignorar
const falhas = {};

// Retorna o endereço, null se o CEP não existe, ou undefined se nenhuma fonte respondeu.
async function buscar(cep, timeoutMs = 4000) {
  cep = String(cep || '').replace(/\D/g, '');
  if (cep.length !== 8) return null;
  let algumaRespondeu = false;
  for (const nome of ordem()) {
    if (pausa[nome] && pausa[nome] > Date.now()) continue;
    const f = FONTES[nome];
    try {
      const r = await fetch(f.url(cep), { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
      if (f.naoAchou && r.status === f.naoAchou) { algumaRespondeu = true; falhas[nome] = 0; continue; }
      if (!r.ok) throw new Error('status ' + r.status);
      const j = await r.json();
      falhas[nome] = 0;
      algumaRespondeu = true;
      const end = f.ler(j);
      if (end && end.cidade) return end;
    } catch {
      falhas[nome] = (falhas[nome] || 0) + 1;
      if (falhas[nome] >= 3) { pausa[nome] = Date.now() + 10 * 60_000; falhas[nome] = 0; }
    }
  }
  return algumaRespondeu ? null : undefined;
}

module.exports = { buscar };
