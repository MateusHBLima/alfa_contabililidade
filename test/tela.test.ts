import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A tela não tem teste de unidade — ela é verificada no navegador. Mas um erro
 * específico já escapou duas vezes e não dá sinal nenhum: helper declarado
 * DENTRO de uma função e usado FORA dela.
 *
 * Foi o que aconteceu com `pode`: era `const pode` dentro de `entrar()`, e as
 * listas de notas e empresas passaram a usá-lo. O template literal lançava
 * `ReferenceError` no meio da montagem do HTML, a tabela aparecia VAZIA, e
 * nenhuma mensagem de erro chegava ao usuário — parecia banco sem dados.
 *
 * Este teste é barato e pega exatamente essa classe: os helpers usados por mais
 * de uma tela precisam morar no escopo do módulo.
 */

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const COMPARTILHADOS = ['pode', 'esc', 'moeda', 'dataCurta'];

describe('tela: helpers compartilhados', () => {
  for (const nome of COMPARTILHADOS) {
    it(`${nome} está no escopo do módulo, não dentro de uma função`, () => {
      const noModulo = new RegExp(`^(function ${nome}\\b|const ${nome}\\s*=)`, 'm');
      expect(APP).toMatch(noModulo);
    });
  }

  it('nenhum helper compartilhado é redeclarado indentado (dentro de função)', () => {
    for (const nome of COMPARTILHADOS) {
      // `\s` engole quebra de linha, e com a flag `m` isso faz o padrao casar
      // uma declaracao NAO indentada duas linhas abaixo. Espaco e tab, nada mais.
      const indentado = new RegExp(`^[ \\t]+(const|let|function) ${nome}\\b`, 'm');
      expect(APP, `${nome} redeclarado dentro de uma função`).not.toMatch(indentado);
    }
  });
});
