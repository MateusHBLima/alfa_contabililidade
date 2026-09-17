import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNFe } from '../src/nfe/parser';
import { detectarAlertas, estiloDaLinha, resumirNota, severidadeMaxima, type ContextoAlerta, type HistoricoProduto, marcasDaLinha } from '../src/rules/alertas';

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

describe('o bug do "Pronto" — encontrado rodando o sistema de verdade', () => {
  /* Na segunda nota de um fornecedor, itens que o sistema nunca aprendeu vinham
     preenchidos pelo chute do perfil e marcados como "Pronto" — sem alerta nenhum,
     porque já não eram produto novo. É o pior erro possível numa tela de conferência:
     o rótulo que faz o operador passar batido, exatamente na linha que ele deveria
     olhar. Nenhum teste unitário pegou; só apareceu quando duas notas passaram pelo
     sistema rodando. */

  it('item sem conhecimento nenhum nunca aparece como pronto', () => {
    const e = estiloDaLinha('nenhuma', []);
    expect(e.estado).toBe('conferir');
    expect(e.destacar).toBe(true);
  });

  it('item com regra ainda não provada também pede conferência', () => {
    expect(estiloDaLinha('media', []).estado).toBe('conferir');
  });

  it('só confiança alta ganha o "Pronto"', () => {
    expect(estiloDaLinha('alta', []).estado).toBe('pronto');
  });

  it('o resumo conta como atenção o item preenchido por chute', () => {
    const r = resumirNota([
      { confianca: 'alta', alertas: [] },
      { confianca: 'nenhuma', alertas: [] },   // veio do perfil, sem alerta
      { confianca: 'nenhuma', alertas: [] },
    ]);
    expect(r.atencao).toBe(2);
    expect(r.tranquilos).toBe(1);
    expect(r.chamada).not.toContain('Tudo conferido');
  });

  it('"Tudo conferido" só sai quando tudo é de fato conhecido', () => {
    const r = resumirNota([
      { confianca: 'alta', alertas: [] },
      { confianca: 'alta', alertas: [] },
    ]);
    expect(r.chamada).toContain('Tudo conferido');
    expect(r.tranquilos).toBe(2);
  });
});

describe('linha conferida por gente', () => {
  /* A contadora conferiu a nota inteira e a tela continuava dizendo "Conferir"
     em tudo — como se ela não tivesse feito nada. Quem conferiu manda: a pessoa
     é a autoridade, não a origem do dado. */

  it('depois de conferida, a linha para de pedir atenção', () => {
    const semRevisar = estiloDaLinha('nenhuma', []);
    expect(semRevisar.estado).toBe('conferir');

    const revisada = estiloDaLinha('nenhuma', [], true);
    expect(revisada.estado).toBe('conferido');
    expect(revisada.destacar).toBe(false);
  });

  it('produto novo conferido deixa de ser produto novo na tela', () => {
    const alertas = [
      { codigo: 'item_novo', severidade: 'info', titulo: 'Produto novo',
        detalhe: '', bloqueia: false } as any,
    ];
    expect(estiloDaLinha('nenhuma', alertas).estado).toBe('novo');
    expect(estiloDaLinha('nenhuma', alertas, true).estado).toBe('conferido');
  });

  it('divergência crítica continua gritando mesmo conferida', () => {
    // Crítico não fala do preenchimento: fala de algo que mudou no mundo.
    // Conferir o CFOP não faz o NCM ter voltado ao que era.
    const critico = [
      { codigo: 'ncm_mudou', severidade: 'critico', titulo: 'NCM mudou',
        detalhe: '', bloqueia: false } as any,
    ];
    expect(estiloDaLinha('alta', critico, true).estado).toBe('bloqueado');
  });
});

