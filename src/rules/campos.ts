/**
 * Registro dos campos do template.
 *
 * Este arquivo existe por causa de uma frase do cliente: "acredito que tudo, e depois
 * vamos ajustando". Campo do template nao pode ser algo espalhado por dez arquivos -
 * senao "ajustar depois" vira refatoracao. Aqui, acrescentar um campo novo e acrescentar
 * uma entrada nesta tabela.
 *
 * A COLUNA MAIS IMPORTANTE E `escreveNoXml`.
 *
 * Decidido em 24/08 com o cliente: por enquanto a plataforma **REGISTRA** os dados de
 * escrituracao (CST de entrada, conta contabil, aproveitamento de credito) mas **NAO
 * REESCREVE** o XML com eles. So CFOP e descricao chegam ao XML corrigido.
 *
 * Motivo, em uma linha: reescrever CST derruba a invariante "CST/CSOSN inalterado" que
 * hoje protege a nota, e joga sobre a plataforma uma responsabilidade fiscal que o
 * contrato coloca na contabilidade (cláusulas 3.1 "d", 9.4 e a exclusao da 1.2.3).
 *
 * Quando a contadora testar e disser que precisa que o CST saia no XML, o caminho e
 * virar UMA flag aqui - e a suite de testes vai apontar exatamente qual invariante
 * precisa ser reescrita junto. E de proposito que da trabalho: e uma decisao fiscal,
 * nao uma decisao de programador.
 */

export type TipoCampo = 'cfop' | 'texto' | 'codigo' | 'booleano';

export type DefinicaoCampo = {
  chave: string;
  rotulo: string;
  tipo: TipoCampo;
  /** true = o valor vai parar dentro do XML corrigido. Ver o comentario do topo. */
  escreveNoXml: boolean;
  /** tag do XML alterada, quando escreveNoXml e true */
  tagXml?: string;
  /** o campo participa do aprendizado por regra? */
  aprende: boolean;
  /** permissao necessaria para editar */
  permissao: 'notas.editar_cfop' | 'notas.editar_descricao' | 'notas.editar_escrituracao';
  ajuda: string;
  validar?: (valor: string) => string | null;
};

const validaCfop = (v: string): string | null =>
  /^\d{4}$/.test(v) ? null : 'CFOP precisa ter exatamente 4 dígitos';

const validaCst = (v: string): string | null =>
  /^\d{2,3}$/.test(v) ? null : 'CST/CSOSN precisa ter 2 ou 3 dígitos';

const validaBooleano = (v: string): string | null =>
  v === 'S' || v === 'N' ? null : 'use S ou N';

export const CAMPOS: Record<string, DefinicaoCampo> = {
  cfop: {
    chave: 'cfop',
    rotulo: 'CFOP de entrada',
    tipo: 'cfop',
    escreveNoXml: true,
    tagXml: 'CFOP',
    aprende: true,
    permissao: 'notas.editar_cfop',
    ajuda: 'Converte a operação de saída do fornecedor na operação de entrada do cliente.',
    validar: validaCfop,
  },
  descricao: {
    chave: 'descricao',
    rotulo: 'Descrição do produto',
    tipo: 'texto',
    escreveNoXml: true,
    tagXml: 'xProd',
    aprende: true,
    permissao: 'notas.editar_descricao',
    ajuda: 'Descrição padronizada do cliente, no lugar da abreviação do fornecedor.',
  },

  // --- Daqui para baixo: REGISTRA, NAO REESCREVE. ---------------------------
  // Aparecem na tela, na aba de conferencia de contabilizacao (cláusula 1.2.1)
  // e na exportacao dos dados de escrituracao. Nao tocam o XML.

  cst_entrada: {
    chave: 'cst_entrada',
    rotulo: 'CST/CSOSN de entrada',
    tipo: 'codigo',
    escreveNoXml: false,
    aprende: true,
    permissao: 'notas.editar_escrituracao',
    ajuda: 'Situação tributária que a escrituração usará na entrada. Registrada, não gravada no XML.',
    validar: validaCst,
  },
  conta_contabil: {
    chave: 'conta_contabil',
    rotulo: 'Conta contábil',
    tipo: 'codigo',
    escreveNoXml: false,
    aprende: true,
    permissao: 'notas.editar_escrituracao',
    ajuda: 'Alimenta a conferência de contabilização: o que o XML trouxe contra as regras da contabilidade.',
  },
  credito_icms: {
    chave: 'credito_icms',
    rotulo: 'Aproveita crédito de ICMS',
    tipo: 'booleano',
    escreveNoXml: false,
    aprende: true,
    permissao: 'notas.editar_escrituracao',
    ajuda: 'S ou N. Depende do regime da empresa e da natureza do item.',
    validar: validaBooleano,
  },
  credito_pis: {
    chave: 'credito_pis',
    rotulo: 'Aproveita crédito de PIS',
    tipo: 'booleano',
    escreveNoXml: false,
    aprende: true,
    permissao: 'notas.editar_escrituracao',
    ajuda: 'S ou N.',
    validar: validaBooleano,
  },
  credito_cofins: {
    chave: 'credito_cofins',
    rotulo: 'Aproveita crédito de COFINS',
    tipo: 'booleano',
    escreveNoXml: false,
    aprende: true,
    permissao: 'notas.editar_escrituracao',
    ajuda: 'S ou N.',
    validar: validaBooleano,
  },
};

export type Campo = keyof typeof CAMPOS & string;

export const TODOS_CAMPOS = Object.keys(CAMPOS) as Campo[];

/** Os unicos campos que chegam ao XML corrigido. Hoje: cfop e descricao. */
export const CAMPOS_XML = TODOS_CAMPOS.filter((c) => CAMPOS[c]!.escreveNoXml);

/** Campos que a plataforma guarda mas nao grava no XML. */
export const CAMPOS_ESCRITURACAO = TODOS_CAMPOS.filter((c) => !CAMPOS[c]!.escreveNoXml);

export function ehCampoValido(c: string): c is Campo {
  return c in CAMPOS;
}

export function validarValor(campo: Campo, valor: string): string | null {
  const def = CAMPOS[campo];
  if (!def) return `campo desconhecido: ${campo}`;
  if (valor.trim() === '') return null; // vazio = "não preenchido", é permitido
  return def.validar ? def.validar(valor) : null;
}
