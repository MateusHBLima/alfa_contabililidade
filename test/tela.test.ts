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

const COMPARTILHADOS = ['pode', 'esc', 'moeda', 'dataCurta', 'selinhoProcedencia'];

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

/**
 * Permissão sem rota que a exija é decoração.
 *
 * O administrador marca "pode apagar regra" num papel, entrega para alguém, e
 * nada acontece — nem para liberar, nem para impedir. A caixinha parece um
 * controle e não controla. Foi assim que `regras.fixar` ficou: qualquer pessoa
 * que pudesse editar o CFOP de um item podia, de quebra, fixar o padrão do
 * fornecedor inteiro.
 *
 * Este teste não exige que tudo esteja pronto — exige que a dívida seja
 * declarada. Permissão nova sem rota quebra a suíte; permissão que já se sabe
 * pendente entra na lista abaixo, com motivo.
 */
describe('catálogo de permissões x rotas', () => {
  const SERVIDOR = ['../src/index.ts', '../src/db/repo.ts', '../src/rules/campos.ts']
    .map((f) => readFileSync(new URL(f, import.meta.url), 'utf8'))
    .join('\n');

  const CATALOGO = readFileSync(new URL('../src/auth/permissoes.ts', import.meta.url), 'utf8');

  /** Ainda sem rota, de propósito e com data para resolver. */
  const PENDENTES = new Set([
    // Precisam de endpoint novo: hoje as regras só podem ser lidas.
    'regras.aprovar',
    'regras.apagar',
    // Desativar cliente ainda não tem rota própria (só apagar, que é outra coisa).
    'empresas.desativar',
    // A trilha é gravada a cada alteração e ainda não há como consultá-la.
    'auditoria.visualizar',
  ]);

  it('toda permissão do catálogo é exigida por alguma rota', () => {
    const chaves = [...CATALOGO.matchAll(/^ {2}'([a-z_]+\.[a-z_]+)':/gm)].map((m) => m[1]!);
    expect(chaves.length).toBeGreaterThan(20);

    const orfas = chaves.filter((k) => !SERVIDOR.includes(`'${k}'`) && !PENDENTES.has(k));
    expect(orfas, `permissão sem rota que a exija: ${orfas.join(', ')}`).toEqual([]);
  });

  it('a lista de pendentes não cresce sem alguém reparar', () => {
    // Se uma pendente foi resolvida, tire-a da lista — o teste avisa.
    const resolvidas = [...PENDENTES].filter((k) => SERVIDOR.includes(`'${k}'`));
    expect(resolvidas, `já tem rota, tire de PENDENTES: ${resolvidas.join(', ')}`).toEqual([]);
  });
});


/**
 * Estado ou procedência que o servidor emite e a tela não desenha vira linha muda.
 *
 * O caso que motivou: `estiloDaLinha` ganhou os estados 'padrao' e 'aprendido',
 * e o filtro "Prontos" — que comparava com 'pronto' — passaria a ESCONDER
 * justamente as linhas que o sistema acertou sozinho. Some sem erro, sem log,
 * sem nada: a pessoa conclui que o sistema não aprendeu.
 */
describe('a tela desenha tudo que o servidor manda', () => {
  const ALERTAS = readFileSync(new URL('../src/rules/alertas.ts', import.meta.url), 'utf8');
  const CSS = readFileSync(new URL('../public/estilo.css', import.meta.url), 'utf8');

  const entreAspas = (trecho: string) =>
    [...trecho.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!);

  it('todo estado de linha tem estilo próprio no CSS', () => {
    const linha = ALERTAS.match(/estado: ([^;]+);/)!;
    const estados = entreAspas(linha[1]!);
    expect(estados.length).toBeGreaterThanOrEqual(7);

    const semEstilo = estados.filter((e) => !CSS.includes(`.selo-${e}`));
    expect(semEstilo, `estado sem selo no CSS: ${semEstilo.join(', ')}`).toEqual([]);
  });

  it('toda fonte de procedência é desenhada pela tela e tem cor', () => {
    const bloco = ALERTAS.match(/fonte: ([^;]+);/)!;
    const fontes = entreAspas(bloco[1]!).filter((f) => f !== 'nenhuma');
    expect(fontes.sort()).toEqual(['aprendida', 'fixada', 'perfil']);

    for (const f of fontes) {
      expect(APP, `a tela não trata procedência "${f}"`).toContain(`'${f}'`);
      expect(CSS, `procedência "${f}" sem cor`).toContain(`.proc-${f}`);
    }
  });

  it('o filtro "Prontos" não esconde o que o sistema acertou sozinho', () => {
    const filtro = APP.match(/estado\.filtro === 'pronto'\) return ([^;]+);/)!;
    for (const e of ['pronto', 'padrao', 'aprendido']) {
      expect(filtro[1]!, `filtro Prontos ignora "${e}"`).toContain(`'${e}'`);
    }
  });
});
