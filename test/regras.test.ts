import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNFe } from '../src/nfe/parser';
import {
  aprender,
  aplicarAcerto,
  aplicarErro,
  chaveDoNivel,
  chavesDoItem,
  classificarConfianca,
  escolherRegra,
  normalizarDescricao,
  recalcularConfianca,
  sugerirCfop,
  sugerirDescricao,
  type Regra,
} from '../src/rules/engine';

const XML = readFileSync(new URL('./fixtures/nfe-exemplo.xml', import.meta.url), 'utf8');
const nota = parseNFe(XML);
const item1 = nota.itens[0]!; // tem cProd e cEAN
const item2 = nota.itens[1]!; // tem cProd, sem cEAN
const CNPJ = nota.emit.cnpj;

function regra(p: Partial<Regra> & Pick<Regra, 'id' | 'nivel' | 'chave' | 'campo' | 'valor'>): Regra {
  return {
    usos: 0, acertos: 0, erros: 0, errosSeguidos: 0,
    confianca: 0.5, ativa: true, suspeita: false, ...p,
  };
}

const contexto = { perfil: 'revenda' as const, ufEmitente: 'SC', ufDestinatario: 'SC' };

describe('escada de especificidade', () => {
  it('monta as chaves de cada nível', () => {
    expect(chaveDoNivel(item1, CNPJ, 1)).toBe(`${CNPJ}|7891`);
    expect(chaveDoNivel(item1, CNPJ, 2)).toBe(`${CNPJ}|7891000100103`);
    expect(chaveDoNivel(item1, CNPJ, 3)).toBe('7891000100103');
    expect(chaveDoNivel(item1, CNPJ, 4)).toBe(`${CNPJ}|18069000`);
    expect(chaveDoNivel(item1, CNPJ, 5)).toBe(CNPJ);      // padrão do fornecedor
    expect(chaveDoNivel(item1, CNPJ, 6)).toBe('18069000');
  });

  it('pula os níveis para os quais o item não tem dado', () => {
    // item 2 não tem EAN válido: níveis 2 e 3 não existem para ele
    const niveis = chavesDoItem(item2, CNPJ).map((c) => c.nivel);
    expect(niveis).toEqual([1, 4, 5, 6, 7]);
  });

  it('a regra mais específica vence a mais genérica', () => {
    const candidatas = [
      regra({ id: 'r6', nivel: 6, chave: '18069000', campo: 'cfop', valor: '1556', confianca: 0.99 }),
      regra({ id: 'r1', nivel: 1, chave: `${CNPJ}|7891`, campo: 'cfop', valor: '1102', confianca: 0.6 }),
    ];
    // nível 1 ganha mesmo com confiança menor: especificidade vem antes
    expect(escolherRegra(candidatas, 'cfop')!.id).toBe('r1');
  });

  it('empate de nível desempata por confiança', () => {
    const candidatas = [
      regra({ id: 'a', nivel: 4, chave: 'x', campo: 'cfop', valor: '1102', confianca: 0.6 }),
      regra({ id: 'b', nivel: 4, chave: 'x', campo: 'cfop', valor: '1556', confianca: 0.9 }),
    ];
    expect(escolherRegra(candidatas, 'cfop')!.id).toBe('b');
  });

  it('ignora regra suspeita ou inativa', () => {
    const candidatas = [
      regra({ id: 'ruim', nivel: 1, chave: 'x', campo: 'cfop', valor: '9999', suspeita: true }),
      regra({ id: 'ok', nivel: 5, chave: 'y', campo: 'cfop', valor: '1102' }),
    ];
    expect(escolherRegra(candidatas, 'cfop')!.id).toBe('ok');
  });

  it('não mistura campos diferentes', () => {
    const candidatas = [regra({ id: 'd', nivel: 1, chave: 'x', campo: 'descricao', valor: 'ALGO' })];
    expect(escolherRegra(candidatas, 'cfop')).toBeNull();
  });
});

