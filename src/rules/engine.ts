import type { ItemNFe } from '../nfe/tipos';
import { CAMPOS, type Campo } from './campos';

/**
 * Motor de regras.
 *
 * Sem tabela do Questor, o sistema nao tem de onde copiar cadastro: ele aprende do
 * operador. Este arquivo e o coracao do produto.
 *
 * A ideia, na frase do cliente: "a responsavel deixa tudo certinho ali para a empresa X;
 * na proxima vez que vier a mesma nota do fornecedor X, ja mantem aquele padrao."
 *
 * Como isso vira codigo: a mesma decisao e guardada em varios niveis de chave, do mais
 * especifico ao mais generico. Na hora de sugerir, usa-se o nivel mais forte que casar.
 */

export type Nivel = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Confianca = 'alta' | 'media' | 'nenhuma';
export type PerfilEmpresa = 'revenda' | 'industrializacao' | 'uso_consumo';

export type Regra = {
  id: string;
  nivel: Nivel;
  chave: string;
  campo: Campo;
  valor: string;
  usos: number;
  acertos: number;
  erros: number;
  errosSeguidos: number;
  confianca: number;
  ativa: boolean;
  suspeita: boolean;
  /** true = a contadora fixou este valor a mao; nao e rebaixado por divergencia */
  fixada?: boolean;
};

export type Sugestao = {
  valor: string;
  campo: Campo;
  /** manual | regra:<id> | saida (palpite pelo CFOP que veio, 22/10) | perfil | importacao */
  origem: string;
  regraId: string | null;
  nivel: Nivel | null;
  confianca: Confianca;
  /** texto curto para a tela: por que este valor foi sugerido */
  porque: string;
};

/**
 * `implicito` = o nivel aprende sozinho quando o operador corrige um item.
 *
 * O nivel 5 (padrao do fornecedor) e deliberadamente NAO implicito. Corrigir UM
 * chocolate para substituicao tributaria nao pode transformar tudo o que vem daquele
 * atacadista em ST - seria uma inferencia larga demais a partir de uma evidencia so.
 * Ele so e gravado quando alguem clica "aplicar a todo o fornecedor".
 *
 * O nivel 7 nao se aprende: e derivado do perfil da empresa.
 */
export const NIVEIS: { nivel: Nivel; rotulo: string; aprende: boolean; implicito: boolean }[] = [
  { nivel: 1, rotulo: 'mesmo fornecedor, mesmo código de produto', aprende: true, implicito: true },
  { nivel: 2, rotulo: 'mesmo fornecedor, mesmo código de barras', aprende: true, implicito: true },
  { nivel: 3, rotulo: 'mesmo código de barras, outro fornecedor', aprende: true, implicito: true },
  { nivel: 4, rotulo: 'mesmo fornecedor, mesmo NCM', aprende: true, implicito: true },
  { nivel: 5, rotulo: 'padrão deste fornecedor para esta empresa', aprende: true, implicito: false },
  { nivel: 6, rotulo: 'mesmo NCM, qualquer fornecedor', aprende: true, implicito: true },
  { nivel: 7, rotulo: 'perfil fiscal da empresa', aprende: false, implicito: false },
];

export function rotuloNivel(n: Nivel): string {
  return NIVEIS.find((x) => x.nivel === n)?.rotulo ?? '';
}

/**
 * CFOP de entrada por perfil, quando nada mais casou.
 * Deliberadamente curto: e chute de ultimo recurso, sempre em amarelo, e a
 * responsabilidade pela regra fiscal e da contabilidade (cláusula 3.1 "d").
 */
const CFOP_POR_PERFIL: Record<PerfilEmpresa, { dentroUF: string; foraUF: string }> = {
  revenda: { dentroUF: '1102', foraUF: '2102' },
  industrializacao: { dentroUF: '1101', foraUF: '2101' },
  uso_consumo: { dentroUF: '1556', foraUF: '2556' },
};

/**
 * CFOP de entrada pelo CFOP que veio na nota (22/10; pedido da Taís na reunião de 15/10:
 * "sempre que vir 5910 é 1910, sempre que vir 5949 é 1949, não muda. Como é o mesmo
 * produto, é fácil de eu tratar errado: é margarina, é comida, boto 1102, mas naquela
 * nota a margarina era 1910").
 *
 * É palpite, não regra: fica no lugar do chute do perfil (que daria 1102) e sai em
 * amarelo para ela confirmar. O que ela já ensinou para aquele produto NAQUELA operação
 * (a chave de CFOP inclui o CFOP de saída) continua valendo por cima - é assim que o
 * detergente da OESA em 5949 da Italiana segue em 1556.
 */
