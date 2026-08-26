import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNFe } from '../src/nfe/parser';
import {
  detectarAlertas, estiloDaLinha, resumirNota, severidadeMaxima,
  type ContextoAlerta, type HistoricoProduto,
} from '../src/rules/alertas';

const XML = readFileSync(new URL('./fixtures/nfe-exemplo.xml', import.meta.url), 'utf8');
const nota = parseNFe(XML);
const item = nota.itens[0]!; // NCM 18069000, CST 00, CFOP 5102, UN, R$ 8,50

const historicoBase: HistoricoProduto = {
  vezesVisto: 5,
  ncm: '18069000',
  cstOrigem: '00',
  cfopOrigem: '5102',
  unidade: 'UN',
  cEAN: '7891000100103',
  xProdFornecedor: 'CHOC AO LEITE PT 200G',
  precoMedio: 8.5,
  ultimaVezEm: '2026-06-10T00:00:00Z',
};

const ctx = (over: Partial<ContextoAlerta> = {}): ContextoAlerta => ({
  historico: historicoBase,
  cfopEntrada: '1102',
  confianca: 'alta',
  regraSuspeita: false,
  ...over,
});

const codigos = (a: ReturnType<typeof detectarAlertas>) => a.map((x) => x.codigo);

describe('o caso normal não gera ruído', () => {
  it('produto conhecido, tudo igual: nenhum alerta', () => {
    expect(detectarAlertas(item, ctx())).toEqual([]);
  });

  it('e a linha não recebe destaque — linha certa não ganha cor', () => {
    const e = estiloDaLinha('alta', []);
    expect(e.estado).toBe('pronto');
    expect(e.destacar).toBe(false);
  });
});

describe('"não sei" é diferente de "divergiu"', () => {
  it('produto novo é atenção, não crítico — é normal na primeira competência', () => {
    const a = detectarAlertas(item, ctx({ historico: null }));
    expect(codigos(a)).toContain('item_novo');
    expect(severidadeMaxima(a)).toBe('atencao');
  });

  it('produto novo não dispara divergência nenhuma — não há com o que comparar', () => {
    const a = detectarAlertas(item, ctx({ historico: null }));
    for (const c of ['ncm_mudou', 'st_mudou', 'preco_fora_faixa', 'cst_mudou']) {
      expect(codigos(a)).not.toContain(c);
    }
  });

  it('produto novo sem NCM avisa duas vezes', () => {
    const a = detectarAlertas({ ...item, NCM: null }, ctx({ historico: null }));
    expect(codigos(a)).toEqual(['item_novo', 'sem_ncm']);
  });
});

describe('divergências que têm consequência fiscal são críticas', () => {
  it('NCM mudou — o fornecedor reclassificou o produto', () => {
    const a = detectarAlertas({ ...item, NCM: '17049090' }, ctx());
    const alerta = a.find((x) => x.codigo === 'ncm_mudou')!;
    expect(alerta.severidade).toBe('critico');
    expect(alerta.titulo).toContain('18069000');
    expect(alerta.titulo).toContain('17049090');
  });

  it('produto entrou em substituição tributária', () => {
    const a = detectarAlertas({ ...item, cstIcms: '60' }, ctx());
    const alerta = a.find((x) => x.codigo === 'st_mudou')!;
    expect(alerta.severidade).toBe('critico');
    expect(alerta.titulo).toContain('entrou em substituição');
  });

  it('produto saiu de substituição tributária', () => {
    const a = detectarAlertas({ ...item, cstIcms: '00' }, ctx({
      historico: { ...historicoBase, cstOrigem: '60' },
    }));
    expect(a.find((x) => x.codigo === 'st_mudou')!.titulo).toContain('saiu de substituição');
  });

  it('mudança de CST que não envolve ST é só atenção', () => {
    const a = detectarAlertas({ ...item, cstIcms: '20' }, ctx());
    const alerta = a.find((x) => x.codigo === 'cst_mudou')!;
    expect(alerta.severidade).toBe('atencao');
  });

  it('preço mais que dobrado é crítico; variação moderada é atenção', () => {
    const dobrou = detectarAlertas({ ...item, vUnCom: 20 }, ctx());
    expect(dobrou.find((x) => x.codigo === 'preco_fora_faixa')!.severidade).toBe('critico');

    const subiu40 = detectarAlertas({ ...item, vUnCom: 11.9 }, ctx());
    expect(subiu40.find((x) => x.codigo === 'preco_fora_faixa')!.severidade).toBe('atencao');
  });

  it('reajuste dentro da tolerância não alerta', () => {
    expect(codigos(detectarAlertas({ ...item, vUnCom: 9.5 }, ctx()))).not.toContain('preco_fora_faixa');
  });

  it('preço não é comparado quando a unidade mudou — a comparação não valeria nada', () => {
    const a = detectarAlertas({ ...item, uCom: 'CX', vUnCom: 90 }, ctx());
    expect(codigos(a)).toContain('unidade_mudou');
    expect(codigos(a)).not.toContain('preco_fora_faixa');
  });
});

