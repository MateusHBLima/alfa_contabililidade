import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNFe } from '../src/nfe/parser';
import { gerarXmlCorrigido, verificarInvariantes } from '../src/nfe/serializer';
import { ErroParserNFe } from '../src/nfe/tipos';

const XML = readFileSync(new URL('./fixtures/nfe-exemplo.xml', import.meta.url), 'utf8');

describe('parser de NF-e', () => {
  it('lê a chave, o emitente e os itens', () => {
    const nota = parseNFe(XML);
    expect(nota.chave).toBe('42260783646984003044550010005047671000722978');
    expect(nota.chave).toHaveLength(44);
    expect(nota.emit.cnpj).toBe('83646984003044');
    expect(nota.emit.nome).toBe('A. ANGELONI & CIA LTDA');
    expect(nota.emit.uf).toBe('SC');
    expect(nota.dest.uf).toBe('SC');
    expect(nota.numero).toBe('504767');
    expect(nota.protocolo).toBe('142260000123456');
    expect(nota.itens).toHaveLength(3);
  });

  it('deriva a competência da data de emissão', () => {
    expect(parseNFe(XML).competencia).toBe('2026-07');
  });

  it('preserva zeros à esquerda em códigos fiscais', () => {
    // 00 virando 0 é o bug clássico de parser que converte tipo sozinho
    const nota = parseNFe(XML);
    expect(nota.itens[0]!.cstIcms).toBe('00');
    expect(nota.itens[0]!.CFOP).toBe('5102');
  });

  it('lê CST de ICMS00 e de ICMS60, que são tags diferentes', () => {
    const nota = parseNFe(XML);
    expect(nota.itens[0]!.cstIcms).toBe('00');
    expect(nota.itens[1]!.cstIcms).toBe('60');
  });

  it('trata "SEM GTIN" como ausência de código de barras', () => {
    const nota = parseNFe(XML);
    expect(nota.itens[1]!.cEAN).toBeNull();
    expect(nota.itens[0]!.cEAN).toBe('7891000100103');
  });

  it('detecta o bloco IBS/CBS por item', () => {
    const nota = parseNFe(XML);
    expect(nota.itens[0]!.temIbsCbs).toBe(true);
    expect(nota.itens[2]!.temIbsCbs).toBe(false);
  });

  it('recusa documento que não é NF-e modelo 55', () => {
    const cte = XML.replace('<mod>55</mod>', '<mod>57</mod>');
    expect(() => parseNFe(cte)).toThrow(ErroParserNFe);
  });

  it('recusa XML sem chave de acesso válida', () => {
    const ruim = XML.replace(/Id="NFe\d+"/, 'Id="NFe123"');
    expect(() => parseNFe(ruim)).toThrow(/Chave de acesso inválida|Chave de acesso invalida/);
  });
});

describe('geração do XML corrigido', () => {
  it('troca CFOP e descrição só dos itens indicados', () => {
    const r = gerarXmlCorrigido(XML, [
      { nItem: 1, cfop: '1102', xProd: 'CHOCOLATE AO LEITE POTE 200G' },
      { nItem: 3, cfop: '1556' },
    ]);
    const nota = parseNFe(r.xml);

    expect(nota.itens[0]!.CFOP).toBe('1102');
    expect(nota.itens[0]!.xProd).toBe('CHOCOLATE AO LEITE POTE 200G');
    expect(nota.itens[2]!.CFOP).toBe('1556');

    // item 2 não foi tocado
    expect(nota.itens[1]!.CFOP).toBe('5405');
    expect(nota.itens[1]!.xProd).toBe('REFRIG COLA 2L');

    expect(r.itensAlterados).toBe(2);
    expect(r.camposAlterados).toBe(3);
  });

  it('altera somente as linhas que precisava alterar', () => {
    const r = gerarXmlCorrigido(XML, [{ nItem: 1, cfop: '1102' }]);
    const linhasAntes = XML.split('\n');
    const linhasDepois = r.xml.split('\n');
    expect(linhasDepois).toHaveLength(linhasAntes.length);
    const diferentes = linhasAntes.filter((l, i) => l !== linhasDepois[i]);
    expect(diferentes).toHaveLength(1);
  });

  it('escapa caracteres especiais na descrição', () => {
    const r = gerarXmlCorrigido(XML, [{ nItem: 1, xProd: 'CAFE & CIA <PREMIUM> 500G' }]);
    expect(r.xml).toContain('CAFE &amp; CIA &lt;PREMIUM&gt; 500G');
    expect(parseNFe(r.xml).itens[0]!.xProd).toBe('CAFE & CIA <PREMIUM> 500G');
  });

  it('recusa CFOP fora do formato de 4 dígitos', () => {
    expect(() => gerarXmlCorrigido(XML, [{ nItem: 1, cfop: '11020' }])).toThrow(ErroParserNFe);
    expect(() => gerarXmlCorrigido(XML, [{ nItem: 1, cfop: 'abcd' }])).toThrow(ErroParserNFe);
  });

  it('não altera nada quando não há correção', () => {
    const r = gerarXmlCorrigido(XML, []);
    expect(r.xml).toBe(XML);
    expect(r.itensAlterados).toBe(0);
  });
});

describe('invariantes — a nota não pode ser corrompida', () => {
  it('todas as invariantes passam numa correção normal', () => {
    const r = gerarXmlCorrigido(XML, [
      { nItem: 1, cfop: '1102', xProd: 'CHOCOLATE AO LEITE POTE 200G' },
      { nItem: 2, cfop: '1403' },
      { nItem: 3, cfop: '1556', xProd: 'DETERGENTE LIQUIDO NEUTRO 500ML' },
    ]);
    const inv = verificarInvariantes(XML, r.xml);
    const falhas = inv.filter((i) => !i.ok);
    expect(falhas).toEqual([]);
    expect(inv.length).toBeGreaterThanOrEqual(12);
  });

  it('detecta se o valor total for adulterado', () => {
    const adulterado = XML.replace('<vNF>289.00</vNF>', '<vNF>250.00</vNF>');
    const inv = verificarInvariantes(XML, adulterado);
    expect(inv.find((i) => i.nome.includes('vNF'))!.ok).toBe(false);
  });

  it('detecta se o CST for adulterado', () => {
    const adulterado = XML.replace('<CST>00</CST><vICMS>15.30</vICMS>', '<CST>40</CST><vICMS>15.30</vICMS>');
    const inv = verificarInvariantes(XML, adulterado);
    expect(inv.find((i) => i.nome.includes('CST'))!.ok).toBe(false);
  });

  it('detecta se o bloco IBS/CBS sumir', () => {
    const adulterado = XML.replace('<IBSCBS><CST>000</CST></IBSCBS>', '');
    const inv = verificarInvariantes(XML, adulterado);
    expect(inv.find((i) => i.nome.includes('IBS/CBS'))!.ok).toBe(false);
  });

  it('detecta se um item for removido', () => {
    const adulterado = XML.replace(/<det nItem="3">[\s\S]*?<\/det>/, '');
    const inv = verificarInvariantes(XML, adulterado);
    expect(inv.find((i) => i.nome.includes('quantidade de itens'))!.ok).toBe(false);
  });
});