export const CFOP_PELA_SAIDA: Readonly<Record<string, { cfop: string; nome: string }>> = {
  '5910': { cfop: '1910', nome: 'bonificação, doação ou brinde' },
  '6910': { cfop: '2910', nome: 'bonificação, doação ou brinde' },
  '5949': { cfop: '1949', nome: 'outra saída não especificada' },
  '6949': { cfop: '2949', nome: 'outra saída não especificada' },
};

// ------------------------------------------------------------------ chaves

/** Chave canonica de cada nivel. Null quando o item nao tem o dado necessario. */
/**
 * A chave de cada nivel.
 *
 * PARA O CFOP, A CHAVE INCLUI O CFOP DE SAIDA DO FORNECEDOR (`#5102`, `#5949`).
 * O CFOP de entrada nao depende so do produto: depende do par (produto, operacao).
 * Caso real, The Sailor, 22/09: o mesmo pudim da OESA vem em 5102 (compra, vira 1101)
 * e numa nota de ajuste em 5949 (vira 1949). Com a chave so por produto, lancar a
 * nota de ajuste reescrevia a regra, e o proximo pudim em 5102 chegava sugerido
 * 1949 - e no nivel 6 (NCM, qualquer fornecedor) ate produto de OUTRO fornecedor.
 * Nao da para trocar por "5949 vira sempre 1949": na Italiana o detergente da OESA
 * em 5949 vira 1556. Quem sabe e a contadora, uma vez por par.
 *
 * Descricao e os demais campos seguem so pelo produto: o pudim tem o mesmo nome
 * nas duas notas.
 */
export function chaveDoNivel(item: ItemNFe, emitCnpj: string, nivel: Nivel, campo?: Campo): string | null {
  const cnpj = emitCnpj.replace(/\D/g, '');
  let base: string | null;
  switch (nivel) {
    case 1: base = item.cProd ? `${cnpj}|${item.cProd.trim().toUpperCase()}` : null; break;
    case 2: base = item.cEAN ? `${cnpj}|${item.cEAN}` : null; break;
    case 3: base = item.cEAN ?? null; break;
    case 4: base = item.NCM ? `${cnpj}|${item.NCM}` : null; break;
    case 5: base = cnpj || null; break;
    case 6: base = item.NCM ?? null; break;
    case 7: return 'perfil';
  }
  if (base === null) return null;
  return campo === 'cfop' ? `${base}#${String(item.CFOP ?? '').trim() || '?'}` : base;
}

/**
 * O caminho inverso de chaveDoNivel (13/10, "de onde veio isto"): o que a chave de
 * uma regra exige do item. `saida` so existe na chave de CFOP ('' = CFOP de saida
 * vazio no XML). Nivel 7 (perfil) nao vem de item nenhum: devolve null.
 */
export type PartesDaChave = { cnpj?: string; cprod?: string; ean?: string; ncm?: string; saida?: string };
export function partesDaChave(nivel: number, chave: string): PartesDaChave | null {
  const k = chave.lastIndexOf('#');
  const base = k >= 0 ? chave.slice(0, k) : chave;
  const p: PartesDaChave = {};
  if (k >= 0) { const s = chave.slice(k + 1); p.saida = s === '?' ? '' : s; }
  const [a, b] = [base.slice(0, base.indexOf('|')), base.slice(base.indexOf('|') + 1)];
  switch (nivel) {
    case 1: if (!base.includes('|')) return null; return { ...p, cnpj: a, cprod: b };
    case 2: if (!base.includes('|')) return null; return { ...p, cnpj: a, ean: b };
    case 3: return { ...p, ean: base };
    case 4: if (!base.includes('|')) return null; return { ...p, cnpj: a, ncm: b };
    case 5: return { ...p, cnpj: base };
    case 6: return { ...p, ncm: base };
    default: return null;
  }
}

/** As chaves de um item PARA UM CAMPO. Sem campo: as chaves dos campos que nao sao CFOP. */
export function chavesDoItem(item: ItemNFe, emitCnpj: string, campo?: Campo): { nivel: Nivel; chave: string }[] {
  const out: { nivel: Nivel; chave: string }[] = [];
  for (const { nivel } of NIVEIS) {
    const chave = chaveDoNivel(item, emitCnpj, nivel, campo);
    if (chave !== null) out.push({ nivel, chave });
  }
  return out;
}

