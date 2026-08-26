import type { ItemNFe } from '../nfe/tipos';
import type { Confianca } from './engine';

/**
 * Alertas de divergência.
 *
 * Nasceu do pedido: "quando não bater as informações, que apareça com cor que chame
 * a atenção". Mas "não bater" é duas coisas diferentes, e tratá-las igual é o erro:
 *
 *   1. NÃO SEI  - item nunca visto. É ausência de conhecimento. Normal na primeira
 *                 competência, e vai sumindo sozinho conforme o sistema aprende.
 *
 *   2. DIVERGIU - o sistema sabia uma coisa e a nota trouxe outra. Isso é CONFLITO,
 *                 é raro, e quase sempre significa que alguma coisa mudou de verdade
 *                 no mundo: o fornecedor reclassificou o produto, o item entrou em
 *                 substituição tributária, o preço saiu da curva.
 *
 * O caso 1 é a maior parte do volume e merece um marcador discreto.
 * O caso 2 é raro e merece grito.
 *
 * REGRA DE OURO DESTE ARQUIVO: se tudo é colorido, nada é. Um alerta que dispara em
 * 80% das linhas é ruído, e em duas semanas o operador aprende a ignorar - inclusive
 * nas 3 linhas em que ele estava certo. Todo detector aqui só dispara quando existe
 * histórico para comparar, e a severidade "crítica" está reservada ao que tem
 * consequência fiscal direta.
 */

export type Severidade = 'critico' | 'atencao' | 'info';

export type Alerta = {
  codigo: string;
  severidade: Severidade;
  /** frase curta para a linha da tabela */
  titulo: string;
  /** explicação para o tooltip / painel lateral */
  detalhe: string;
  /** true = a exportação da nota fica bloqueada até alguém resolver */
  bloqueia: boolean;
};

/** O que já sabíamos sobre este produto, deste fornecedor, nesta empresa. */
export type HistoricoProduto = {
  vezesVisto: number;
  ncm: string | null;
  cstOrigem: string | null;
  cfopOrigem: string | null;
  unidade: string | null;
  cEAN: string | null;
  xProdFornecedor: string | null;
  precoMedio: number | null;
  ultimaVezEm: string | null;
};

export type ContextoAlerta = {
  /** null = produto nunca visto */
  historico: HistoricoProduto | null;
  /** o item já tem CFOP de entrada definido? */
  cfopEntrada: string | null;
  /** confiança do preenchimento vindo do motor de regras */
  confianca: Confianca;
  /** a regra que preencheu está marcada como suspeita? */
  regraSuspeita: boolean;
  /** desvio de preço aceito antes de alertar (padrão 30%) */
  toleranciaPreco?: number;
};

const CST_ST = new Set(['10', '30', '60', '70', '201', '202', '203', '500']);

function ehSubstituicao(cst: string | null): boolean {
  return cst !== null && CST_ST.has(cst);
}

