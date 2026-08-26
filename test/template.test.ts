import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNFe } from '../src/nfe/parser';
import { gerarXmlCorrigido, verificarInvariantes } from '../src/nfe/serializer';
import {
  CAMPOS, CAMPOS_ESCRITURACAO, CAMPOS_XML, TODOS_CAMPOS, ehCampoValido, validarValor,
} from '../src/rules/campos';
import {
  aprender, aplicarErro, chaveDoNivel, classificarConfianca, escolherRegra, sugerir,
  type Regra,
} from '../src/rules/engine';
import { analisarCnaes, normalizarCnae, sugerirPeloCnae } from '../src/empresas/cnae';

const XML = readFileSync(new URL('./fixtures/nfe-exemplo.xml', import.meta.url), 'utf8');
const nota = parseNFe(XML);
const item1 = nota.itens[0]!;
const CNPJ = nota.emit.cnpj;
const contexto = { perfil: 'revenda' as const, ufEmitente: 'SC', ufDestinatario: 'SC' };

function regra(p: Partial<Regra> & Pick<Regra, 'id' | 'nivel' | 'chave' | 'campo' | 'valor'>): Regra {
  return { usos: 0, acertos: 0, erros: 0, errosSeguidos: 0, confianca: 0.5, ativa: true, suspeita: false, ...p };
}

describe('registra, não reescreve — a decisão de 24/08', () => {
  it('só CFOP e descrição chegam ao XML', () => {
    expect(CAMPOS_XML.sort()).toEqual(['cfop', 'descricao']);
  });

  it('CST, conta contábil e créditos são registrados, não gravados no XML', () => {
    expect(CAMPOS_ESCRITURACAO.sort()).toEqual(
      ['conta_contabil', 'credito_cofins', 'credito_icms', 'credito_pis', 'cst_entrada'],
    );
    for (const c of CAMPOS_ESCRITURACAO) {
      expect(CAMPOS[c]!.escreveNoXml).toBe(false);
      expect(CAMPOS[c]!.tagXml).toBeUndefined();
    }
  });

  it('preencher CST de entrada não altera o XML nem derruba a invariante do CST', () => {
    // O item 1 tem CST 00 na origem. A escrituração vai usar outro — e o XML não muda.
    const r = gerarXmlCorrigido(XML, [{ nItem: 1, cfop: '1403' }]);
    const depois = parseNFe(r.xml);
    expect(depois.itens[0]!.cstIcms).toBe('00');
    expect(verificarInvariantes(XML, r.xml).filter((i) => !i.ok)).toEqual([]);
  });

  it('todo campo do template declara permissão e rótulo', () => {
    for (const c of TODOS_CAMPOS) {
      expect(CAMPOS[c]!.rotulo.length).toBeGreaterThan(2);
      expect(CAMPOS[c]!.permissao).toBeTruthy();
    }
  });
});

describe('validação dos campos do template', () => {
  it('aceita campo conhecido e recusa inventado', () => {
    expect(ehCampoValido('cst_entrada')).toBe(true);
    expect(ehCampoValido('aliquota_inventada')).toBe(false);
  });

  it('CFOP precisa de 4 dígitos', () => {
    expect(validarValor('cfop', '1102')).toBeNull();
    expect(validarValor('cfop', '110')).toContain('4 dígitos');
  });

  it('CST de entrada aceita 2 ou 3 dígitos (CST e CSOSN)', () => {
    expect(validarValor('cst_entrada', '00')).toBeNull();
    expect(validarValor('cst_entrada', '102')).toBeNull();
    expect(validarValor('cst_entrada', 'X')).toContain('dígitos');
  });

  it('crédito é S ou N', () => {
    expect(validarValor('credito_icms', 'S')).toBeNull();
    expect(validarValor('credito_icms', 'N')).toBeNull();
    expect(validarValor('credito_icms', 'talvez')).toContain('S ou N');
  });

  it('vazio é permitido — significa "não preenchido"', () => {
    expect(validarValor('cst_entrada', '')).toBeNull();
    expect(validarValor('cfop', '')).toBeNull();
  });
});

describe('campos de escrituração no motor de regras', () => {
  it('sem regra, campo de escrituração fica vazio — o sistema não chuta imposto', () => {
    const s = sugerir('cst_entrada', item1, [], contexto);
    expect(s.valor).toBe('');
    expect(s.confianca).toBe('nenhuma');
  });

  it('com regra aprendida, o campo vem preenchido', () => {
    const r = regra({ id: 'c1', nivel: 1, chave: `${CNPJ}|7891`, campo: 'cst_entrada', valor: '060' });
    expect(sugerir('cst_entrada', item1, [r], contexto).valor).toBe('060');
  });

  it('o aprendizado funciona igual para qualquer campo do template', () => {
    const acoes = aprender({
      item: item1, emitCnpj: CNPJ, campo: 'conta_contabil',
      valorFinal: '1.1.03.001', sugestao: null,
    });
    expect(acoes.filter((a: any) => a.tipo === 'criar').every((a: any) => a.campo === 'conta_contabil')).toBe(true);
  });
});

