import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { lerSegredo, segredoPlausivel, acharIdBanco, trocarDatabaseId, contarUsuarios }
  from '../scripts/partes.mjs';

/**
 * Os pedaços da publicação que interpretam saída de ferramenta ou arquivo escrito
 * à mão. Três destes quatro já estiveram errados — e nenhum erro apareceria antes
 * de estar publicando de verdade, com a conta real, no meio do processo.
 */

/** O SEGREDOS.txt tem um bloco de instruções ANTES dos valores. Era a armadilha. */
const SEGREDOS = `Segredos do Planee Fiscal — NÃO COMMITAR.

Use com:
  npx wrangler secret put SESSION_SECRET
  npx wrangler secret put AUDIT_SEED

SESSION_SECRET
Ty7oDzR6-PnI6vcJ1MIEnvyM1foCAsWXvipJTH71I4nvJYuCTG16mC4L3PF4gEsx

AUDIT_SEED
bee565617b22e50a43e70d3bb555abaaee0a857d57d3c6c26371bf19fc3f6cb1

Depois de cadastrar os dois, apague este arquivo.
`;

describe('ler segredo do SEGREDOS.txt', () => {
  it('pega o valor, não a palavra que vem depois do nome nas instruções', () => {
    expect(lerSegredo(SEGREDOS, 'SESSION_SECRET'))
      .toBe('Ty7oDzR6-PnI6vcJ1MIEnvyM1foCAsWXvipJTH71I4nvJYuCTG16mC4L3PF4gEsx');
    expect(lerSegredo(SEGREDOS, 'AUDIT_SEED'))
      .toBe('bee565617b22e50a43e70d3bb555abaaee0a857d57d3c6c26371bf19fc3f6cb1');
  });

  it('a regex ingênua pegaria "npx" — é o bug que este teste existe para travar', () => {
    const ingenua = (n: string) =>
      (SEGREDOS.match(new RegExp(`${n}\\s*\\n\\s*(\\S+)`)) || [])[1];
    expect(ingenua('SESSION_SECRET')).toBe('npx');
    expect(ingenua('AUDIT_SEED')).toBe('SESSION_SECRET');
  });

  it('nome ausente devolve undefined em vez de chutar', () => {
    expect(lerSegredo(SEGREDOS, 'NAO_EXISTE')).toBeUndefined();
  });

  it('tolera CRLF — o arquivo nasce no Windows', () => {
    expect(lerSegredo(SEGREDOS.replace(/\n/g, '\r\n'), 'AUDIT_SEED'))
      .toBe('bee565617b22e50a43e70d3bb555abaaee0a857d57d3c6c26371bf19fc3f6cb1');
  });
});

describe('a segunda rede: o que não pode virar segredo de produção', () => {
  it('recusa palavra de comando, valor curto e valor com espaço', () => {
    for (const ruim of ['npx', 'wrangler', 'senha123', 'tem espaço no meio aqui dentro', '']) {
      expect(segredoPlausivel(ruim)).toBe(false);
    }
  });

  it('aceita os segredos de verdade', () => {
    expect(segredoPlausivel(lerSegredo(SEGREDOS, 'SESSION_SECRET'))).toBe(true);
    expect(segredoPlausivel(lerSegredo(SEGREDOS, 'AUDIT_SEED'))).toBe(true);
  });
});

describe('achar o banco na saída do wrangler', () => {
  const SAIDA = `
 ⛅️ wrangler 3.114.17 (update available 4.128.0)
▲ [WARNING] The version of Wrangler you are using is now out-of-date.
[
  {"uuid":"a1b2c3d4-1111-2222-3333-444455556666","name":"planee-fiscal"},
  {"uuid":"9999","name":"outro-projeto"}
]
`;

  it('acha o uuid mesmo com banner e aviso antes do JSON', () => {
    expect(acharIdBanco(SAIDA, 'planee-fiscal')).toBe('a1b2c3d4-1111-2222-3333-444455556666');
  });

  it('não confunde com outro banco da mesma conta', () => {
    expect(acharIdBanco(SAIDA, 'planee-fiscal')).not.toBe('9999');
  });

  it('banco inexistente é null — e o script então cria', () => {
    expect(acharIdBanco(SAIDA, 'nao-existe')).toBeNull();
  });

  it('saída quebrada é null, nunca uma exceção no meio do deploy', () => {
    expect(acharIdBanco('erro: nao autenticado', 'planee-fiscal')).toBeNull();
    expect(acharIdBanco('[{quebrado', 'planee-fiscal')).toBeNull();
  });
});

describe('escrever o database_id no wrangler.jsonc', () => {
  const conf = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

  it('troca o id e não encosta em mais nada', () => {
    const novo = trocarDatabaseId(conf, 'novo-id-aqui')!;
    expect(novo).toContain('"database_id": "novo-id-aqui"');
    const normalizar = (t: string) => t.replace(/"database_id":\s*"[^"]*"/, 'X');
    expect(normalizar(novo)).toBe(normalizar(conf));
  });

  it('o placeholder do repositório é substituível — se deixar de ser, o deploy quebra', () => {
    expect(trocarDatabaseId(conf, 'x')).not.toBeNull();
  });

  it('arquivo sem o campo devolve null em vez de fingir que gravou', () => {
    expect(trocarDatabaseId('{ "name": "planee-fiscal" }', 'x')).toBeNull();
  });
});

describe('contar usuários antes de criar o primeiro admin', () => {
  it('lê o número da saída --json', () => {
    expect(contarUsuarios('[{"results":[{"n":2}],"success":true}]')).toBe(2);
    expect(contarUsuarios('[{"results":[{"n":0}],"success":true}]')).toBe(0);
  });

  it('a tabela ASCII (sem --json) devolve null, não zero', () => {
    // Era o bug: `?? 0` transformava "não sei" em "não tem usuário", e o script
    // criava um admin que já existia — UNIQUE do e-mail estourando no meio da
    // publicação, depois do banco e dos buckets já criados.
    expect(contarUsuarios('┌───┐\n│ n │\n├───┤\n│ 4 │\n└───┘')).toBeNull();
  });

  it('erro do wrangler também é null', () => {
    expect(contarUsuarios('✘ [ERROR] no such table: usuarios')).toBeNull();
  });
});

describe('o aviso de wrangler desatualizado — bug pego pelo teste acima', () => {
  /* `▲ [WARNING] The version of Wrangler you are using is now out-of-date.`
     tem um '[' que vem ANTES do JSON. Cortar no primeiro '[' fazia o parse
     estourar e a função devolver null — o script concluiria que o banco não
     existe e criaria um SEGUNDO "planee-fiscal" na conta, apontando o
     wrangler.jsonc para o banco vazio e deixando os dados no primeiro.
     Esse aviso aparece na máquina do Mateus a cada comando. */

  it('acha o JSON mesmo com colchetes no ruído anterior', () => {
    const saida = '▲ [WARNING] out-of-date\n[ERROR] nada\n[{"uuid":"u1","name":"planee-fiscal"}]';
    expect(acharIdBanco(saida, 'planee-fiscal')).toBe('u1');
  });

  it('e mesmo quando o ruído contém um array que não é a lista de bancos', () => {
    const saida = '[1,2,3]\n[{"uuid":"u9","name":"planee-fiscal"}]';
    expect(acharIdBanco(saida, 'planee-fiscal')).toBe('u9');
  });

  it('só ruído com colchetes continua sendo null', () => {
    expect(acharIdBanco('▲ [WARNING] nada aqui', 'planee-fiscal')).toBeNull();
  });
});
