/**
 * Relatorios de conferencia: por CFOP ("por natureza") e por produto.
 *
 * POR QUE EXISTEM. Pedido da contadora em 17/09, com prazo de fim de mes: ela trata
 * a competencia no sistema, a colega trata do jeito antigo, e no fim do mes as duas
 * tiram os relatorios e batem linha a linha. Isto nao e um relatorio qualquer - e o
 * instrumento que mede se o motor de regras acerta num lote real. Relatorio errado
 * aqui e pior que relatorio nenhum.
 *
 * O QUE ENTRA. Todas as notas da empresa na competencia, com o CFOP e a descricao
 * COMO FICARAM depois do tratamento. Item ainda nao conferido ENTRA (com o valor
 * que o sistema sugeriu) e o relatorio diz quantos sao - esconder daria total
 * menor que o da colega sem explicacao; incluir calado daria palpite com cara de
 * decisao. Nota cancelada NAO e excluida: por decisao de 17/09 o cancelamento e
 * tratado a mao dos dois lados da comparacao.
 *
 * COMO AGRUPA PRODUTO. Pela descricao tratada + unidade, nao pelo codigo do
 * fornecedor: a mesma alface vinda de dois fornecedores e UM produto no cadastro
 * do cliente, e e assim que o relatorio do outro sistema vem. Os codigos e a
 * descricao original vao juntos para ela conseguir rastrear.
 *
 * Modulo puro: recebe linhas agregadas do repositorio e devolve tabela e CSV.
 * CSV no formato que o Excel brasileiro abre com dois cliques: BOM, `;`, virgula
 * decimal, CRLF.
 */

export type LinhaCfopBruta = {
  cfop_novo: string | null;
  cfop_original: string | null;
  itens: number;
  conferidos: number;
  valor: number | null;
};

export type LinhaCfop = {
  cfop: string;
  natureza: string;
  itens: number;
  conferidos: number;
  valor: number;
  /** de quais CFOPs de saida vieram: "5102 (63), 5949 (6)" */
  origem: string;
};

export type LinhaProduto = {
  descricao: string;
  unidade: string;
  quantidade: number;
  valorUnitarioMedio: number | null;
  valor: number;
  itens: number;
  conferidos: number;
  notas: number;
  fornecedores: number;
  codigos: string;
  cfops: string;
  descricaoOriginal: string;
};

export type Totais = { itens: number; conferidos: number; valor: number };

/** So os que aparecem em entrada de mercadoria no dia a dia. Desconhecido fica em branco - nao inventamos natureza. */
const NATUREZA: Record<string, string> = {
  '101': 'Compra para industrialização',
  '102': 'Compra para comercialização',
  '116': 'Compra p/ industrialização — entrega futura',
  '117': 'Compra p/ comercialização — entrega futura',
  '124': 'Industrialização efetuada por outra empresa',
  '201': 'Devolução de venda de produção',
  '202': 'Devolução de venda de mercadoria',
  '252': 'Compra de energia elétrica — industrial',
  '253': 'Compra de energia elétrica — comercial',
  '352': 'Aquisição de serviço de transporte — industrial',
  '353': 'Aquisição de serviço de transporte — comercial',
  '401': 'Compra para industrialização — ST',
  '403': 'Compra para comercialização — ST',
  '406': 'Compra de ativo imobilizado — ST',
  '407': 'Compra para uso ou consumo — ST',
  '551': 'Compra de ativo imobilizado',
  '556': 'Compra de material para uso ou consumo',
  '653': 'Compra de combustível ou lubrificante — consumidor final',
  '910': 'Entrada de bonificação, doação ou brinde',
  '911': 'Entrada de amostra grátis',
  '949': 'Outra entrada não especificada',
};

export function naturezaDoCfop(cfop: string): string {
  const c = cfop.trim();
  if (!/^[123]\d{3}$/.test(c)) return '';
  const nome = NATUREZA[c.slice(1)];
  if (!nome) return '';
  return c[0] === '2' ? `${nome} (fora do estado)` : c[0] === '3' ? `${nome} (exterior)` : nome;
}

const centavos = (v: number) => Math.round(v * 100) / 100;

