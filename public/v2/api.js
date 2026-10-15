/* Alfa Fiscal v2 — conversa com o servidor.
 *
 * MODO TESTE (15/10): enquanto a v2 estiver em teste, TODA chamada leva o cabeçalho
 * X-Tela: v2-teste. Com ele o servidor só responde leitura: gravar (conferir, trocar
 * CFOP, importar, apagar) é recusado lá, antes de qualquer rota, e abrir a nota não
 * atualiza palpite. Assim dá para olhar a v2 com os dados reais sem mexer no trabalho
 * de ninguém. Na máquina de desenvolvimento (localhost) a v2 grava, para testar os
 * botões com notas inventadas; ?teste=1 liga o modo teste lá também.
 *
 * Para liberar a v2 para uso de verdade, MODO_TESTE passa a ser false.
 */

const local = ['localhost', '127.0.0.1'].includes(location.hostname);
export const MODO_TESTE = !local || new URLSearchParams(location.search).has('teste');

export class ErroApi extends Error {
  constructor(msg, extra = {}) { super(msg); Object.assign(this, extra); }
}

export async function api(caminho, opcoes = {}) {
  const headers = { ...(opcoes.body && !(opcoes.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opcoes.headers ?? {}) };
  if (MODO_TESTE) headers['X-Tela'] = 'v2-teste';
  let r;
  try {
    r = await fetch(caminho, { credentials: 'same-origin', ...opcoes, headers });
  } catch {
    throw new ErroApi('Sem conexão com o servidor. Confira a internet e tente de novo.');
  }
  // Sem sessão: a entrada continua sendo a da tela de sempre.
  if (r.status === 401) {
    location.href = '/';
    throw new ErroApi('sessão expirada');
  }
  const ct = r.headers.get('Content-Type') ?? '';
  const corpo = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    throw new ErroApi(corpo?.erro ?? `erro ${r.status}`, { status: r.status, modoTeste: !!corpo?.modoTeste, dados: corpo });
  }
  return corpo;
}

export const enviar = (caminho, corpo, metodo = 'POST') =>
  api(caminho, { method: metodo, body: JSON.stringify(corpo ?? {}) });