export function detectarAlertas(item: ItemNFe, ctx: ContextoAlerta): Alerta[] {
  const alertas: Alerta[] = [];
  const h = ctx.historico;

  // ---------------------------------------------------------- bloqueadores

  if (!ctx.cfopEntrada || ctx.cfopEntrada.trim() === '') {
    alertas.push({
      codigo: 'cfop_ausente',
      severidade: 'critico',
      titulo: 'Sem CFOP de entrada',
      detalhe: 'A nota não pode ser exportada com item sem CFOP de entrada definido.',
      bloqueia: true,
    });
  }

  if (ctx.regraSuspeita) {
    alertas.push({
      codigo: 'regra_suspeita',
      severidade: 'critico',
      titulo: 'Regra já errou várias vezes',
      detalhe:
        'O padrão que preencheria este item foi corrigido três vezes seguidas. ' +
        'Confira o valor e, se estiver certo, fixe o padrão para parar de perguntar.',
      bloqueia: false,
    });
  }

  // ---------------------------------------------------------- item novo

  if (h === null || h.vezesVisto === 0) {
    alertas.push({
      codigo: 'item_novo',
      severidade: 'atencao',
      titulo: 'Produto novo',
      detalhe: 'Primeira vez que este produto aparece deste fornecedor. Preencha uma vez e o sistema guarda.',
      bloqueia: false,
    });

    if (!item.NCM) {
      alertas.push({
        codigo: 'sem_ncm',
        severidade: 'atencao',
        titulo: 'Item sem NCM',
        detalhe: 'Sem NCM o sistema não consegue nem palpitar por natureza da mercadoria.',
        bloqueia: false,
      });
    }
    // Sem histórico não há divergência possível: para por aqui.
    return alertas;
  }

  // ---------------------------------------------------------- divergências reais
  // Daqui para baixo, tudo só dispara porque JÁ VIMOS este produto antes
  // e alguma coisa mudou.

  if (h.ncm && item.NCM && h.ncm !== item.NCM) {
    alertas.push({
      codigo: 'ncm_mudou',
      severidade: 'critico',
      titulo: `NCM mudou: ${h.ncm} → ${item.NCM}`,
      detalhe:
        'O fornecedor reclassificou o produto. NCM define tributação — ' +
        'o CFOP e o crédito que valiam antes podem não valer mais.',
      bloqueia: false,
    });
  }

  const entrouEmST = !ehSubstituicao(h.cstOrigem) && ehSubstituicao(item.cstIcms);
  const saiuDeST = ehSubstituicao(h.cstOrigem) && !ehSubstituicao(item.cstIcms);

  if (entrouEmST || saiuDeST) {
    alertas.push({
      codigo: 'st_mudou',
      severidade: 'critico',
      titulo: entrouEmST ? 'Produto entrou em substituição tributária' : 'Produto saiu de substituição tributária',
      detalhe:
        `CST do fornecedor mudou de ${h.cstOrigem ?? '—'} para ${item.cstIcms ?? '—'}. ` +
        'Isso muda o direito ao crédito e normalmente muda o CFOP de entrada.',
      bloqueia: false,
    });
  } else if (h.cstOrigem && item.cstIcms && h.cstOrigem !== item.cstIcms) {
    alertas.push({
      codigo: 'cst_mudou',
      severidade: 'atencao',
      titulo: `CST do fornecedor mudou: ${h.cstOrigem} → ${item.cstIcms}`,
      detalhe: 'Mudança de situação tributária na origem. Confira se o tratamento de entrada continua o mesmo.',
      bloqueia: false,
    });
  }

  if (h.cfopOrigem && h.cfopOrigem !== item.CFOP) {
    alertas.push({
      codigo: 'cfop_origem_mudou',
      severidade: 'atencao',
      titulo: `CFOP do fornecedor mudou: ${h.cfopOrigem} → ${item.CFOP}`,
      detalhe: 'A natureza da operação na saída mudou. Verifique se a entrada acompanha.',
      bloqueia: false,
    });
  }

  if (h.unidade && item.uCom && h.unidade !== item.uCom) {
    alertas.push({
      codigo: 'unidade_mudou',
      severidade: 'atencao',
      titulo: `Unidade mudou: ${h.unidade} → ${item.uCom}`,
      detalhe: 'Mudança de embalagem ou de critério do fornecedor. O preço unitário deixa de ser comparável.',
      bloqueia: false,
    });
  }

  if (h.cEAN && item.cEAN && h.cEAN !== item.cEAN) {
    alertas.push({
      codigo: 'ean_mudou',
      severidade: 'atencao',
      titulo: 'Código de barras diferente do histórico',
      detalhe: 'Mesmo código de produto com GTIN diferente — pode ser troca de embalagem ou item trocado no cadastro do fornecedor.',
      bloqueia: false,
    });
  }

  // Preço: só alerta se a unidade continua a mesma, senão a comparação não vale nada.
  const mesmaUnidade = !h.unidade || !item.uCom || h.unidade === item.uCom;
  if (mesmaUnidade && h.precoMedio && h.precoMedio > 0 && item.vUnCom && item.vUnCom > 0) {
    const tol = ctx.toleranciaPreco ?? 0.3;
    const variacao = (item.vUnCom - h.precoMedio) / h.precoMedio;
    if (Math.abs(variacao) > tol) {
      const pct = Math.round(variacao * 100);
      alertas.push({
        codigo: 'preco_fora_faixa',
        severidade: Math.abs(variacao) > 1 ? 'critico' : 'atencao',
        titulo: `Preço ${pct > 0 ? '+' : ''}${pct}% do histórico`,
        detalhe:
          `Média das compras anteriores: R$ ${h.precoMedio.toFixed(2)}. Nesta nota: R$ ${item.vUnCom.toFixed(2)}. ` +
          'Variação grande costuma ser reajuste real — mas também é onde aparece erro de digitação do fornecedor.',
        bloqueia: false,
      });
    }
  }

  if (h.xProdFornecedor && h.xProdFornecedor !== item.xProd) {
    alertas.push({
      codigo: 'descricao_fornecedor_mudou',
      severidade: 'info',
      titulo: 'Fornecedor mudou a descrição',
      detalhe: `Antes: "${h.xProdFornecedor}". Agora: "${item.xProd}". Sua descrição padronizada continua valendo.`,
      bloqueia: false,
    });
  }

  return alertas;
}