export function montarRelatorioCfop(brutas: LinhaCfopBruta[]): { linhas: LinhaCfop[]; totais: Totais } {
  const porCfop = new Map<string, { itens: number; conferidos: number; valor: number; origem: Map<string, number> }>();
  for (const b of brutas) {
    const cfop = (b.cfop_novo ?? '').trim() || '(sem CFOP)';
    const g = porCfop.get(cfop) ?? { itens: 0, conferidos: 0, valor: 0, origem: new Map() };
    g.itens += Number(b.itens);
    g.conferidos += Number(b.conferidos);
    g.valor += Number(b.valor ?? 0);
    const o = (b.cfop_original ?? '').trim() || '—';
    g.origem.set(o, (g.origem.get(o) ?? 0) + Number(b.itens));
    porCfop.set(cfop, g);
  }
  const linhas = [...porCfop.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cfop, g]) => ({
      cfop,
      natureza: naturezaDoCfop(cfop),
      itens: g.itens,
      conferidos: g.conferidos,
      valor: centavos(g.valor),
      origem: [...g.origem.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} (${n})`).join(', '),
    }));
  return { linhas, totais: somar(linhas) };
}

export type LinhaProdutoBruta = {
  descricao: string | null;
  unidade: string | null;
  quantidade: number | null;
  valor: number | null;
  itens: number;
  conferidos: number;
  notas: number;
  fornecedores: number;
  codigos: string | null;
  cfops: string | null;
  descricao_original: string | null;
  descricoes_originais: number;
};

export function montarRelatorioProdutos(brutas: LinhaProdutoBruta[]): { linhas: LinhaProduto[]; totais: Totais } {
  const lista = (s: string | null) =>
    [...new Set(String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean))].sort().join(', ');
  const linhas = brutas
    .map((b) => {
      const quantidade = Number(b.quantidade ?? 0);
      const valor = centavos(Number(b.valor ?? 0));
      const original = String(b.descricao_original ?? '');
      return {
        descricao: String(b.descricao ?? '').trim() || '(sem descrição)',
        unidade: String(b.unidade ?? '').trim(),
        quantidade: Math.round(quantidade * 10000) / 10000,
        // Media ponderada do mes: total / quantidade. Preco muda dentro do mes, e
        // "o" unitario nao existe - o que bate com o outro sistema e o total.
        valorUnitarioMedio: quantidade > 0 ? Math.round((valor / quantidade) * 10000) / 10000 : null,
        valor,
        itens: Number(b.itens),
        conferidos: Number(b.conferidos),
        notas: Number(b.notas),
        fornecedores: Number(b.fornecedores),
        codigos: lista(b.codigos),
        cfops: lista(b.cfops),
        descricaoOriginal:
          Number(b.descricoes_originais) > 1 ? `${original} (+${Number(b.descricoes_originais) - 1})` : original,
      };
    })
    .sort((a, b) => a.descricao.localeCompare(b.descricao, 'pt-BR') || a.unidade.localeCompare(b.unidade));
  return { linhas, totais: somar(linhas) };
}

function somar(linhas: { itens: number; conferidos: number; valor: number }[]): Totais {
  return {
    itens: linhas.reduce((s, l) => s + l.itens, 0),
    conferidos: linhas.reduce((s, l) => s + l.conferidos, 0),
    valor: centavos(linhas.reduce((s, l) => s + l.valor, 0)),
  };
}

// ------------------------------------------------------------------ CSV

const num = (v: number | null, casas = 2) =>
  v === null ? '' : v.toFixed(casas).replace('.', ',');

function celula(v: string | number): string {
  let s = String(v);
  // Planilha executa o que comeca com = + - @. Descricao de produto vem do
  // fornecedor: e dado de terceiro, nao se confia.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(cabecalho: string[], linhas: (string | number)[][]): string {
  return '﻿' + [cabecalho, ...linhas].map((l) => l.map(celula).join(';')).join('\r\n') + '\r\n';
}

export function csvCfop(r: { linhas: LinhaCfop[]; totais: Totais }): string {
  return csv(
    ['CFOP de entrada', 'Natureza', 'Itens', 'Itens conferidos', 'Valor total', 'CFOP original (itens)'],
    [
      ...r.linhas.map((l) => [l.cfop, l.natureza, l.itens, l.conferidos, num(l.valor), l.origem]),
      ['TOTAL', '', r.totais.itens, r.totais.conferidos, num(r.totais.valor), ''],
    ],
  );
}

export function csvProdutos(r: { linhas: LinhaProduto[]; totais: Totais }): string {
  return csv(
    ['Produto', 'Unidade', 'Quantidade no mês', 'Valor unitário médio', 'Valor total', 'CFOP de entrada',
      'Código no fornecedor', 'Fornecedores', 'Notas', 'Itens', 'Itens conferidos', 'Descrição original do fornecedor'],
    [
      ...r.linhas.map((l) => [
        l.descricao, l.unidade, num(l.quantidade, 4), num(l.valorUnitarioMedio, 4), num(l.valor), l.cfops,
        l.codigos, l.fornecedores, l.notas, l.itens, l.conferidos, l.descricaoOriginal,
      ]),
      ['TOTAL', '', '', '', num(r.totais.valor), '', '', '', '', r.totais.itens, r.totais.conferidos, ''],
    ],
  );
}