/** Tudo o que precisa ser buscado no banco para sugerir TODOS os campos de um item. */
export function chavesParaBuscar(item: ItemNFe, emitCnpj: string): { nivel: Nivel; chave: string }[] {
  return [...chavesDoItem(item, emitCnpj), ...chavesDoItem(item, emitCnpj, 'cfop')];
}

/**
 * Das regras carregadas, so as que valem para ESTE item, conferindo a chave do
 * proprio campo da regra. Uma regra de CFOP aprendida em 5949 nunca responde por
 * um item que veio em 5102.
 */
export function regrasDoItem(item: ItemNFe, emitCnpj: string, candidatas: Regra[]): Regra[] {
  // O nome nunca vem de outro produto (15/10): regra de descrição por NCM ou do
  // fornecedor inteiro, gravada antes da correção, não responde por item nenhum.
  candidatas = candidatas.filter((r) => nivelValeParaCampo(r.campo, r.nivel));
  const cache = new Map<string, Set<string>>();
  const chavesDe = (campo: Campo) => {
    const k = campo === 'cfop' ? 'cfop' : 'outros';
    let s = cache.get(k);
    if (!s) {
      s = new Set(chavesDoItem(item, emitCnpj, campo === 'cfop' ? 'cfop' : undefined).map((c) => `${c.nivel} ${c.chave}`));
      cache.set(k, s);
    }
    return s;
  };
  return candidatas.filter((r) => chavesDe(r.campo).has(`${r.nivel} ${r.chave}`));
}

/**
 * Niveis gravados quando o operador corrige um item, sem pedir nada de especial.
 * Exclui o nivel 5 - ver o comentario em NIVEIS.
 */
export function chavesAprendiveis(item: ItemNFe, emitCnpj: string, campo?: Campo) {
  return chavesDoItem(item, emitCnpj, campo)
    .filter(({ nivel }) => NIVEIS[nivel - 1]?.implicito && nivelValeParaCampo(campo, nivel));
}

/** Niveis que podem ser gravados quando alguem pede explicitamente. */
export function chavesAprendiveisExplicitas(item: ItemNFe, emitCnpj: string, campo?: Campo) {
  return chavesDoItem(item, emitCnpj, campo)
    .filter(({ nivel }) => NIVEIS[nivel - 1]?.aprende && nivelValeParaCampo(campo, nivel));
}

/**
 * O NOME do produto só se aprende e só se sugere pelo próprio produto: código do
 * fornecedor (1), código de barras no fornecedor (2) ou o mesmo código de barras em
 * outro fornecedor (3). Nunca pelo NCM (4 e 6) nem pelo fornecedor inteiro (5).
 *
 * Caso real, L'Italiana Garden Cucina, 15/10: a Taís deu o nome "FANTA LAR LATA" à
 * Fanta em 28/09 e, pelo NCM 22021000, a Coca Zero, as Sprites e até o Guaraná de
 * outro fornecedor passaram a chegar com o nome da Fanta - no relatório por produto
 * e no XML corrigido. NCM é classificação tributária: serve de palpite para o CFOP
 * (com o selo "de outro produto"), não para dizer que produto é.
 */
export const NIVEIS_DO_NOME: readonly Nivel[] = [1, 2, 3];
export function nivelValeParaCampo(campo: Campo | undefined, nivel: number): boolean {
  return campo !== 'descricao' || (NIVEIS_DO_NOME as readonly number[]).includes(nivel);
}

// ------------------------------------------------------------------ confianca

/**
 * Verde so e concedido quando a regra e especifica E ja provou acertar.
 * Uma regra nivel 1 recem-criada comeca em amarelo de proposito: ela foi vista
 * uma vez so, e "vi uma vez" nao e "eu sei".
 *
 * Regra fixada pela contadora e verde na hora - ali nao houve palpite, houve decisao.
 */
export function classificarConfianca(regra: Regra): Confianca {
  if (!regra.ativa || regra.suspeita) return 'nenhuma';
  if (regra.fixada) return 'alta';
  if (regra.nivel <= 2 && regra.acertos >= 1 && regra.confianca >= 0.7) return 'alta';
  return 'media';
}

