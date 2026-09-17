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

const COMPARTILHADOS = ['pode', 'esc', 'moeda', 'dataCurta', 'selinhoProcedencia', 'podeFixar'];

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
    // `auditoria.visualizar` saiu daqui em 16/09: GET /api/itens/:id/trilha.
    // Foi este teste que avisou que a dívida tinha sido paga.
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
    expect(fontes.sort()).toEqual(['aprendida', 'fixada', 'manual', 'perfil']);

    for (const f of fontes) {
      expect(APP, `a tela não trata procedência "${f}"`).toContain(`'${f}'`);
      expect(CSS, `procedência "${f}" sem cor`).toContain(`.proc-${f}`);
    }
  });

  it('toda marca da linha (9c) é desenhada: classe na linha, etiqueta em texto e cor no CSS', () => {
    const bloco = ALERTAS.match(/export type MarcasDaLinha = \{([\s\S]*?)\};/)!;
    const marcas = [...bloco[1]!.matchAll(/^\s*(\w+): boolean;/gm)].map((m) => m[1]!);
    expect(marcas.sort()).toEqual(['cfopForaDoNormal', 'produtoNovo']);
    for (const m of marcas) expect(APP, `a tela ignora a marca "${m}"`).toContain(`m.${m}`);
    for (const c of ['marca-cfop', 'marca-novo', 'etiqueta-cfop', 'etiqueta-novo']) {
      expect(CSS, `sem estilo para .${c}`).toContain(`.${c}`);
      expect(APP, `a tela não usa .${c}`).toContain(c);
    }
    // Cor nunca e a unica pista: as etiquetas carregam texto.
    expect(APP).toContain('＋ NOVO');
    // Conferiu, a cor sai.
    expect(CSS).toContain(':not(.marca-apagada)');
  });

  it('a nota original abre dentro do site, de dois jeitos: como nota e como XML do fornecedor', () => {
    const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    for (const id of ['btn-ver-original', 'vOriginal', 'orig-corpo', 'orig-xml-pre', 'orig-baixar']) {
      expect(HTML, `falta #${id} na tela`).toContain(`id="${id}"`);
    }
    expect(HTML).toContain('data-modo="nota"');
    expect(HTML).toContain('data-modo="xml"');
    // O XML mostrado e o ARQUIVO guardado (mesma rota do download), nunca remontado do banco.
    expect(APP).toContain('/original?formato=xml');
    // irPara precisa conhecer a tela, senao ela abre por cima das outras.
    expect(APP).toMatch(/\[[^\]]*'vOriginal'[^\]]*\]\.forEach/);
  });

  it('XML corrigido não é mais beco: abre preenchida pelo MENU, tem lista, prévia real e zip', () => {
    const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    // O defeito original: o menu chamava irPara('v3') e ninguem desenhava a pagina.
    expect(APP).toMatch(/if \(view === 'v3'\) abrirXmlCorrigido\(\)/);
    for (const id of ['tbl-xc', 'xc-competencia', 'xc-baixar-zip', 'previa-xml', 'tbl-xc-mudancas']) {
      expect(HTML, `falta #${id}`).toContain(`id="${id}"`);
    }
    expect(HTML).not.toContain('Selecione uma nota no ambiente 2');
    expect(APP).toContain('/xml-corrigido/previa');
    expect(APP).toContain('/xml-corrigidos.zip?competencia=');
  });

  it('filtro que não casa nada diz o porquê e oferece a volta', () => {
    // Visto em produção: nota com 7 itens conferidos, filtro "Prontos", tela em
    // branco. Sem erro, sem mensagem — a mesma forma do bug do `pode()`: a tela
    // não quebra, ela mente calada, e quem usa conclui que perdeu o trabalho.
    expect(APP).toContain('lista.length === 0');
    expect(APP).toContain('limpar-filtro-itens');
    for (const f of ['atencao', 'novo', 'pronto', 'conferido']) {
      expect(APP, `filtro "${f}" sem mensagem de vazio`).toMatch(
        new RegExp(`${f}:\\s*'`),
      );
    }
  });

  it('o seletor de mês não se alimenta das notas já filtradas', () => {
    // Bug real: as opções saíam de `estado.notas`, que é o RESULTADO da busca.
    // Escolher setembro apagava agosto da lista, e quem não descobrisse o
    // caminho de volta concluía que as notas de agosto tinham sumido. Opção de
    // filtro vem do universo inteiro — aqui, de /competencias.
    expect(APP).toContain('/competencias');
    expect(APP).not.toContain('estado.notas.map((n) => n.competencia)');
  });

  it('mês sem ano não filtra nada — "setembro" de qual exercício?', () => {
    expect(APP).toContain('ano && mes ?');
  });

  it('o filtro "Prontos" não esconde o que o sistema acertou sozinho', () => {
    const filtro = APP.match(/estado\.filtro === 'pronto'\) return ([^;]+);/)!;
    for (const e of ['pronto', 'padrao', 'aprendido']) {
      expect(filtro[1]!, `filtro Prontos ignora "${e}"`).toContain(`'${e}'`);
    }
  });
});


