/* Alfa Fiscal v2 — o estado da tela, num lugar só. */

export const estado = {
  eu: null,
  empresas: [],
  pendencias: [],        // [{ empresaId, razaoSocial, notas, itens, maisAntiga }]
  empresaId: null,
  competencias: [],      // [{ competencia: '2026-10', notas: 12 }]
  competencia: '',       // '' = todos os meses
  notas: [],
  // Lista de notas
  aba: null,             // 'precisam' | 'prontas' | 'tratadas' | 'todas' (null = escolher sozinho)
  periodo: { de: '', ate: '' },
  agrupar: false,
  // Nota aberta
  nota: null,            // resposta de GET /api/notas/:id
  filtroItens: 'faltam', // 'faltam' | 'conferidos' | 'todos'
  buscaItens: '',
  selecionado: null,     // id do item com o cursor
  painel: null,          // id do item com o painel aberto
  conferindo: new Set(), // itens sendo gravados agora
};

export const pode = (p) => !!estado.eu?.permissoes?.includes(p);

export const empresaAtual = () => estado.empresas.find((e) => e.id === estado.empresaId) ?? null;

/* O endereço guarda onde a pessoa está: F5 e o voltar do navegador reabrem o mesmo lugar. */
export function lerEndereco() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { t: p.get('t') ?? 'notas', e: p.get('e'), m: p.get('m'), n: p.get('n'), i: p.get('i') };
}

export function endereco(extra = {}) {
  const atual = lerEndereco();
  const p = new URLSearchParams();
  const v = { ...atual, e: estado.empresaId, m: estado.competencia || 'todos', ...extra };
  for (const k of ['t', 'e', 'm', 'n', 'i']) if (v[k]) p.set(k, v[k]);
  if (v.t !== 'nota') { p.delete('n'); p.delete('i'); }
  return '#' + p.toString();
}

/* Link para a mesma empresa na tela de sempre (ela lê #e=…&t=…&n=…). */
export function linkTelaAntiga(view, notaId = null) {
  const p = new URLSearchParams();
  if (estado.empresaId) p.set('e', estado.empresaId);
  p.set('t', view);
  if (notaId) p.set('n', notaId);
  return '/#' + p.toString();
}

/* Preferências deste navegador (mês escolhido por empresa). Pode falhar: nada depende disso. */
export function lembrar(chave, valor) {
  try { localStorage.setItem(`alfa-v2:${chave}`, valor); } catch { /* sem armazenamento: segue */ }
}
export function lembrado(chave) {
  try { return localStorage.getItem(`alfa-v2:${chave}`); } catch { return null; }
}