/** Acertos sobre tentativas, ancorado em 0.5 quando ha pouca amostra. */
export function recalcularConfianca(regra: Pick<Regra, 'acertos' | 'erros'>): number {
  const tentativas = regra.acertos + regra.erros;
  if (tentativas === 0) return 0.5;
  const prior = 2;
  return (regra.acertos + prior * 0.5) / (tentativas + prior);
}

// ------------------------------------------------------------------ sugestao

const LIMITE_ERROS_SEGUIDOS = 3;

export function escolherRegra(candidatas: Regra[], campo: Campo): Regra | null {
  const validas = candidatas.filter((r) => r.campo === campo && r.ativa && !r.suspeita);
  if (validas.length === 0) return null;
  // regra fixada ganha de tudo; depois nivel menor (mais especifico); depois confianca.
  validas.sort(
    (a, b) =>
      Number(b.fixada ?? false) - Number(a.fixada ?? false) ||
      a.nivel - b.nivel ||
      b.confianca - a.confianca ||
      b.usos - a.usos,
  );
  return validas[0] ?? null;
}

export type ContextoNota = {
  perfil: PerfilEmpresa;
  ufEmitente: string | null;
  ufDestinatario: string | null;
};

function sugestaoDeRegra(regra: Regra): Sugestao {
  const marca = regra.fixada ? 'fixada pela contabilidade' : `usada ${regra.usos}x`;
  const correcoes = regra.erros > 0 ? `, ${regra.erros} correção(ões)` : '';
  return {
    valor: regra.valor,
    campo: regra.campo,
    origem: `regra:${regra.id}`,
    regraId: regra.id,
    nivel: regra.nivel,
    confianca: classificarConfianca(regra),
    porque: `${rotuloNivel(regra.nivel)} · ${marca}${correcoes}`,
  };
}

/**
 * Sugestao para qualquer campo do template.
 * Os fallbacks (quando nenhuma regra casa) sao especificos por campo.
 */
export function sugerir(
  campo: Campo,
  item: ItemNFe,
  candidatas: Regra[],
  contexto: ContextoNota,
): Sugestao {
  const regra = escolherRegra(candidatas, campo);
  if (regra) return sugestaoDeRegra(regra);

  if (campo === 'cfop') {
    const saida = String(item.CFOP ?? '').trim();
    const pelaSaida = CFOP_PELA_SAIDA[saida];
    if (pelaSaida) {
      return {
        valor: pelaSaida.cfop,
        campo,
        origem: 'saida',
        regraId: null,
        nivel: 7,
        confianca: 'media',
        porque: `veio ${saida} (${pelaSaida.nome}) · entra ${pelaSaida.cfop} · confirme`,
      };
    }
    const mesmaUF =
      contexto.ufEmitente !== null &&
      contexto.ufDestinatario !== null &&
      contexto.ufEmitente === contexto.ufDestinatario;
    const mapa = CFOP_POR_PERFIL[contexto.perfil];
    return {
      valor: mesmaUF ? mapa.dentroUF : mapa.foraUF,
      campo,
      origem: 'perfil',
      regraId: null,
      nivel: 7,
      confianca: 'media',
      porque: `perfil "${contexto.perfil}" · operação ${mesmaUF ? 'dentro do estado' : 'interestadual'} · confirme`,
    };
  }

  if (campo === 'descricao') {
    return {
      valor: item.xProd,
      campo,
      origem: 'importacao',
      regraId: null,
      nivel: null,
      confianca: 'nenhuma',
      porque: 'descrição do fornecedor, sem regra aprendida',
    };
  }

  // Campos de escrituracao nao tem palpite: ou a contabilidade ja ensinou, ou fica vazio.
  return {
    valor: '',
    campo,
    origem: 'importacao',
    regraId: null,
    nivel: null,
    confianca: 'nenhuma',
    porque: `${CAMPOS[campo]?.rotulo ?? campo} ainda não definido para este item`,
  };
}

/** Atalhos usados pela tela e pelos testes. */
export const sugerirCfop = (item: ItemNFe, c: Regra[], ctx: ContextoNota) => sugerir('cfop', item, c, ctx);
export const sugerirDescricao = (item: ItemNFe, c: Regra[]) =>
  sugerir('descricao', item, c, { perfil: 'revenda', ufEmitente: null, ufDestinatario: null });

