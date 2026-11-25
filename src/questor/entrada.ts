import { lerExtrasDoXml, type ItemEntrada, type NotaEntrada } from './leiaute200';

/**
 * Da nota tratada no sistema para a nota do leiaute 200 (25/11).
 *
 * A natureza de cada item é o CFOP de entrada mais o complemento: o escolhido na linha,
 * se for um complemento daquele CFOP na lista da empresa; senão, o padrão da empresa
 * para o CFOP. Sem nenhum dos dois, a nota NÃO sai: mandar só o CFOP seria repetir o
 * que o XML já faz, e o motivo de usar o SYN é a natureza inteira.
 */

type Natureza = { cfop: string; complemento: string; padrao: boolean };

export function naturezaDoItem(cfop: string, escolhido: string | null | undefined, lista: Natureza[]): string | null {
  const doCfop = lista.filter((n) => n.cfop === cfop);
  const valido = doCfop.find((n) => n.complemento === String(escolhido ?? '').trim());
  const usado = valido ?? doCfop.find((n) => n.padrao);
  return usado ? `${cfop}${usado.complemento}` : null;
}

const n = (v: unknown) => (v === null || v === undefined || v === '' ? 0 : Number(v) || 0);

export function notaParaEntrada(
  nota: any, itens: any[], xmlOriginal: string, naturezas: Natureza[], cnpjEmpresa: string,
): { ok: true; entrada: NotaEntrada } | { ok: false; erro: string } {
  if (nota.cancelada_em) return { ok: false, erro: 'nota cancelada não vai para o Questor' };
  if (Number(nota.estorno) === 1) return { ok: false, erro: 'nota de estorno não vai para o Questor por aqui' };

  const semEntrada = itens.filter((i) => !/^[123]\d{3}$/.test(String(i.cfop_novo ?? '').trim()));
  if (semEntrada.length) {
    return { ok: false, erro: `item ${semEntrada.map((i) => i.n_item).join(', ')} sem CFOP de entrada` };
  }
  const semNatureza = [...new Set(itens
    .filter((i) => !naturezaDoItem(String(i.cfop_novo).trim(), i.complemento, naturezas))
    .map((i) => String(i.cfop_novo).trim()))];
  if (semNatureza.length) {
    return {
      ok: false,
      erro: `esta empresa não tem complemento padrão para o CFOP ${semNatureza.join(', ')}: carregue a lista de complementos dela antes de mandar ao Questor`,
    };
  }

  const extras = lerExtrasDoXml(xmlOriginal);
  const lista: ItemEntrada[] = itens.map((i) => {
    const cfop = String(i.cfop_novo).trim();
    const valorProduto = n(i.valor_total);
    const lidos = Number(i.valores_lidos) === 1;
    return {
      nItem: Number(i.n_item),
      cProd: String(i.c_prod ?? i.n_item),
      descricao: String(i.x_prod_novo || i.x_prod_original || ''),
      ncm: i.ncm ?? null,
      unidade: i.unidade ?? null,
      quantidade: n(i.quantidade),
      valorUnitario: n(i.valor_unitario),
      valorProduto,
      desconto: n(i.v_desc), frete: n(i.v_frete), seguro: n(i.v_seg), outras: n(i.v_outro),
      baseIcms: n(i.v_bc_icms), icms: n(i.v_icms), baseSt: n(i.v_bc_st), st: n(i.v_st), ipi: n(i.v_ipi),
      valorContabil: lidos && i.valor_contabil !== null && i.valor_contabil !== undefined ? n(i.valor_contabil) : valorProduto,
      cfop,
      natureza: naturezaDoItem(cfop, i.complemento, naturezas)!,
    };
  });

  return {
    ok: true,
    entrada: {
      cnpjEmpresa,
      numero: String(nota.numero ?? ''),
      serie: nota.serie ?? null,
      chave: String(nota.chave ?? ''),
      dataEmissao: String(nota.dh_emi ?? '').slice(0, 10),
      fornecedor: {
        ...extras.fornecedor,
        cnpj: extras.fornecedor.cnpj ?? String(nota.emit_cnpj ?? ''),
        nome: extras.fornecedor.nome ?? String(nota.emit_nome ?? ''),
      },
      indPag: extras.indPag,
      tPag: extras.tPag,
      modFrete: extras.modFrete,
      duplicatas: extras.duplicatas,
      itens: lista,
      icmsDoItem: extras.icmsDoItem,
    },
  };
}
