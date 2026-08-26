import { describe, it, expect } from 'vitest';
import { D1Local } from './d1-local';
import { TODAS_PERMISSOES, PAPEIS_SEMENTE, CAMPOS_PERMISSOES_USADAS } from '../src/auth/permissoes';

/**
 * O catálogo de permissões existe em dois lugares: no TypeScript (que a API consulta)
 * e no SQL da migração 0003 (que popula o banco). Dois lugares divergem em silêncio -
 * e o sintoma seria uma permissão que ninguém consegue conceder, ou pior, um campo que
 * a API bloqueia sem que exista papel capaz de liberá-lo.
 *
 * Estes testes existem para que essa divergência quebre o build, e não a produção.
 */

function banco() {
  const db = new D1Local();
  db.migrar();
  return db;
}

describe('semente do banco bate com o catálogo em código', () => {
  it('as permissões são exatamente as mesmas nos dois lados', () => {
    const noBanco = banco()
      .consultar<{ chave: string }>('SELECT chave FROM permissoes ORDER BY chave')
      .map((r) => r.chave);
    expect(noBanco).toEqual([...TODAS_PERMISSOES].sort());
  });

  it('os papéis-semente existem no banco', () => {
    const noBanco = banco()
      .consultar<{ nome: string }>('SELECT nome FROM papeis ORDER BY nome')
      .map((r) => r.nome);
    expect(noBanco).toEqual([...PAPEIS_SEMENTE.map((p) => p.nome)].sort());
  });

  it('cada papel tem no banco as mesmas permissões que declara em código', () => {
    const db = banco();
    for (const papel of PAPEIS_SEMENTE) {
      const noBanco = db
        .consultar<{ permissao: string }>(
          `SELECT pp.permissao FROM papel_permissoes pp
           JOIN papeis p ON p.id = pp.papel_id WHERE p.nome = ? ORDER BY pp.permissao`,
          papel.nome,
        )
        .map((r) => r.permissao);
      expect(noBanco, `papel ${papel.nome}`).toEqual([...papel.permissoes].sort());
    }
  });

  it('Admin é papel de sistema — ninguém apaga e se tranca para fora', () => {
    const r = banco().consultar<{ sistema: number }>("SELECT sistema FROM papeis WHERE nome='Admin'");
    expect(r[0]!.sistema).toBe(1);
  });
});

describe('toda permissão exigida por um campo do template pode ser concedida', () => {
  it('existe no catálogo', () => {
    for (const p of CAMPOS_PERMISSOES_USADAS) {
      expect(TODAS_PERMISSOES, `permissão ${p} usada por um campo`).toContain(p);
    }
  });

  it('e existe pelo menos um papel que a concede', () => {
    for (const p of CAMPOS_PERMISSOES_USADAS) {
      const temPapel = PAPEIS_SEMENTE.some((papel) => papel.permissoes.includes(p as any));
      expect(temPapel, `nenhum papel concede ${p}`).toBe(true);
    }
  });
});

describe('dicionário de abreviações', () => {
  it('vem semeado, para o sistema não começar mudo', () => {
    const n = banco().consultar<{ n: number }>('SELECT COUNT(*) AS n FROM abreviacoes')[0]!.n;
    expect(n).toBeGreaterThan(10);
  });
});