// ------------------------------------------------------------------ agregação

export type ResumoNota = {
  totalItens: number;
  criticos: number;
  atencao: number;
  info: number;
  /** itens que já vieram prontos e não têm nenhum alerta acima de info */
  tranquilos: number;
  bloqueiaExportacao: boolean;
  /** frase única para o topo da tela */
  chamada: string;
};

export function resumirNota(porItem: { confianca: Confianca; alertas: Alerta[] }[]): ResumoNota {
  let criticos = 0;
  let atencao = 0;
  let info = 0;
  let tranquilos = 0;
  let bloqueia = false;

  for (const it of porItem) {
    const pior = severidadeMaxima(it.alertas);
    if (pior === 'critico') criticos += 1;
    else if (pior === 'atencao') atencao += 1;
    else if (pior === 'info') info += 1;

    if (it.alertas.some((a) => a.bloqueia)) bloqueia = true;
    if (pior !== 'critico' && pior !== 'atencao' && it.confianca === 'alta') tranquilos += 1;
  }

  const total = porItem.length;
  let chamada: string;
  if (criticos > 0) {
    chamada = `${criticos} ${criticos === 1 ? 'item precisa' : 'itens precisam'} de atenção antes de exportar`;
  } else if (atencao > 0) {
    chamada = `${atencao} ${atencao === 1 ? 'item para conferir' : 'itens para conferir'} · ${tranquilos} de ${total} já prontos`;
  } else {
    chamada = `Tudo conferido · ${total} ${total === 1 ? 'item' : 'itens'}`;
  }

  return { totalItens: total, criticos, atencao, info, tranquilos, bloqueiaExportacao: bloqueia, chamada };
}

export function severidadeMaxima(alertas: Alerta[]): Severidade | null {
  if (alertas.some((a) => a.severidade === 'critico')) return 'critico';
  if (alertas.some((a) => a.severidade === 'atencao')) return 'atencao';
  if (alertas.some((a) => a.severidade === 'info')) return 'info';
  return null;
}

/**
 * Como a linha deve aparecer na tela.
 *
 * `icone` e `rotulo` existem porque cor sozinha nao e acessivel: cerca de 8% dos
 * homens tem alguma deficiencia de visao de cores, e vermelho/verde e justamente
 * a confusao mais comum - as duas cores que aqui significam o oposto uma da outra.
 * Quem nao distingue a cor tem que conseguir ler o estado.
 *
 * `destacar: false` no caso tranquilo e proposital: linha certa nao ganha cor.
 * O olho tem que ser puxado so para o que precisa de acao.
 */
export type EstiloLinha = {
  estado: 'bloqueado' | 'conferir' | 'novo' | 'pronto';
  icone: string;
  rotulo: string;
  destacar: boolean;
};

export function estiloDaLinha(confianca: Confianca, alertas: Alerta[]): EstiloLinha {
  const pior = severidadeMaxima(alertas);

  if (pior === 'critico') {
    return { estado: 'bloqueado', icone: '▲', rotulo: 'Resolver', destacar: true };
  }
  if (alertas.some((a) => a.codigo === 'item_novo')) {
    return { estado: 'novo', icone: '＋', rotulo: 'Produto novo', destacar: true };
  }
  if (pior === 'atencao' || confianca === 'media') {
    return { estado: 'conferir', icone: '●', rotulo: 'Conferir', destacar: true };
  }
  return { estado: 'pronto', icone: '✓', rotulo: 'Pronto', destacar: false };
}
