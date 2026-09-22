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
  valor_contabil?: number | null;
  v_bc?: number | null;
  v_icms?: number | null;
  v_st?: number | null;
  v_ipi?: number | null;
  /** ids das notas, separados por virgula */
  notas?: string | null;
};

export type LinhaCfop = {
  cfop: string;
  natureza: string;
  notas: number;
  itens: number;
  conferidos: number;
  /** so o valor dos produtos (vProd) */
  valor: number;
  /** o que o livro de entradas soma: produto - desconto + frete + seguro + outras + ST + IPI */
  valorContabil: number;
  baseIcms: number;
  icms: number;
  st: number;
  ipi: number;
  /** de quais CFOPs de saida vieram: "5102 (63), 5949 (6)" */
  origem: string;
};

export type TotaisCfop = Totais & { notas: number; valorContabil: number; baseIcms: number; icms: number; st: number; ipi: number };

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

export function montarRelatorioCfop(brutas: LinhaCfopBruta[]): { linhas: LinhaCfop[]; totais: TotaisCfop } {
  type G = { itens: number; conferidos: number; valor: number; vc: number; bc: number; icms: number; st: number; ipi: number; notas: Set<string>; origem: Map<string, number> };
  const porCfop = new Map<string, G>();
  const todasNotas = new Set<string>();
  for (const b of brutas) {
    const cfop = (b.cfop_novo ?? '').trim() || '(sem CFOP)';
    const g = porCfop.get(cfop) ?? { itens: 0, conferidos: 0, valor: 0, vc: 0, bc: 0, icms: 0, st: 0, ipi: 0, notas: new Set(), origem: new Map() };
    g.itens += Number(b.itens);
    g.conferidos += Number(b.conferidos);
    g.valor += Number(b.valor ?? 0);
    g.vc += Number(b.valor_contabil ?? b.valor ?? 0);
    g.bc += Number(b.v_bc ?? 0);
    g.icms += Number(b.v_icms ?? 0);
    g.st += Number(b.v_st ?? 0);
    g.ipi += Number(b.v_ipi ?? 0);
    for (const id of String(b.notas ?? '').split(',').filter(Boolean)) { g.notas.add(id); todasNotas.add(id); }
    const o = (b.cfop_original ?? '').trim() || '—';
    g.origem.set(o, (g.origem.get(o) ?? 0) + Number(b.itens));
    porCfop.set(cfop, g);
  }
  const linhas = [...porCfop.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cfop, g]) => ({
      cfop,
      natureza: naturezaDoCfop(cfop),
      notas: g.notas.size,
      itens: g.itens,
      conferidos: g.conferidos,
      valor: centavos(g.valor),
      valorContabil: centavos(g.vc),
      baseIcms: centavos(g.bc),
      icms: centavos(g.icms),
      st: centavos(g.st),
      ipi: centavos(g.ipi),
      origem: [...g.origem.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o} (${n})`).join(', '),
    }));
  const soma = (k: keyof LinhaCfop) => centavos(linhas.reduce((s, l) => s + Number(l[k]), 0));
  return {
    linhas,
    totais: {
      ...somar(linhas),
      notas: todasNotas.size,
      valorContabil: soma('valorContabil'),
      baseIcms: soma('baseIcms'),
      icms: soma('icms'),
      st: soma('st'),
      ipi: soma('ipi'),
    },
  };
}

// ------------------------------------------------------------ uma nota so

/**
 * Total por CFOP de UMA nota, no rodape da tela de tratamento. Pedido da Taís em
 * 22/09: "quando eu clico em ver, embaixo ja me apareca o total de um CFOP e o total
 * de outro so daquela nota" - e com frete e despesas, para fechar com o total da nota.
 *
 * Usa a MESMA montagem do relatorio por CFOP, item a item: o numero do rodape e o
 * numero do relatorio nao podem divergir por criterio. `diferenca` e o quanto o valor
 * contabil somado fica longe do vNF; zero e o esperado.
 */
export function totaisPorCfopDaNota(itens: any[], valorNota: number) {
  const rel = montarRelatorioCfop(
    itens.map((i) => {
      const lidos = Number(i.valores_lidos) === 1;
      return {
        cfop_novo: i.cfop_novo ?? null,
        cfop_original: i.cfop_original ?? null,
        itens: 1,
        conferidos: i.revisado ? 1 : 0,
        valor: Number(i.valor_total ?? 0),
        valor_contabil: lidos ? Number(i.valor_contabil ?? i.valor_total ?? 0) : null,
        v_bc: lidos ? Number(i.v_bc_icms ?? 0) : 0,
        v_icms: lidos ? Number(i.v_icms ?? 0) : 0,
        v_st: lidos ? Number(i.v_st ?? 0) + Number(i.v_fcp_st ?? 0) : 0,
        v_ipi: lidos ? Number(i.v_ipi ?? 0) : 0,
        notas: '',
      } as LinhaCfopBruta;
    }),
  );
  const vNF = centavos(Number(valorNota ?? 0));
  return {
    linhas: rel.linhas.map(({ notas: _n, ...l }) => l),
    totais: { itens: rel.totais.itens, valor: rel.totais.valor, valorContabil: rel.totais.valorContabil },
    valorNota: vNF,
    /** false quando algum item nao tem os valores do XML (sem original guardado): o contabil vira o do produto */
    valoresLidos: itens.every((i) => Number(i.valores_lidos) === 1),
    diferenca: centavos(vNF - rel.totais.valorContabil),
  };
}

// ------------------------------------------------------------------ analitico

/**
 * Sintetico -> analitico. Pedido da Taís em 22/09: "clicar no CFOP e ver as notas
 * que deram origem", para achar a diferenca contra o sistema dela. As notas de um
 * CFOP somam SO os itens daquele CFOP - uma nota pode ter itens em dois CFOPs.
 */
export type NotaDoCfop = {
  notaId: string; numero: string; serie: string | null; data: string | null; chave: string;
  fornecedor: string; cnpj: string; itens: number; conferidos: number;
  valor: number; valorContabil: number; baseIcms: number; icms: number; st: number; ipi: number;
  /** total da nota inteira (vNF), para ela ver quando a nota tem itens em outro CFOP */
  valorNota: number;
};

export function notasDoAnalitico(linhas: any[]): NotaDoCfop[] {
  const porNota = new Map<string, NotaDoCfop>();
  for (const l of linhas) {
    const n = porNota.get(l.nota_id) ?? {
      notaId: l.nota_id, numero: String(l.numero ?? ''), serie: l.serie ?? null, data: l.dh_emi ?? null,
      chave: l.chave, fornecedor: l.emit_nome ?? l.emit_cnpj, cnpj: l.emit_cnpj, itens: 0, conferidos: 0,
      valor: 0, valorContabil: 0, baseIcms: 0, icms: 0, st: 0, ipi: 0, valorNota: Number(l.valor_nota ?? 0),
    };
    n.itens += 1;
    n.conferidos += l.revisado ? 1 : 0;
    n.valor += Number(l.valor_total ?? 0);
    n.valorContabil += Number(l.valor_contabil ?? 0);
    n.baseIcms += Number(l.v_bc ?? 0);
    n.icms += Number(l.v_icms ?? 0);
    n.st += Number(l.v_st ?? 0);
    n.ipi += Number(l.v_ipi ?? 0);
    porNota.set(l.nota_id, n);
  }
  return [...porNota.values()].map((n) => ({
    ...n,
    valor: centavos(n.valor), valorContabil: centavos(n.valorContabil), baseIcms: centavos(n.baseIcms),
    icms: centavos(n.icms), st: centavos(n.st), ipi: centavos(n.ipi),
  }));
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

export function csvCfop(r: { linhas: LinhaCfop[]; totais: TotaisCfop }): string {
  return csv(
    ['CFOP de entrada', 'Natureza', 'Notas', 'Itens', 'Itens conferidos', 'Valor contábil', 'Base de cálculo ICMS',
      'ICMS', 'ICMS ST', 'IPI', 'Valor dos produtos', 'CFOP original (itens)'],
    [
      ...r.linhas.map((l) => [l.cfop, l.natureza, l.notas, l.itens, l.conferidos, num(l.valorContabil), num(l.baseIcms),
        num(l.icms), num(l.st), num(l.ipi), num(l.valor), l.origem]),
      ['TOTAL', '', r.totais.notas, r.totais.itens, r.totais.conferidos, num(r.totais.valorContabil), num(r.totais.baseIcms),
        num(r.totais.icms), num(r.totais.st), num(r.totais.ipi), num(r.totais.valor), ''],
    ],
  );
}

/** Um item por linha, com a nota: e o "analitico" para filtrar e bater no Excel. */
export function csvAnalitico(linhas: any[]): string {
  const data = (d: string | null) => (d ? String(d).slice(0, 10).split('-').reverse().join('/') : '');
  const t = { vc: 0, bc: 0, icms: 0, st: 0, ipi: 0, vp: 0 };
  const corpo = linhas.map((l) => {
    t.vc += Number(l.valor_contabil ?? 0); t.bc += Number(l.v_bc ?? 0); t.icms += Number(l.v_icms ?? 0);
    t.st += Number(l.v_st ?? 0); t.ipi += Number(l.v_ipi ?? 0); t.vp += Number(l.valor_total ?? 0);
    return [
      data(l.dh_emi), l.numero ?? '', l.serie ?? '', l.emit_nome ?? '', l.emit_cnpj ?? '', l.emit_uf ?? '', l.chave ?? '',
      l.n_item, l.c_prod ?? '', l.x_prod_original ?? '', l.x_prod_novo ?? '', l.ncm ?? '',
      l.cfop_original ?? '', l.cfop_novo ?? '', l.unidade ?? '', num(Number(l.quantidade ?? 0), 4),
      num(Number(l.valor_total ?? 0)), num(Number(l.v_desc ?? 0)), num(Number(l.v_frete ?? 0)), num(Number(l.v_seg ?? 0)),
      num(Number(l.v_outro ?? 0)), num(Number(l.v_st ?? 0)), num(Number(l.v_ipi ?? 0)), num(Number(l.valor_contabil ?? 0)),
      num(Number(l.v_bc ?? 0)), num(Number(l.v_icms ?? 0)), l.revisado ? 'sim' : 'não',
    ];
  });
  return csv(
    ['Emissão', 'Número', 'Série', 'Fornecedor', 'CNPJ', 'UF', 'Chave de acesso', 'Item', 'Código', 'Produto na nota',
      'Descrição tratada', 'NCM', 'CFOP de saída', 'CFOP de entrada', 'Unidade', 'Quantidade', 'Valor dos produtos',
      'Desconto', 'Frete', 'Seguro', 'Outras despesas', 'ICMS ST', 'IPI', 'Valor contábil', 'Base de cálculo ICMS', 'ICMS',
      'Conferido'],
    [...corpo, ['TOTAL', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', num(t.vp), '', '', '', '', num(t.st),
      num(t.ipi), num(t.vc), num(t.bc), num(t.icms), '']],
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