describe('de onde veio o valor — o pedido da contadora no primeiro uso real', () => {
  // "Se tivesse um jeito de ele ir aparecendo de outra cor o que eu já fiz."
  // Ela não estava pedindo enfeite: sem isto o padrão que ela fixou e o chute do
  // perfil da empresa chegam na tela com a mesma cara, e o produto inteiro — que
  // é aprender com ela — fica invisível para quem usa.

  it('o que ela mandou fixar aparece como padrão dela', () => {
    const e = estiloDaLinha('alta', [], false, { fonte: 'fixada' });
    expect(e.estado).toBe('padrao');
    expect(e.rotulo).toBe('Padrão seu');
  });

  it('o que o sistema aprendeu das correções dela diz quantas vezes já serviu', () => {
    const e = estiloDaLinha('alta', [], false, { fonte: 'aprendida', usos: 3 });
    expect(e.estado).toBe('aprendido');
    expect(e.rotulo).toBe('Aprendido · 3x');
  });

  it('aprendido uma vez só não vira "1x" — fica só "Aprendido"', () => {
    expect(estiloDaLinha('alta', [], false, { fonte: 'aprendida', usos: 1 }).rotulo)
      .toBe('Aprendido');
  });

  it('nenhum dos dois ganha destaque — o prêmio por ensinar é a linha parar de pedir atenção', () => {
    expect(estiloDaLinha('alta', [], false, { fonte: 'fixada' }).destacar).toBe(false);
    expect(estiloDaLinha('alta', [], false, { fonte: 'aprendida', usos: 9 }).destacar).toBe(false);
  });

  it('e os dois são distinguíveis sem cor, como todo estado daqui', () => {
    const rotulos = new Set([
      estiloDaLinha('alta', [], false, { fonte: 'fixada' }).rotulo,
      estiloDaLinha('alta', [], false, { fonte: 'aprendida', usos: 2 }).rotulo,
      estiloDaLinha('alta', [], false, { fonte: 'perfil' }).rotulo,
    ]);
    expect(rotulos.size).toBe(3);
  });

  // ---- o que a procedência NÃO pode fazer

  it('chute do perfil jamais vira "padrão" ou "aprendido" — ninguém ensinou nada ali', () => {
    // O perfil sai do motor com confiança "media", e media nunca chega ao fim da
    // função. Foi assim que o pior bug da tela nasceu: item que o sistema não
    // conhecia aparecendo como Pronto, que é justo o rótulo que faz pular a linha.
    const e = estiloDaLinha('media', [], false, { fonte: 'perfil' });
    expect(e.estado).toBe('conferir');
    expect(e.destacar).toBe(true);
  });

  it('procedência não silencia divergência crítica, mesmo em regra fixada', () => {
    const a = detectarAlertas(item, ctx({ cfopEntrada: null }));
    expect(estiloDaLinha('alta', a, false, { fonte: 'fixada' }).estado).toBe('bloqueado');
  });

  it('procedência não sobrepõe produto novo', () => {
    const a = detectarAlertas(item, ctx({ historico: null }));
    expect(estiloDaLinha('nenhuma', a, false, { fonte: 'fixada' }).estado).toBe('novo');
  });

  it('quem conferiu manda: linha revisada continua "Conferido", não vira "Padrão seu"', () => {
    expect(estiloDaLinha('alta', [], true, { fonte: 'fixada' }).estado).toBe('conferido');
  });

  it('sem procedência informada, o comportamento antigo continua igual', () => {
    expect(estiloDaLinha('alta', []).estado).toBe('pronto');
  });
});