describe('sugestão de CFOP', () => {
  it('sem regra nenhuma, cai no perfil da empresa', () => {
    const s = sugerirCfop(item1, [], contexto);
    expect(s.valor).toBe('1102'); // revenda, dentro do estado
    expect(s.nivel).toBe(7);
    expect(s.origem).toBe('perfil');
    expect(s.confianca).toBe('media');
  });

  it('operação interestadual usa a família 2xxx', () => {
    const s = sugerirCfop(item1, [], { ...contexto, ufDestinatario: 'PR' });
    expect(s.valor).toBe('2102');
  });

  it('perfil de uso e consumo sugere 1556', () => {
    const s = sugerirCfop(item1, [], { ...contexto, perfil: 'uso_consumo' });
    expect(s.valor).toBe('1556');
  });

  it('regra nível 1 já provada vem verde', () => {
    const r = regra({
      id: 'r1', nivel: 1, chave: `${CNPJ}|7891`, campo: 'cfop', valor: '1403',
      acertos: 5, usos: 5, confianca: 0.85,
    });
    const s = sugerirCfop(item1, [r], contexto);
    expect(s.valor).toBe('1403');
    expect(s.confianca).toBe('alta');
    expect(s.origem).toBe('regra:r1');
    expect(s.porque).toContain('mesmo código de produto');
  });

  it('regra nível 1 recém-criada vem amarela, não verde', () => {
    // "vi uma vez" não é "eu sei"
    const r = regra({ id: 'novo', nivel: 1, chave: `${CNPJ}|7891`, campo: 'cfop', valor: '1102' });
    expect(classificarConfianca(r)).toBe('media');
    expect(sugerirCfop(item1, [r], contexto).confianca).toBe('media');
  });

  it('regra genérica nunca chega a verde', () => {
    const r = regra({
      id: 'r6', nivel: 6, chave: '18069000', campo: 'cfop', valor: '1102',
      acertos: 50, usos: 50, confianca: 0.99,
    });
    expect(classificarConfianca(r)).toBe('media');
  });
});

describe('sugestão de descrição', () => {
  it('sem regra, devolve a descrição do fornecedor marcada como vermelha', () => {
    const s = sugerirDescricao(item1, []);
    expect(s.valor).toBe('CHOC AO LEITE PT 200G');
    expect(s.confianca).toBe('nenhuma');
    expect(s.origem).toBe('importacao');
  });

  it('com regra, devolve o que foi aprendido', () => {
    const r = regra({
      id: 'd1', nivel: 1, chave: `${CNPJ}|7891`, campo: 'descricao',
      valor: 'CHOCOLATE AO LEITE POTE 200G', acertos: 3, confianca: 0.8,
    });
    expect(sugerirDescricao(item1, [r]).valor).toBe('CHOCOLATE AO LEITE POTE 200G');
  });
});

describe('aprendizado', () => {
  it('preencher do zero cria regra nos níveis que aprendem sozinhos', () => {
    const acoes = aprender({ item: item1, emitCnpj: CNPJ, campo: 'cfop', valorFinal: '1102', sugestao: null });
    const criadas = acoes.filter((a) => a.tipo === 'criar');
    // o 5 (padrão do fornecedor) fica de fora: corrigir um item não define o fornecedor inteiro
    expect(criadas.map((c: any) => c.nivel)).toEqual([1, 2, 3, 4, 6]);
    expect(criadas.every((c: any) => c.valor === '1102')).toBe(true);
  });

  it('não aprende o nível 7 — ele é derivado do perfil', () => {
    const acoes = aprender({ item: item1, emitCnpj: CNPJ, campo: 'cfop', valorFinal: '1102', sugestao: null });
    expect(acoes.some((a: any) => a.nivel === 7)).toBe(false);
  });

  it('confirmar a sugestão dá um acerto à regra que sugeriu', () => {
    const sugestao = sugerirCfop(item1, [
      regra({ id: 'r1', nivel: 1, chave: `${CNPJ}|7891`, campo: 'cfop', valor: '1102' }),
    ], contexto);
    const acoes = aprender({ item: item1, emitCnpj: CNPJ, campo: 'cfop', valorFinal: '1102', sugestao });
    expect(acoes).toContainEqual({ tipo: 'confirmar', regraId: 'r1' });
    expect(acoes.some((a) => a.tipo === 'corrigir')).toBe(false);
  });

  it('corrigir a sugestão penaliza a regra que errou', () => {
    const sugestao = sugerirCfop(item1, [
      regra({ id: 'r1', nivel: 1, chave: `${CNPJ}|7891`, campo: 'cfop', valor: '1102' }),
    ], contexto);
    const acoes = aprender({ item: item1, emitCnpj: CNPJ, campo: 'cfop', valorFinal: '1556', sugestao });
    expect(acoes).toContainEqual({ tipo: 'corrigir', regraId: 'r1', valorNovo: '1556' });
    // e o valor novo é gravado nos níveis
    expect(acoes.filter((a: any) => a.tipo === 'criar').every((a: any) => a.valor === '1556')).toBe(true);
  });

  it('sugestão vinda do perfil (sem regraId) não gera confirmar nem corrigir', () => {
    const sugestao = sugerirCfop(item1, [], contexto);
    const acoes = aprender({ item: item1, emitCnpj: CNPJ, campo: 'cfop', valorFinal: '1102', sugestao });
    expect(acoes.every((a) => a.tipo === 'criar')).toBe(true);
  });
});

