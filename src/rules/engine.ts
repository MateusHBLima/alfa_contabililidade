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
  /** manual | regra:<id> | perfil | importacao */
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

// ------------------------------------------------------------------ chaves

/** Chave canonica de cada nivel. Null quando o item nao tem o dado necessario. */
export function chaveDoNivel(item: ItemNFe, emitCnpj: string, nivel: Nivel): string | null {
  const cnpj = emitCnpj.replace(/\D/g, '');
  switch (nivel) {
    case 1: return item.cProd ? `${cnpj}|${item.cProd.trim().toUpperCase()}` : null;
    case 2: return item.cEAN ? `${cnpj}|${item.cEAN}` : null;
    case 3: return item.cEAN ?? null;
    case 4: return item.NCM ? `${cnpj}|${item.NCM}` : null;
    case 5: return cnpj || null;
    case 6: return item.NCM ?? null;
    case 7: return 'perfil';
  }
}

export function chavesDoItem(item: ItemNFe, emitCnpj: string): { nivel: Nivel; chave: string }[] {
  const out: { nivel: Nivel; chave: string }[] = [];
  for (const { nivel } of NIVEIS) {
    const chave = chaveDoNivel(item, emitCnpj, nivel);
    if (chave !== null) out.push({ nivel, chave });
  }
  return out;
}

/**
 * Niveis gravados quando o operador corrige um item, sem pedir nada de especial.
 * Exclui o nivel 5 - ver o comentario em NIVEIS.
 */
export function chavesAprendiveis(item: ItemNFe, emitCnpj: string) {
  return chavesDoItem(item, emitCnpj).filter(({ nivel }) => NIVEIS[nivel - 1]?.implicito);
}

/** Niveis que podem ser gravados quando alguem pede explicitamente. */
export function chavesAprendiveisExplicitas(item: ItemNFe, emitCnpj: string) {
  return chavesDoItem(item, emitCnpj).filter(({ nivel }) => NIVEIS[nivel - 1]?.aprende);
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
    ? chavesAprendiveisExplicitas(item, emitCnpj).filter(({ nivel }) => apenasNiveis.includes(nivel))
    : chavesAprendiveis(item, emitCnpj);

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