describe('padrão por fornecedor — nível 5', () => {
  it('a chave do nível 5 é o CNPJ do fornecedor', () => {
    expect(chaveDoNivel(item1, CNPJ, 5)).toBe(CNPJ);
  });

  it('"aplicar a todo o fornecedor" aprende só no nível 5', () => {
    const acoes = aprender({
      item: item1, emitCnpj: CNPJ, campo: 'cfop', valorFinal: '1403',
      sugestao: null, apenasNiveis: [5],
    });
    const criadas = acoes.filter((a: any) => a.tipo === 'criar');
    expect(criadas).toHaveLength(1);
    expect((criadas[0] as any).nivel).toBe(5);
    expect((criadas[0] as any).chave).toBe(CNPJ);
  });

  it('o padrão do fornecedor vale para produto que nunca foi visto', () => {
    // item novo do mesmo fornecedor: sem cProd conhecido, sem EAN, NCM diferente
    const itemNovo = { ...item1, cProd: '99999', cEAN: null, NCM: '99999999' };
    const padrao = regra({ id: 'forn', nivel: 5, chave: CNPJ, campo: 'cfop', valor: '1403' });
    const s = sugerir('cfop', itemNovo, [padrao], contexto);
    expect(s.valor).toBe('1403');
    expect(s.porque).toContain('padrão deste fornecedor');
  });

  it('regra de produto ainda ganha do padrão do fornecedor', () => {
    const candidatas = [
      regra({ id: 'forn', nivel: 5, chave: CNPJ, campo: 'cfop', valor: '1403', confianca: 0.99 }),
      regra({ id: 'prod', nivel: 1, chave: `${CNPJ}|7891`, campo: 'cfop', valor: '1102' }),
    ];
    expect(escolherRegra(candidatas, 'cfop')!.id).toBe('prod');
  });
});

describe('regra fixada pela contabilidade', () => {
  it('nasce verde — ali não houve palpite, houve decisão', () => {
    const r = regra({ id: 'f', nivel: 5, chave: CNPJ, campo: 'cfop', valor: '1403', fixada: true });
    expect(classificarConfianca(r)).toBe('alta');
  });

  it('ganha de qualquer outra, mesmo mais específica', () => {
    const candidatas = [
      regra({ id: 'prod', nivel: 1, chave: `${CNPJ}|7891`, campo: 'cfop', valor: '1102', acertos: 9, confianca: 0.95 }),
      regra({ id: 'fixa', nivel: 5, chave: CNPJ, campo: 'cfop', valor: '1403', fixada: true }),
    ];
    expect(escolherRegra(candidatas, 'cfop')!.id).toBe('fixa');
  });

  it('não é rebaixada sozinha por divergência', () => {
    let r = regra({ id: 'f', nivel: 1, chave: 'k', campo: 'cfop', valor: '1403', fixada: true });
    r = aplicarErro(r); r = aplicarErro(r); r = aplicarErro(r); r = aplicarErro(r);
    expect(r.suspeita).toBe(false);
    expect(classificarConfianca(r)).toBe('alta');
  });

  it('regra comum, ao contrário, cai após três erros seguidos', () => {
    let r = regra({ id: 'c', nivel: 1, chave: 'k', campo: 'cfop', valor: '1403' });
    r = aplicarErro(r); r = aplicarErro(r); r = aplicarErro(r);
    expect(r.suspeita).toBe(true);
  });

  it('a sugestão diz que foi a contabilidade que fixou', () => {
    const r = regra({ id: 'f', nivel: 5, chave: CNPJ, campo: 'cfop', valor: '1403', fixada: true });
    expect(sugerir('cfop', item1, [r], contexto).porque).toContain('fixada pela contabilidade');
  });
});

describe('cadastro de empresa pré-populado pelo CNAE', () => {
  it('normaliza CNAE com pontuação', () => {
    expect(normalizarCnae('47.11-3/02')).toBe('4711302');
  });

  it('comércio vira revenda', () => {
    const s = sugerirPeloCnae('4711302'); // hipermercados
    expect(s.perfil).toBe('revenda');
    expect(s.cfopPadraoDentroUF).toBe('1102');
    expect(s.cfopPadraoForaUF).toBe('2102');
  });

  it('indústria vira industrialização', () => {
    expect(sugerirPeloCnae('1091101').perfil).toBe('industrializacao'); // panificação
  });

  it('serviço vira uso e consumo', () => {
    expect(sugerirPeloCnae('6920601').perfil).toBe('uso_consumo'); // contabilidade
  });

  it('CNAE desconhecido cai no mais conservador, com confiança baixa', () => {
    const s = sugerirPeloCnae('x');
    expect(s.perfil).toBe('uso_consumo');
    expect(s.confianca).toBe('baixa');
  });

  it('a confiança nunca passa de média — CNAE indica atividade, não destinação', () => {
    for (const cnae of ['4711302', '1091101', '6920601']) {
      expect(sugerirPeloCnae(cnae).confianca).not.toBe('alta');
    }
  });

  it('empresa mista dispara alerta no cadastro', () => {
    const r = analisarCnaes('1091101', ['4711302']); // indústria + comércio
    expect(r.alerta).not.toBeNull();
    expect(r.alerta).toContain('fornecedor');
  });

  it('CNAEs coerentes não geram alerta', () => {
    expect(analisarCnaes('4711302', ['4712100']).alerta).toBeNull();
  });
});
