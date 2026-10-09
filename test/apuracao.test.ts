import { describe, it, expect } from 'vitest';
import { aliquotaDoItem, aliquotaEntra, montarCandidatas, ehSimples, type ItemApuracao } from '../src/relatorios/apuracao';

/** Antecipação e DIFAL, primeira parte (09/10): quais notas aparecem. Dados sintéticos. */
const item = (nota: string, cfop: string, base: number, icms: number, extra: Partial<ItemApuracao> = {}): ItemApuracao => ({
  nota_id: nota, numero: nota.replace(/\D/g, '') || '1', serie: '1', dh_emi: '2026-09-10T10:00:00-03:00', emit_nome: 'FORNECEDOR', emit_cnpj: '11222333000181',
  emit_uf: 'SP', valor_nota: 1000, n_item: 1, descricao: 'PRODUTO', ncm: '00000000', cfop, valor_produto: base, valor_contabil: base,
  base, icms, ipi: 0, st: 0, ...extra,
});

describe('09/10: antecipação e DIFAL — quais notas aparecem', () => {
  it('a alíquota vem de ICMS ÷ base, e meio décimo de folga cobre o arredondamento do fornecedor', () => {
    expect(aliquotaDoItem(100, 4)).toBe(4);
    expect(aliquotaDoItem(333.33, 13.33)).toBe(4);
    expect(aliquotaDoItem(0, 4)).toBeNull();
    expect(aliquotaDoItem(100, 0)).toBeNull();
    expect(aliquotaEntra(4.04, [4])).toBe(true);
    expect(aliquotaEntra(7, [4, 12])).toBe(false);
    expect(aliquotaEntra(null, [4])).toBe(false);
  });

  it('antecipação: só 1102/2102 a 4%; item de outra alíquota fica de fora e é contado', () => {
    const r = montarCandidatas('antecipacao', [
      item('n1', '2102', 100, 4), item('n1', '2102', 200, 24, { n_item: 2 }), item('n1', '1556', 50, 2, { n_item: 3 }),
      item('n2', '1102', 100, 12),
      item('n3', '1102', 300, 36, { dh_emi: '2026-09-01T08:00:00-03:00' }), item('n3', '1102', 50, 2, { dh_emi: '2026-09-01T08:00:00-03:00', n_item: 2 }),
    ], new Map([['n1', { situacao: 'fica' as const, por: 'Taís', em: '2026-10-09' }]]));
    expect(r.notas.map((n) => [n.notaId, n.itens.length, n.foraPelaAliquota, n.valorContabil, n.icms, n.situacao])).toEqual([
      ['n3', 1, 1, 50, 2, 'conferir'],
      ['n1', 1, 1, 100, 4, 'fica'],
    ]);
    expect(r.totais).toMatchObject({ notas: 2, fica: 1, conferir: 1, sai: 0, valorContabilFica: 100, icmsFica: 4 });
  });

  it('DIFAL: uso e consumo e ativo para uso (1556/2556/1407/2407) a 4% ou 12%', () => {
    const r = montarCandidatas('difal', [
      item('a', '2556', 100, 12), item('b', '2407', 100, 4), item('c', '1556', 100, 17), item('d', '2102', 100, 4),
    ], new Map());
    expect(r.notas.map((n) => [n.notaId, n.aliquotas])).toEqual([['a', [12]], ['b', [4]]]);
  });

  it('Simples: os três tipos do cadastro e o antigo', () => {
    expect(['simples', 'simples_integral', 'simples_hibrido', 'simples_fora'].every(ehSimples)).toBe(true);
    expect(ehSimples('presumido')).toBe(false);
    expect(ehSimples(null)).toBe(false);
  });
});