describe('confiança sobe e desce', () => {
  it('sem histórico, fica no meio', () => {
    expect(recalcularConfianca({ acertos: 0, erros: 0 })).toBe(0.5);
  });

  it('acertos sucessivos levam a regra ao verde', () => {
    let r = regra({ id: 'r', nivel: 1, chave: 'k', campo: 'cfop', valor: '1102' });
    expect(classificarConfianca(r)).toBe('media');
    for (let i = 0; i < 5; i++) r = aplicarAcerto(r);
    expect(r.confianca).toBeGreaterThan(0.7);
    expect(classificarConfianca(r)).toBe('alta');
  });

  it('três erros seguidos derrubam a regra para suspeita', () => {
    let r = regra({ id: 'r', nivel: 1, chave: 'k', campo: 'cfop', valor: '1102', acertos: 4, confianca: 0.8 });
    r = aplicarErro(r);
    expect(r.suspeita).toBe(false);
    r = aplicarErro(r);
    expect(r.suspeita).toBe(false);
    r = aplicarErro(r);
    expect(r.suspeita).toBe(true);
    expect(classificarConfianca(r)).toBe('nenhuma');
  });

  it('um acerto zera a contagem de erros seguidos', () => {
    let r = regra({ id: 'r', nivel: 1, chave: 'k', campo: 'cfop', valor: '1102' });
    r = aplicarErro(r);
    r = aplicarErro(r);
    r = aplicarAcerto(r);
    expect(r.errosSeguidos).toBe(0);
    r = aplicarErro(r);
    expect(r.suspeita).toBe(false);
  });
});

describe('normalização de descrição', () => {
  it('expande abreviações conhecidas', () => {
    expect(normalizarDescricao('CHOC AO LEITE PT 200G')).toBe('CHOCOLATE AO LEITE POTE 200G');
    expect(normalizarDescricao('REFRIG COLA 2L')).toBe('REFRIGERANTE COLA 2L');
  });

  it('colapsa espaços repetidos', () => {
    expect(normalizarDescricao('  DET   LIQ    NEUTRO ')).toBe('DETERGENTE LIQ NEUTRO');
  });

  it('não inventa: token desconhecido passa intacto', () => {
    expect(normalizarDescricao('XYZW MARCA PROPRIA')).toBe('XYZW MARCA PROPRIA');
  });
});

describe('o ciclo completo — segunda nota do mesmo fornecedor', () => {
  it('primeira nota manual, segunda vem pré-preenchida', () => {
    // Competência 1: nada aprendido, tudo cai no perfil
    const primeiro = sugerirCfop(item1, [], contexto);
    expect(primeiro.origem).toBe('perfil');

    // Operador decide 1403 (substituição tributária)
    const acoes = aprender({ item: item1, emitCnpj: CNPJ, campo: 'cfop', valorFinal: '1403', sugestao: primeiro });
    const nivel1 = acoes.find((a: any) => a.tipo === 'criar' && a.nivel === 1) as any;
    expect(nivel1.valor).toBe('1403');

    // Competência 2: mesma nota, mesmo fornecedor, mesmo cProd
    const aprendida = regra({
      id: 'aprendida', nivel: 1, chave: nivel1.chave, campo: 'cfop', valor: '1403',
      acertos: 1, usos: 1, confianca: 0.75,
    });
    const segundo = sugerirCfop(item1, [aprendida], contexto);
    expect(segundo.valor).toBe('1403');
    expect(segundo.confianca).toBe('alta');
    expect(segundo.origem).toBe('regra:aprendida');
  });
});