describe('o placar de aprendizado no topo da nota', () => {
  const pronto = (fonte: 'fixada' | 'aprendida' | 'perfil') =>
    ({ confianca: 'alta' as const, alertas: [], procedencia: { fonte } });

  it('conta o que veio do que a contabilidade ensinou', () => {
    const r = resumirNota([pronto('fixada'), pronto('aprendida'), pronto('fixada')]);
    expect(r.ensinados).toBe(3);
    expect(r.aprendizado).toBe('3 de 3 itens vieram do que vocês já ensinaram');
  });

  it('chute do perfil não entra na conta — senão o número mediria o palpite do sistema sobre si mesmo', () => {
    const r = resumirNota([
      pronto('fixada'),
      { confianca: 'media', alertas: [], procedencia: { fonte: 'perfil' } },
    ]);
    expect(r.ensinados).toBe(1);
    expect(r.aprendizado).toBe('1 de 2 itens vieram do que vocês já ensinaram');
  });

  it('o placar não mistura as duas contas — juntar "veio de vocês" com "falta você" não fecha', () => {
    // Um item pode ter vindo do aprendizado E ainda estar pendente de confirmação.
    // A primeira versão somava as duas coisas e dizia, numa nota de 3 itens,
    // "2 vieram do que vocês ensinaram · 3 precisam de você". Número que não fecha
    // derruba a confiança no painel inteiro.
    const r = resumirNota([pronto('aprendida'), pronto('aprendida'), pronto('perfil')]);
    expect(r.aprendizado).not.toContain('precisa');
    expect(r.aprendizado).toBe('2 de 3 itens vieram do que vocês já ensinaram');
  });

  it('nota sem nada ensinado não anuncia "0 de 12" — é a primeira nota, e isso é normal', () => {
    const r = resumirNota([{ confianca: 'media', alertas: [], procedencia: { fonte: 'perfil' } }]);
    expect(r.aprendizado).toBeNull();
  });

  it('tudo ensinado', () => {
    const r = resumirNota([pronto('aprendida'), pronto('aprendida')]);
    expect(r.aprendizado).toBe('2 de 2 itens vieram do que vocês já ensinaram');
  });

  it('a chamada antiga não mudou — quem lê o topo continua lendo a mesma coisa', () => {
    const r = resumirNota([pronto('fixada'), pronto('fixada')]);
    expect(r.chamada).toContain('Tudo conferido');
  });
});

describe('o resumo do topo não pode contradizer as próprias linhas', () => {
  // Visto em produção, numa nota que a contadora já tinha tratado: as sete linhas
  // diziam "Conferido" e a faixa do topo dizia "7 itens para conferir · 0 de 7 já
  // prontos". É a mesma queixa do primeiro uso real — "apareceu como se eu tivesse
  // que tratar ainda" — só que agora vinda do resumo, não do banco. A pessoa
  // termina o trabalho e a tela diz que ela não fez nada.
  const item = (over: any = {}) =>
    ({ confianca: 'media' as const, alertas: [], ...over });

  it('item conferido conta como pronto, não como pendente', () => {
    const r = resumirNota([item({ revisado: true }), item({ revisado: true })]);
    expect(r.atencao).toBe(0);
    expect(r.tranquilos).toBe(2);
    expect(r.chamada).toContain('Tudo conferido');
  });

  it('mas divergência crítica continua contando mesmo conferida', () => {
    // Mesmo critério de estiloDaLinha: crítico fala do mundo, não do preenchimento.
    const critico = detectarAlertas(nota.itens[0]!, ctx({ cfopEntrada: null }));
    const r = resumirNota([item({ revisado: true, alertas: critico })]);
    expect(r.criticos).toBe(1);
    expect(r.chamada).toContain('antes de exportar');
  });

  it('o resumo e a linha usam o mesmo critério — nunca discordam', () => {
    for (const revisado of [true, false]) {
      for (const alertas of [[], detectarAlertas(nota.itens[0]!, ctx({ cfopEntrada: null }))]) {
        const linha = estiloDaLinha('media', alertas, revisado);
        const r = resumirNota([{ confianca: 'media', alertas, revisado }]);
        const linhaPronta = linha.estado === 'conferido' || !linha.destacar;
        const resumoPronto = r.atencao === 0 && r.criticos === 0;
        expect(resumoPronto, `linha=${linha.estado} resumo=${r.chamada}`).toBe(linhaPronta);
      }
    }
  });
});

describe('o que a própria contadora digitou também é trabalho dela', () => {
  it('valor manual ganha marca própria e entra no placar', () => {
    const r = resumirNota([
      { confianca: 'media', alertas: [], procedencia: { fonte: 'manual' }, revisado: true },
      { confianca: 'media', alertas: [], procedencia: { fonte: 'perfil' } },
    ]);
    expect(r.ensinados).toBe(1);
    expect(r.aprendizado).toBe('1 de 2 itens vieram do que vocês já ensinaram');
  });
});

