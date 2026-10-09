/**
 * Antecipação de ICMS e DIFAL — primeira parte (09/10/2026, combinado na reunião de 25/09).
 *
 * O que a Taís faz hoje à mão todo mês: separar as notas que entram na antecipação
 * (cliente do Simples, compra para revenda com ICMS de 4% na nota) e no DIFAL (uso e
 * consumo com ICMS de 4% ou 12%), olhar o PDF de cada uma, decidir quais ficam e mandar
 * ao cliente. Aqui o sistema separa as candidatas, ela marca e tira o relatório com os
 * PDFs. O CÁLCULO da guia ainda não: vem depois, conferido com notas reais calculadas
 * no simulador do ITC (contrato 3.1.d / 9.4: a regra fiscal é da contabilidade).
 *
 * A alíquota vem do item: ICMS ÷ base. O item conta pelo CFOP de ENTRADA (o que ela
 * tratou), não pelo do fornecedor.
 */

export type TipoApuracao = 'antecipacao' | 'difal';

export const CRITERIOS: Record<TipoApuracao, { nome: string; cfops: string[]; aliquotas: number[]; descricao: string }> = {
  antecipacao: {
    nome: 'Antecipação de ICMS',
    cfops: ['1102', '2102'],
    aliquotas: [4],
    descricao: 'Empresa do Simples · CFOP de entrada 1102 ou 2102 · ICMS de 4% na nota',
  },
  difal: {
    nome: 'DIFAL (uso e consumo)',
    cfops: ['1556', '2556', '1407', '2407'],
    aliquotas: [4, 12],
    descricao: 'CFOP de entrada 1556, 2556, 1407 ou 2407 · ICMS de 4% ou 12% na nota',
  },
};

export const ehTipoApuracao = (t: string): t is TipoApuracao => t === 'antecipacao' || t === 'difal';

/** Os regimes do Simples no cadastro (inclui o "simples" antigo, ainda não classificado). */
export const ehSimples = (regime: string | null | undefined) => !!regime && regime.startsWith('simples');

/** Alíquota do ICMS do item, em %, com duas casas. Sem base ou sem ICMS: null. */
export function aliquotaDoItem(base: number | null | undefined, icms: number | null | undefined): number | null {
  const b = Number(base ?? 0), v = Number(icms ?? 0);
  if (!(b > 0) || !(v > 0)) return null;
  return Math.round((v / b) * 10000) / 100;
}

/** A alíquota bate com a do critério (meio ponto de folga: arredondamento do fornecedor). */
export function aliquotaEntra(aliquota: number | null, aliquotas: number[]): boolean {
  return aliquota !== null && aliquotas.some((a) => Math.abs(a - aliquota) <= 0.05);
}

export type ItemApuracao = {
  nota_id: string; numero: string; serie: string | null; dh_emi: string; emit_nome: string | null; emit_cnpj: string | null;
  emit_uf: string | null; valor_nota: number; n_item: number; descricao: string; ncm: string | null; cfop: string;
  valor_produto: number; valor_contabil: number; base: number; icms: number; ipi: number; st: number;
};

export type NotaCandidata = {
  notaId: string; numero: string; serie: string | null; emissao: string; fornecedor: string | null; cnpj: string | null; uf: string | null;
  valorNota: number;
  /** Só os itens que entram no critério. */
  itens: { nItem: number; descricao: string; ncm: string | null; cfop: string; aliquota: number; valorContabil: number; base: number; icms: number }[];
  /** Itens da nota com o CFOP do critério mas outra alíquota: ficam de fora, para ela saber. */
  foraPelaAliquota: number;
  cfops: string[]; aliquotas: number[];
  valorContabil: number; base: number; icms: number;
  situacao: 'conferir' | 'fica' | 'sai';
  marcadoPor: string | null; marcadoEm: string | null;
};

const centavos = (v: number) => Math.round(v * 100) / 100;

export function montarCandidatas(
  tipo: TipoApuracao, itens: ItemApuracao[],
  marcas: Map<string, { situacao: 'fica' | 'sai'; por: string | null; em: string }>,
): { notas: NotaCandidata[]; totais: { notas: number; fica: number; sai: number; conferir: number; valorContabil: number; base: number; icms: number; valorContabilFica: number; icmsFica: number } } {
  const crit = CRITERIOS[tipo];
  const porNota = new Map<string, NotaCandidata>();
  for (const i of itens) {
    if (!crit.cfops.includes(String(i.cfop ?? '').trim())) continue;
    const n = porNota.get(i.nota_id) ?? {
      notaId: i.nota_id, numero: i.numero, serie: i.serie, emissao: i.dh_emi, fornecedor: i.emit_nome, cnpj: i.emit_cnpj, uf: i.emit_uf,
      valorNota: Number(i.valor_nota ?? 0), itens: [], foraPelaAliquota: 0, cfops: [], aliquotas: [],
      valorContabil: 0, base: 0, icms: 0, situacao: 'conferir' as const, marcadoPor: null, marcadoEm: null,
    };
    const aliq = aliquotaDoItem(i.base, i.icms);
    if (!aliquotaEntra(aliq, crit.aliquotas)) { n.foraPelaAliquota++; porNota.set(i.nota_id, n); continue; }
    n.itens.push({
      nItem: i.n_item, descricao: i.descricao, ncm: i.ncm, cfop: i.cfop, aliquota: aliq!,
      valorContabil: Number(i.valor_contabil ?? 0), base: Number(i.base ?? 0), icms: Number(i.icms ?? 0),
    });
    porNota.set(i.nota_id, n);
  }
  const notas = [...porNota.values()].filter((n) => n.itens.length).map((n) => {
    const m = marcas.get(n.notaId);
    return {
      ...n,
      cfops: [...new Set(n.itens.map((i) => i.cfop))].sort(),
      aliquotas: [...new Set(n.itens.map((i) => Math.round(i.aliquota)))].sort((a, b) => a - b),
      valorContabil: centavos(n.itens.reduce((t, i) => t + i.valorContabil, 0)),
      base: centavos(n.itens.reduce((t, i) => t + i.base, 0)),
      icms: centavos(n.itens.reduce((t, i) => t + i.icms, 0)),
      situacao: m?.situacao ?? 'conferir',
      marcadoPor: m?.por ?? null, marcadoEm: m?.em ?? null,
    } as NotaCandidata;
  }).sort((a, b) => a.emissao.localeCompare(b.emissao) || a.numero.localeCompare(b.numero, 'pt-BR', { numeric: true }));

  const soma = (lista: NotaCandidata[], k: 'valorContabil' | 'base' | 'icms') => centavos(lista.reduce((t, n) => t + n[k], 0));
  const fica = notas.filter((n) => n.situacao === 'fica');
  return {
    notas,
    totais: {
      notas: notas.length, fica: fica.length, sai: notas.filter((n) => n.situacao === 'sai').length,
      conferir: notas.filter((n) => n.situacao === 'conferir').length,
      valorContabil: soma(notas, 'valorContabil'), base: soma(notas, 'base'), icms: soma(notas, 'icms'),
      valorContabilFica: soma(fica, 'valorContabil'), icmsFica: soma(fica, 'icms'),
    },
  };
}
