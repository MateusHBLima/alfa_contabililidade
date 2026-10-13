import { describe, it, expect } from 'vitest';
import { coberturaDaSef, mesesDaSef } from '../src/captura/captura';

/** 13/10 (Taís): mês completo, em andamento ou sem movimento, a partir das consultas à SEF. */
describe('13/10: o mês está completo na SEF?', () => {
  const meses = (m: Record<string, [number, number]>) => new Map(Object.entries(m).map(([k, [s, c]]) => [k, { noSistema: s, naCaixa: c }]));

  it('a SEF guarda desde o dia 1º de dois meses antes da primeira consulta; entregou tudo até 2 dias antes da última consulta completa', () => {
    // 01/10 10:59 em Brasília = 13:59 UTC
    expect(coberturaDaSef('2026-10-01T13:59:40.702Z', '2026-10-13T12:00:00.000Z')).toEqual({ de: '2026-08-01', ate: '2026-10-11' });
    // 02/10 01:00 UTC ainda é 01/10 em Brasília
    expect(coberturaDaSef('2026-10-01T13:59:00Z', '2026-10-02T01:00:00Z')).toEqual({ de: '2026-08-01', ate: '2026-09-29' });
    expect(coberturaDaSef(null, null)).toBeNull();
    expect(coberturaDaSef('2026-10-01T13:59:00Z', null)).toEqual({ de: '2026-08-01', ate: null });
  });

  it('mês completo, sem movimento e em andamento', () => {
    const r = mesesDaSef({
      primeiraConsulta: '2026-10-01T13:59:40Z', completoEm: '2026-10-13T12:00:00Z',
      meses: meses({ '2026-09': [152, 0], '2026-10': [23, 5], '2026-07': [10, 0] }),
    }, new Date('2026-10-13T15:00:00Z'));
    expect(r).toEqual([
      { competencia: '2026-08', noSistema: 0, naCaixa: 0, completo: true, semMovimento: true },
      { competencia: '2026-09', noSistema: 152, naCaixa: 0, completo: true, semMovimento: false },
      { competencia: '2026-10', noSistema: 23, naCaixa: 5, completo: false, semMovimento: false },
    ]);
  });

  it('o mês que acabou só fecha quando a consulta já pega o último dia inteiro', () => {
    const base = { primeiraConsulta: '2026-10-01T13:59:40Z', meses: meses({}) };
    // Consulta completa em 01/10: setembro ainda não está inteiro (as do dia 30 chegam até 01/10 23:59).
    expect(mesesDaSef({ ...base, completoEm: '2026-10-01T22:00:00Z' }, new Date('2026-10-02T12:00:00Z'))[1])
      .toMatchObject({ competencia: '2026-09', completo: false, semMovimento: false });
    // Consulta completa em 02/10 depois da meia-noite: setembro fechado.
    expect(mesesDaSef({ ...base, completoEm: '2026-10-02T03:30:00Z' }, new Date('2026-10-02T12:00:00Z'))[1])
      .toMatchObject({ competencia: '2026-09', completo: true, semMovimento: true });
  });

  it('sem nenhuma consulta completa: nada é dado como completo nem sem movimento', () => {
    const r = mesesDaSef({ primeiraConsulta: '2026-10-01T13:59:40Z', completoEm: null, meses: meses({}) }, new Date('2026-10-13T15:00:00Z'));
    expect(r.every((m) => !m.completo && !m.semMovimento)).toBe(true);
    expect(mesesDaSef({ primeiraConsulta: null, completoEm: null, meses: meses({}) })).toEqual([]);
  });
});