/**
 * "É sempre assim" é um botão que cria regra verde na hora. O escopo dele é a
 * única coisa que separa "esse produto é assim" de "carimbei o fornecedor
 * inteiro sem querer" — que é literalmente um bug que já aconteceu neste
 * projeto (ver §9 da constituição).
 */
describe('tela: o botão de fixar padrão do produto', () => {
  it('só aparece para quem tem a permissão', () => {
    expect(APP).toContain("pode('regras.fixar')");
  });

  it('não aparece sem CFOP preenchido, nem no que já é padrão fixado', () => {
    const fn = APP.slice(APP.indexOf('function podeFixar'), APP.indexOf('function podeFixar') + 300);
    expect(fn).toContain('cfop_novo');
    expect(fn).toContain("'fixada'");
  });

  it('pede confirmação antes, e diz que não toca nos outros itens', () => {
    const fn = APP.slice(APP.indexOf('async function fixarProduto'), APP.indexOf('async function fixarProduto') + 1200);
    expect(fn).toContain('await confirmar(');
    expect(fn).toMatch(/Não altera nenhum outro item/);
  });

  it('manda escopo de item, nunca de fornecedor', () => {
    const fn = APP.slice(APP.indexOf('async function fixarProduto'), APP.indexOf('async function fixarProduto') + 1200);
    expect(fn).toContain('fixar: true');
    expect(fn, 'fixarProduto não pode mandar escopo de fornecedor').not.toContain("escopo: 'fornecedor'");
  });
});


describe('tela: salvar o padrão de todos de uma vez', () => {
  const HTML = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  it('o botão existe', () => {
    expect(HTML).toContain('btn-fixar-visiveis');
  });

  it('é UMA requisição, não um laço de requisições no navegador', () => {
    // A versão óbvia seria um PATCH por item. Numa nota de 990 isso é minutos,
    // e uma falha no meio deixa metade feito sem ninguém saber.
    const i = APP.indexOf("$('#btn-fixar-visiveis')");
    const fn = APP.slice(i, i + 1600);
    expect(fn).toContain('/fixar-padrao');
    expect(fn, 'não pode haver laço de requisições aqui').not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*await api/);
  });

  it('avisa quantos, e que nenhum valor muda', () => {
    const i = APP.indexOf("$('#btn-fixar-visiveis')");
    const fn = APP.slice(i, i + 1600);
    expect(fn).toContain('await confirmar(');
    expect(fn).toMatch(/nenhum valor é alterado/);
  });

  it('não some em silêncio quando não há o que salvar', () => {
    const i = APP.indexOf("$('#btn-fixar-visiveis')");
    const fn = APP.slice(i, i + 1600);
    expect(fn).toMatch(/Não há item para salvar/);
  });
});


/**
 * As caixas do navegador voltaram a aparecer depois de trocadas? Este teste
 * avisa. `confirm()` nativo tem um defeito que não é estético: o Chrome oferece
 * "impedir esta página de criar mais caixas", e se a pessoa marcar isso sem ler,
 * o confirm passa a devolver false calado e a ação simplesmente não acontece.
 * Confirmação que some em silêncio é pior que nenhuma.
 */
describe('tela: nenhuma caixa de diálogo do navegador', () => {
  const semComentarios = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  for (const nativo of ['window.alert', 'window.confirm', 'window.prompt']) {
    it(`não usa ${nativo}`, () => {
      expect(semComentarios).not.toContain(nativo);
    });
  }

  it('não chama confirm() nem alert() soltos', () => {
    expect(semComentarios, 'confirm() nativo voltou').not.toMatch(/(^|[^a-zA-Z.])confirm\s*\(/);
    expect(semComentarios, 'alert() nativo voltou').not.toMatch(/(^|[^a-zA-Z.])alert\s*\(/);
  });

  it('o diálogo próprio existe e devolve promessa', () => {
    expect(APP).toContain('function confirmar(');
    expect(APP).toContain('function avisar(');
    expect(APP).toContain('new Promise');
  });

  it('dá saída pelo Esc — senão a pessoa fica presa', () => {
    expect(APP).toContain("ev.key === 'Escape'");
  });

  it('respeita quem pediu menos movimento no sistema', () => {
    const CSS = readFileSync(new URL('../public/estilo.css', import.meta.url), 'utf8');
    expect(CSS).toContain('prefers-reduced-motion');
  });
});


describe('tela: "como estava" — a trilha na linha do item', () => {
  it('o link existe, e só para quem pode consultar a trilha', () => {
    expect(APP).toContain("pode('auditoria.visualizar')");
    expect(APP).toContain('data-trilha');
  });

  it('lê a rota da trilha, não inventa o histórico da tela', () => {
    expect(APP).toContain('/trilha');
  });

  it('voltar atrás é uma alteração como outra qualquer — e fica registrada', () => {
    // Nada de apagar ou reescrever evento: a trilha é append-only (invariante 8).
    const i = APP.indexOf('async function verTrilha');
    const fn = APP.slice(i, i + 3000);
    expect(fn).toContain("method: 'PATCH'");
    expect(fn, 'a trilha não pode ser apagada').not.toMatch(/method:\s*'DELETE'/);
    expect(fn).toMatch(/nunca é apagada/);
  });
});
