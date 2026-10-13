import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Período "Emissão de ... até" com OK (13/10): leitura da data e atalhos.
 * O arquivo é um script comum do navegador; aqui ele é avaliado e as funções
 * puras são testadas sem tela.
 */
const SRC = readFileSync(new URL('../public/periodo.js', import.meta.url), 'utf8');
const { lerDataBr, atalhoPeriodo } = new Function(
  `${SRC}; return { lerDataBr, atalhoPeriodo };`,
)() as {
  lerDataBr: (t: string) => { iso?: string; erro?: string };
  atalhoPeriodo: (q: string, hoje?: Date) => { de: string; ate: string };
};
const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

describe('13/10: campo de período — ler a data no OK', () => {
  it('lê a data; vazio é sem limite', () => {
    expect(lerDataBr('01/10/2026')).toEqual({ iso: '2026-10-01' });
    expect(lerDataBr(' 29/02/2028 ')).toEqual({ iso: '2028-02-29' });
    expect(lerDataBr('')).toEqual({ iso: '' });
  });

  it('data pela metade ou que não existe não filtra: vira aviso', () => {
    expect(lerDataBr('01/10/202').erro).toMatch(/incompleta/);
    expect(lerDataBr('01/10').erro).toMatch(/incompleta/);
    expect(lerDataBr('31/09/2026').erro).toMatch(/não existe/);
    expect(lerDataBr('29/02/2026').erro).toMatch(/não existe/);
    expect(lerDataBr('01/13/2026').erro).toMatch(/não existe/);
    expect(lerDataBr('01/10/0002').erro).toMatch(/não existe/);
  });
});

describe('13/10: campo de período — atalhos', () => {
  const hoje = new Date(2026, 9, 13); // 13/10/2026
  it('este mês, mês passado, últimos 7 e 30 dias', () => {
    expect(atalhoPeriodo('este-mes', hoje)).toEqual({ de: '2026-10-01', ate: '2026-10-13' });
    expect(atalhoPeriodo('mes-passado', hoje)).toEqual({ de: '2026-09-01', ate: '2026-09-30' });
    expect(atalhoPeriodo('7-dias', hoje)).toEqual({ de: '2026-10-07', ate: '2026-10-13' });
    expect(atalhoPeriodo('30-dias', hoje)).toEqual({ de: '2026-09-14', ate: '2026-10-13' });
  });
  it('mês passado na virada do ano', () => {
    expect(atalhoPeriodo('mes-passado', new Date(2027, 0, 5))).toEqual({ de: '2026-12-01', ate: '2026-12-31' });
  });
});

describe('13/10: campo de período — na tela', () => {
  it('notas e relatórios com OK; o campo continua o dd/mm/aaaa de 01/10; nada filtra enquanto digita', () => {
    for (const p of ['notas', 'rel']) {
      for (const s of ['ok', 'limpar', 'erro']) expect(HTML).toContain(`id="${p}-${s}"`);
      expect(HTML).toMatch(new RegExp(`type="date" id="${p}-de"`));
      expect(HTML).toMatch(new RegExp(`type="date" id="${p}-ate"`));
    }
    expect(HTML).toContain('id="notas-atalhos"');
    expect(HTML.indexOf('src="/periodo.js"')).toBeLessThan(HTML.indexOf('src="/app.js"'));
    expect(APP).toContain("ligarPeriodo('notas',");
    expect(APP).toContain("ligarPeriodo('rel',");
    // Os filtros antigos, que aplicavam a cada tecla, não existem mais.
    expect(APP).not.toMatch(/#notas-de'.*addEventListener\('change'/);
    expect(APP).not.toContain('esperaDatasRel');
  });
});
