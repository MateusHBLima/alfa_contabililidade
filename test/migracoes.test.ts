import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * O SQLite do D1 (workerd) recusa SELECT composto com muitos termos ("too many
 * terms in compound SELECT") — o SQLite do Node, usado na suíte, aceita. Foi pego
 * no teste local da 0018 antes de ir para produção: a migração falharia no deploy.
 */
describe('migrações cabem no D1', () => {
  it('nenhuma instrução com mais de 4 UNION', () => {
    for (const f of readdirSync('migrations').filter((x) => x.endsWith('.sql'))) {
      const sql = readFileSync(`migrations/${f}`, 'utf8').replace(/--.*$/gm, '');
      for (const instrucao of sql.split(';')) {
        const unioes = (instrucao.match(/\bUNION\b/gi) ?? []).length;
        expect(unioes, `${f}: ${instrucao.trim().slice(0, 60)}…`).toBeLessThanOrEqual(4);
      }
    }
  });
});
