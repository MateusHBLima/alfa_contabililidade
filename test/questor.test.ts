import { describe, it, expect } from 'vitest';
import {
  linhasDoPdf, lerTextoQuestor, lerPaginasQuestor, conferirComQuestor, nomeComparavel, ErroQuestor,
  type ItemNosso, type LinhaQuestor,
} from '../src/relatorios/questor';
import { relatorioQuestorSintetico, pdfSintetico, paginasDoPdf } from './pdf-sintetico';

/**
 * Conferência do relatório por produto com o Questor (02/10, pedido da Taís).
 * Tudo sintético: o formato imita o PDF que ela mandou, sem os dados dele.
 */

const cabecalho = [
  '0689 MERCADO PILOTO LTDA -Matriz 02/10/2026 15:15 Pág:0001',
  'CNPJ: 11.222.333/0001-81 Período: 01/07/2026 a 31/07/2026',
  'Totais ICMS por Produto',
  'Produto Quantidade Valor Contabil Base ICMS Valor ICMS Isentas ICMS Outras ICMS',
  '- Entradas',
];

const item = (original: string, valor: number, extra: Partial<ItemNosso> = {}): ItemNosso => ({
  original, padronizado: '', unidade: 'UN', ncm: '', quantidade: 1, valor, nota: '100', fornecedor: 'FORNECEDOR A', ...extra,
});
const q = (descricao: string, valor: number, extra: Partial<LinhaQuestor> = {}): LinhaQuestor => ({
  codigo: '1', ncm: '', descricao, quantidade: 1, valor, ...extra,
});

describe('02/10: conferência com o Questor — leitura do PDF', () => {
  it('junta os pedaços de texto em linhas, colando o que o PDF quebrou no meio da palavra', () => {
    const linhas = linhasDoPdf([[
      { str: '7326 7323.93.00', x: 20, y: 700, largura: 60 },
      { str: 'TOMA', x: 82, y: 700.4, largura: 20 },
      { str: 'TE', x: 102, y: 700, largura: 10 },
      { str: ' ', x: 112, y: 700, largura: 30 },
      { str: 'CEREJA', x: 145, y: 700, largura: 30 },
      { str: '5,00', x: 290, y: 700, largura: 15 },
      { str: 'Total', x: 20, y: 600, largura: 20 },
    ]]);
    expect(linhas).toEqual(['7326 7323.93.00 TOMATE CEREJA 5,00', 'Total']);
  });

  it('lê cabeçalho, produtos e confere a soma com o total do próprio relatório', () => {
    const r = lerTextoQuestor([
      ...cabecalho,
      '501 3924.10.00 88001 - COPOPLASTICO 200 5,00 120,50 100,00 0,00 0,00 0,00',
      'P0099.1 0201.30.00 CARNE MOIDA (Pecas:3) 8,50 1.210,40 100,00 12,00 0,00 0,00',
      'Total de Entradas do Período de 01/07/2026 a 31/07/2026 13,50 1.330,90 200,00 12,00 0,00 0,00',
    ]);
    expect(r).toMatchObject({ cnpj: '11222333000181', de: '2026-07-01', ate: '2026-07-31', total: 1330.9, empresa: 'MERCADO PILOTO LTDA -Matriz' });
    expect(r.linhas).toEqual([
      { codigo: '501', ncm: '39241000', descricao: '88001 - COPOPLASTICO 200', quantidade: 5, valor: 120.5 },
      { codigo: 'P0099.1', ncm: '02013000', descricao: 'CARNE MOIDA (Pecas:3)', quantidade: 8.5, valor: 1210.4 },
    ]);
  });

  it('recusa quando a soma não fecha, quando falta o total e quando não é o relatório certo', () => {
    const corpo = ['1 1806.90.00 CHOC 1,00 85,00 0,00 0,00 0,00 0,00'];
    expect(() => lerTextoQuestor([...cabecalho, ...corpo, 'Total de Entradas do Período 1,00 99,00 0,00 0,00 0,00 0,00']))
      .toThrow(/somando 85,00, mas o total do relatório é 99,00/);
    expect(() => lerTextoQuestor([...cabecalho, ...corpo])).toThrow(/Total de Entradas/);
    expect(() => lerTextoQuestor(['Livro de Entradas', ...corpo])).toThrow(/Totais ICMS por Produto/);
  });

  it('lê um PDF de verdade (sintético, de duas páginas, pelo mesmo pdf.js do navegador) e recusa PDF sem texto', async () => {
    const pdf = relatorioQuestorSintetico({
      empresa: 'MERCADO PILOTO LTDA', cnpj: '11.222.333/0001-81', de: '01/07/2026', ate: '31/07/2026', porPagina: 2,
      produtos: [
        ['1', '1806.90.00', 'CHOC AO LEITE PT 200G', '10,00', '85,00'],
        ['2', '2202.10.00', 'REFRIG COLA 2L', '12,00', '140,00'],
        ['3', '3402.20.00', 'DET LIQ NEUTRO 500ML', '24,00', '1.064,00'],
      ],
      total: '1.289,00',
    });
    const r = lerPaginasQuestor(await paginasDoPdf(pdf));
    expect(r).toMatchObject({ cnpj: '11222333000181', de: '2026-07-01', ate: '2026-07-31', total: 1289 });
    expect(r.linhas.map((l: LinhaQuestor) => [l.codigo, l.ncm, nomeComparavel(l.descricao), l.valor])).toEqual([
      ['1', '18069000', 'CHOCAOLEITEPT200G', 85],
      ['2', '22021000', 'REFRIGCOLA2L', 140],
      ['3', '34022000', 'DETLIQNEUTRO500ML', 1064],
    ]);
    expect(lerPaginasQuestor.bind(null, await paginasDoPdf(pdfSintetico([[]])))).toThrow(/não tem texto/);
  });
});

