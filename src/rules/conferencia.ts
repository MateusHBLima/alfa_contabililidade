/**
 * O que o "✓ Conferido" ensina ao motor (pedido de 22/09, depois do teste geral).
 *
 * Conferir e concordar com o CFOP que esta na linha, e concordar tambem e decisao.
 * Antes, so o que era digitado ensinava: um palpite do perfil que a contadora
 * conferia voltava como palpite na nota seguinte, pedindo a mesma conferencia.
 *
 * Regras daqui (modulo puro; quem grava e Repo.aprenderEmLote):
 * - so linhas que estao sendo conferidas agora (revisado 0) e tem CFOP;
 * - linha digitada a mao (`manual...`) ja ensinou quando foi digitada - nao ensina de novo;
 * - so o CFOP: a descricao conferida pode ser a do fornecedor, que nao e decisao;
 * - ensina como se ela tivesse digitado o mesmo valor: a regra que sugeriu ganha um
 *   acerto e as chaves que aprendem sozinhas recebem o valor (nunca fixado).
 */
import { aprender, type Aprendizado } from './engine';

export function aprendizadoDaConferencia(
  linhas: any[],
  emitCnpj: string,
  ids: Iterable<string>,
): { acao: Aprendizado; valor: string }[] {
  const alvo = new Set(ids);
  const out: { acao: Aprendizado; valor: string }[] = [];
  for (const i of linhas) {
    if (!alvo.has(i.id) || i.revisado === 1) continue;
    const valor = String(i.cfop_novo ?? '').trim();
    const origem = String(i.cfop_origem ?? '');
    if (!valor || origem.startsWith('manual')) continue;
    const item = {
      nItem: i.n_item, cProd: i.c_prod, cEAN: i.c_ean, xProd: i.x_prod_original,
      NCM: i.ncm, CEST: i.cest, CFOP: i.cfop_original, uCom: i.unidade,
      qCom: i.quantidade, vUnCom: i.valor_unitario, vProd: i.valor_total,
      cstIcms: null, temIbsCbs: false,
    };
    // So `regraId` e `valor` importam para o aprender(): de onde veio a linha.
    const sugestao = origem.startsWith('regra:')
      ? ({ valor, campo: 'cfop', origem, regraId: origem.slice('regra:'.length), nivel: null, confianca: 'media', porque: '' } as any)
      : null;
    for (const acao of aprender({ item: item as any, emitCnpj, campo: 'cfop', valorFinal: valor, sugestao })) {
      out.push({ acao, valor });
    }
  }
  return out;
}