/** Resume o estado de um item para o filtro "só o que precisa de atenção". */
export function estadoDoItem(sugestoes: Sugestao[]): Confianca {
  if (sugestoes.some((s) => s.confianca === 'nenhuma')) return 'nenhuma';
  if (sugestoes.some((s) => s.confianca === 'media')) return 'media';
  return 'alta';
}

// ------------------------------------------------------------------ aprendizado

export type Aprendizado =
  | { tipo: 'criar'; nivel: Nivel; chave: string; campo: Campo; valor: string; fixada: boolean }
  | { tipo: 'confirmar'; regraId: string }
  | { tipo: 'corrigir'; regraId: string; valorNovo: string };

/**
 * Traduz o que o operador fez numa lista de mudancas nas regras.
 *
 * `fixar` = a contadora esta dizendo "para esta empresa e este fornecedor e assim,
 * ponto". Cria a regra ja em verde e imune a rebaixamento.
 */
export function aprender(params: {
  item: ItemNFe;
  emitCnpj: string;
  campo: Campo;
  valorFinal: string;
  sugestao: Sugestao | null;
  fixar?: boolean;
  /** limita o aprendizado a estes niveis (usado por "aplicar a todo o fornecedor") */
  apenasNiveis?: Nivel[];
}): Aprendizado[] {
  const { item, emitCnpj, campo, valorFinal, sugestao, fixar = false, apenasNiveis } = params;
  const out: Aprendizado[] = [];

  if (sugestao?.regraId) {
    if (sugestao.valor === valorFinal) {
      out.push({ tipo: 'confirmar', regraId: sugestao.regraId });
    } else {
      out.push({ tipo: 'corrigir', regraId: sugestao.regraId, valorNovo: valorFinal });
    }
  }

  // Sem `apenasNiveis`, grava só o que aprende sozinho (nunca o padrão do fornecedor).
  // Com `apenasNiveis`, é pedido explícito — aí o nível 5 entra.
  const alvos = apenasNiveis
    ? chavesAprendiveisExplicitas(item, emitCnpj, campo).filter(({ nivel }) => apenasNiveis.includes(nivel))
    : chavesAprendiveis(item, emitCnpj, campo);

  for (const { nivel, chave } of alvos) {
    out.push({ tipo: 'criar', nivel, chave, campo, valor: valorFinal, fixada: fixar });
  }

  return out;
}

export function aplicarAcerto(regra: Regra): Regra {
  const nova = { ...regra, acertos: regra.acertos + 1, usos: regra.usos + 1, errosSeguidos: 0 };
  return { ...nova, confianca: recalcularConfianca(nova) };
}

/** Tres erros seguidos derrubam a regra para a tela de "regras suspeitas". */
export function aplicarErro(regra: Regra): Regra {
  if (regra.fixada) {
    // Regra fixada pela contabilidade nao e rebaixada sozinha: so a contabilidade solta.
    const nova = { ...regra, erros: regra.erros + 1, usos: regra.usos + 1 };
    return { ...nova, confianca: recalcularConfianca(nova) };
  }
  const errosSeguidos = regra.errosSeguidos + 1;
  const nova = {
    ...regra,
    erros: regra.erros + 1,
    errosSeguidos,
    usos: regra.usos + 1,
    suspeita: errosSeguidos >= LIMITE_ERROS_SEGUIDOS,
  };
  return { ...nova, confianca: recalcularConfianca(nova) };
}

// ------------------------------------------------------------------ normalizacao

export const ABREVIACOES_SEMENTE: Record<string, string> = {
  CHOC: 'CHOCOLATE', PT: 'POTE', PCT: 'PACOTE', CX: 'CAIXA', UN: 'UNIDADE',
  REFRIG: 'REFRIGERANTE', ACHOC: 'ACHOCOLATADO', BISC: 'BISCOITO', DET: 'DETERGENTE',
  SAB: 'SABAO', AMAC: 'AMACIANTE', MARG: 'MARGARINA', LEIT: 'LEITE', COND: 'CONDENSADO',
  INT: 'INTEGRAL', DESN: 'DESNATADO', CONG: 'CONGELADO', TRAD: 'TRADICIONAL',
};

export function normalizarDescricao(
  texto: string,
  dicionario: Record<string, string> = ABREVIACOES_SEMENTE,
): string {
  return texto
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((token) => {
      const limpo = token.toUpperCase().replace(/[.,;]$/, '');
      const pontuacao = token.slice(limpo.length);
      return (dicionario[limpo] ?? limpo) + pontuacao;
    })
    .join(' ');
}