describe('02/10: conferência com o Questor — comparação', () => {
  it('casa pelo nome sem ligar para espaço, acento e o corte do Questor; o que bate não vira pendência', () => {
    const r = conferirComQuestor(
      [q('88001 - COPOPLASTICO 200', 120.5), q('PAO FRANCES KG', 15.3), q('CAFÉ MOIDO 500G', 31.9)],
      [
        item('88001 - COPO PLASTICO 200ML TRANSPARENTE', 100), item('88001 - COPO PLASTICO 200ML TRANSPARENTE', 20.5),
        item('PÃO FRANCÊS KG', 15.3), item('CAFE MOIDO 500G', 31.9),
      ],
    );
    expect(r.totais).toMatchObject({ ok: 3, diferencas: 0, soQuestor: 0, soAlfa: 0, diferenca: 0, parecidos: 0 });
    expect(r.grupos.find((g) => g.questor[0]!.descricao.includes('COPO'))!.nossos).toEqual([
      { descricao: '88001 - COPO PLASTICO 200ML TRANSPARENTE', unidade: 'UN', originais: ['88001 - COPO PLASTICO 200ML TRANSPARENTE'], quantidade: 2, valor: 120.5, itens: 2 },
    ]);
  });

  it('usa o nome padronizado aqui e soma o que no nosso relatório é uma linha só', () => {
    const r = conferirComQuestor(
      [q('LEITE UHT INTEGRAL 1L', 150), q('LEITE UHT INTEG MARCA X 1L', 50)],
      [
        item('LEITE UHT INTEG MARCA X 1L', 50, { padronizado: 'LEITE INTEGRAL' }),
        item('LEITE UHT INTEGRAL 1L', 150, { padronizado: 'LEITE INTEGRAL' }),
      ],
    );
    // Os dois do Questor e as duas descrições daqui são o mesmo produto na nossa tela.
    expect(r.grupos).toHaveLength(1);
    expect(r.grupos[0]).toMatchObject({ situacao: 'ok', valorQuestor: 200, valorNosso: 200 });
    expect(r.grupos[0]!.nossos[0]!.descricao).toBe('LEITE INTEGRAL');
  });

  it('aponta valor diferente, só de um lado, e a pista de item lançado no produto errado', () => {
    const r = conferirComQuestor(
      [q('ALFACE AMERICANA', 520, { ncm: '07051900' }), q('LIMÃO SICILIANO', 80), q('CENOURA KG', 1000), q('ARROZ 5KG', 10)],
      [
        item('ALFACE AMERICANA', 400, { ncm: '07051900' }),
        item('LIMAO SICILIANO KG', 90), item('LIMAO SICILIANO KG', 110),
        item('CENOURA KG', 650),
        item('COSTELA SUINA', 330, { nota: '9001', fornecedor: 'FORNECEDOR B' }),
        item('SALSINHA UN', 20),
        item('ARROZ 5KG', 10),
      ],
    );
    expect(r.totais).toMatchObject({ ok: 1, diferencas: 3, soQuestor: 0, soAlfa: 2, questor: 1610, nosso: 1610, diferenca: 0 });
    const por = (s: string) => r.grupos.filter((g) => g.situacao === s).map((g) => [g.questor[0]?.descricao ?? g.nossos[0]!.descricao, g.diferenca]);
    expect(por('diferenca')).toEqual([['CENOURA KG', 350], ['ALFACE AMERICANA', 120], ['LIMÃO SICILIANO', -120]]);
    expect(por('so_alfa')).toEqual([['COSTELA SUINA', -330], ['SALSINHA UN', -20]]);
    expect(r.pistas).toEqual([
      'ALFACE AMERICANA está R$ 120,00 a mais no Questor e LIMAO SICILIANO KG R$ 120,00 a menos: provavelmente um item de LIMAO SICILIANO KG foi lançado no Questor como ALFACE AMERICANA.',
      'A diferença de CENOURA KG (R$ 350,00 a mais no Questor) é o valor de COSTELA SUINA (R$ 330,00) + SALSINHA UN (R$ 20,00), que não aparece no Questor: provavelmente foi lançado lá como CENOURA KG.',
    ]);
  });

  it('quando a diferença é exatamente um item, diz qual nota', () => {
    const r = conferirComQuestor(
      [q('QUEIJO PRATO', 100)],
      [item('QUEIJO PRATO', 100), item('QUEIJO PRATO', 42.1, { nota: '4711', fornecedor: 'LATICINIO' })],
    );
    expect(r.pistas).toEqual([
      'QUEIJO PRATO está R$ 42,10 a menos no Questor — é exatamente um item (aqui é o item de R$ 42,10 da nota 4711, LATICINIO). Veja se ele entrou no Questor.',
    ]);
  });

  it('nome só parecido casa, com aviso; nome sem nada a ver fica dos dois lados', () => {
    const r = conferirComQuestor(
      [q('DETERGENTE NEUTRO LIQ 500M', 55, { ncm: '34025000' }), q('VASSOURA 30CM', 19.9)],
      [item('DETERGENTE NEUTRO LIQUIDO 500ML', 55, { ncm: '34025000' }), item('RODO 40CM', 19.9)],
    );
    const det = r.grupos.find((g) => g.questor[0]?.descricao.startsWith('DETERGENTE'))!;
    expect(det).toMatchObject({ situacao: 'ok', parecido: true });
    expect(r.totais).toMatchObject({ ok: 1, soQuestor: 1, soAlfa: 1, parecidos: 1 });
  });

  it('é rápido com um mês grande', () => {
    const qs: LinhaQuestor[] = [];
    const its: ItemNosso[] = [];
    for (let i = 0; i < 1500; i++) {
      qs.push(q(`PRODUTO NUMERO ${i} DO FORNECEDOR`, 10 + i));
      for (let k = 0; k < 4; k++) its.push(item(`PRODUTO NUMERO ${i} DO FORNECEDOR`, (10 + i) / 4));
    }
    const t0 = Date.now();
    const r = conferirComQuestor(qs, its);
    expect(r.totais.ok).toBe(1500);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a leitura não aceita erro de leitura silencioso: se faltar uma linha, recusa', () => {
    expect(() => lerTextoQuestor([...cabecalho, 'Total de Entradas 1,00 85,00 0,00 0,00 0,00 0,00'])).toThrow(ErroQuestor);
  });
});