describe('o que bloqueia a exportação', () => {
  it('item sem CFOP de entrada bloqueia', () => {
    const a = detectarAlertas(item, ctx({ cfopEntrada: null }));
    const alerta = a.find((x) => x.codigo === 'cfop_ausente')!;
    expect(alerta.bloqueia).toBe(true);
    expect(alerta.severidade).toBe('critico');
  });

  it('divergência de NCM é crítica mas NÃO bloqueia — quem decide é a contadora', () => {
    const a = detectarAlertas({ ...item, NCM: '17049090' }, ctx());
    expect(a.find((x) => x.codigo === 'ncm_mudou')!.bloqueia).toBe(false);
  });

  it('regra que já errou três vezes é sinalizada', () => {
    const a = detectarAlertas(item, ctx({ regraSuspeita: true }));
    expect(a.find((x) => x.codigo === 'regra_suspeita')!.severidade).toBe('critico');
  });
});

describe('mudança cosmética não vira alarme', () => {
  it('fornecedor mudar a descrição é apenas informativo', () => {
    const a = detectarAlertas({ ...item, xProd: 'CHOCOLATE AO LEITE POTE 200 G' }, ctx());
    const alerta = a.find((x) => x.codigo === 'descricao_fornecedor_mudou')!;
    expect(alerta.severidade).toBe('info');
    expect(severidadeMaxima(a)).toBe('info');
  });

  it('e não tira o "pronto" da linha', () => {
    const a = detectarAlertas({ ...item, xProd: 'OUTRA COISA' }, ctx());
    expect(estiloDaLinha('alta', a).destacar).toBe(false);
  });
});

describe('cor não é a única pista — acessibilidade', () => {
  it('todo estado carrega ícone e rótulo em texto', () => {
    const estados = [
      estiloDaLinha('alta', []),
      estiloDaLinha('media', []),
      estiloDaLinha('nenhuma', detectarAlertas(item, ctx({ historico: null }))),
      estiloDaLinha('alta', detectarAlertas(item, ctx({ cfopEntrada: null }))),
    ];
    for (const e of estados) {
      expect(e.icone.length).toBeGreaterThan(0);
      expect(e.rotulo.length).toBeGreaterThan(2);
    }
  });

  it('os quatro estados são distinguíveis sem cor', () => {
    const rotulos = new Set([
      estiloDaLinha('alta', []).rotulo,
      estiloDaLinha('media', []).rotulo,
      estiloDaLinha('nenhuma', detectarAlertas(item, ctx({ historico: null }))).rotulo,
      estiloDaLinha('alta', detectarAlertas(item, ctx({ cfopEntrada: null }))).rotulo,
    ]);
    expect(rotulos.size).toBe(4);
  });
});

describe('resumo da nota — a frase do topo da tela', () => {
  it('nota limpa diz que está tudo conferido', () => {
    const r = resumirNota([
      { confianca: 'alta', alertas: [] },
      { confianca: 'alta', alertas: [] },
    ]);
    expect(r.chamada).toContain('Tudo conferido');
    expect(r.bloqueiaExportacao).toBe(false);
    expect(r.tranquilos).toBe(2);
  });

  it('com crítico, a chamada fala em exportar', () => {
    const r = resumirNota([
      { confianca: 'alta', alertas: detectarAlertas(item, ctx({ cfopEntrada: null })) },
      { confianca: 'alta', alertas: [] },
    ]);
    expect(r.criticos).toBe(1);
    expect(r.bloqueiaExportacao).toBe(true);
    expect(r.chamada).toContain('antes de exportar');
  });

  it('a chamada mostra quanto já veio pronto — é o número que mede o produto', () => {
    const r = resumirNota([
      { confianca: 'alta', alertas: [] },
      { confianca: 'alta', alertas: [] },
      { confianca: 'alta', alertas: [] },
      { confianca: 'nenhuma', alertas: detectarAlertas(item, ctx({ historico: null })) },
    ]);
    expect(r.chamada).toContain('3 de 4 já prontos');
  });

  it('20 itens conhecidos e 3 novos: só 3 pedem atenção', () => {
    const linhas = [
      ...Array.from({ length: 20 }, () => ({ confianca: 'alta' as const, alertas: [] })),
      ...Array.from({ length: 3 }, () => ({
        confianca: 'nenhuma' as const,
        alertas: detectarAlertas(item, ctx({ historico: null })),
      })),
    ];
    const r = resumirNota(linhas);
    expect(r.atencao).toBe(3);
    expect(r.criticos).toBe(0);
    expect(r.tranquilos).toBe(20);
  });
});