describe('descrição ainda do fornecedor: informa no topo, não em cada linha', () => {
  // A contadora mandava fixar o padrão do fornecedor — a ordem mais forte que o
  // sistema aceita — e a linha continuava "Conferir" na nota seguinte, e na
  // outra, para sempre, porque a confiança exigia CFOP *e* descrição. Agora quem
  // decide é o CFOP, que é a decisão fiscal.
  //
  // E o que falta não vira alerta por linha: medido nas notas reais da ALFA,
  // 38 de 38 itens estavam sem descrição padronizada. Aviso em 100% das linhas
  // não informa, só ensina a pessoa a ignorar aviso.

  it('CFOP resolvido deixa a linha pronta, mesmo sem descrição padronizada', () => {
    const e = estiloDaLinha('alta', [], false, { fonte: 'fixada' });
    expect(e.estado).toBe('padrao');
    expect(e.destacar).toBe(false);
  });

  it('o resumo conta quantos itens ainda estão com a descrição do fornecedor', () => {
    const r = resumirNota([
      { confianca: 'alta', alertas: [], descricaoDoFornecedor: true },
      { confianca: 'alta', alertas: [], descricaoDoFornecedor: true },
      { confianca: 'alta', alertas: [], descricaoDoFornecedor: false },
    ]);
    expect(r.semDescricaoPadrao).toBe(2);
    expect(r.tranquilos).toBe(3);
  });

  it('e isso não tira ninguém da conta de prontos', () => {
    const r = resumirNota([
      { confianca: 'alta', alertas: [], descricaoDoFornecedor: true },
      { confianca: 'alta', alertas: [], descricaoDoFornecedor: true },
    ]);
    expect(r.chamada).toContain('Tudo conferido');
    expect(r.atencao).toBe(0);
  });

  it('nota toda padronizada não tem nada a informar', () => {
    const r = resumirNota([{ confianca: 'alta', alertas: [], descricaoDoFornecedor: false }]);
    expect(r.semDescricaoPadrao).toBe(0);
  });
});


/* Invariante 9c - pedido da contadora em 16/09, em dois audios. */
describe('marcas da linha: o quanto a nota foge do normal', () => {
  const novo = [{ codigo: 'item_novo', severidade: 'atencao', titulo: '', detalhe: '', bloqueia: false }] as any;

  it('5102 é o normal: sem marca', () => {
    expect(marcasDaLinha('5102', [])).toEqual({ cfopForaDoNormal: false, produtoNovo: false });
  });

  it('qualquer outro CFOP de saída é marcado — os que apareceram no lote real dela', () => {
    for (const cfop of ['5949', '5101', '5104', '5405', '5656', '5910', '6102']) {
      expect(marcasDaLinha(cfop, []).cfopForaDoNormal, cfop).toBe(true);
    }
  });

  it('as duas marcas são independentes e podem vir juntas', () => {
    expect(marcasDaLinha('5102', novo)).toEqual({ cfopForaDoNormal: false, produtoNovo: true });
    expect(marcasDaLinha('5405', novo)).toEqual({ cfopForaDoNormal: true, produtoNovo: true });
  });

  it('CFOP vazio não vira marca: ausência não é anormalidade', () => {
    expect(marcasDaLinha('', []).cfopForaDoNormal).toBe(false);
    expect(marcasDaLinha(null, []).cfopForaDoNormal).toBe(false);
  });

  it('marca não muda o estilo da linha: são eixos separados', () => {
    const antes = estiloDaLinha('alta', [], false, { fonte: 'fixada' });
    marcasDaLinha('5949', []);
    expect(estiloDaLinha('alta', [], false, { fonte: 'fixada' })).toEqual(antes);
    expect(antes.estado).toBe('padrao');
  });
});
