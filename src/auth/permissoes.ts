/**
 * Catalogo de permissoes.
 *
 * A granularidade segue o SIGNIFICADO DE NEGOCIO, nao o esquema do banco.
 * O que muda de responsabilidade aqui sao poucas coisas - por isso a lista e curta,
 * e curta e o ponto. Matriz gigante ninguem audita.
 *
 * O admin monta papeis combinando estas chaves; ele NAO cria chave nova pela tela,
 * porque permissao nova exige codigo que a respeite.
 */

/**
 * Catálogo de permissões, por VERBO.
 *
 * A granularidade segue o que muda de responsabilidade num escritório, não o
 * esquema do banco: cadastrar um cliente novo, alterar o perfil fiscal dele e
 * apagar uma regra aprendida são decisões diferentes, com donos diferentes.
 *
 * Antes existia `empresas.gerenciar`, que liberava ver, criar e editar de uma
 * vez — e o pedido do cliente foi literalmente "não pode modificar empresas,
 * não pode criar empresas, pode X ação". Uma permissão que responde por três
 * verbos não consegue dizer isso.
 *
 * O admin NÃO cria permissão nova pela tela: permissão nova exige código que a
 * respeite, então nasce aqui e numa migração. O que ele monta pela tela são
 * PAPÉIS — conjuntos destas chaves.
 */
export const PERMISSOES = {
  // ---------------------------------------------------------------- notas
  'notas.visualizar': { grupo: 'Notas', descricao: 'Ver a lista de notas e abrir uma nota' },
  'notas.importar': { grupo: 'Notas', descricao: 'Subir arquivos XML ou ZIP' },
  'notas.editar_cfop': { grupo: 'Notas', descricao: 'Alterar CFOP (item, lote ou nota inteira)' },
  'notas.editar_descricao': { grupo: 'Notas', descricao: 'Alterar a descrição do produto' },
  'notas.editar_escrituracao': {
    grupo: 'Notas',
    descricao: 'Alterar CST de entrada, conta contábil e créditos',
  },
  'notas.exportar': { grupo: 'Notas', descricao: 'Gerar e baixar o XML corrigido e a escrituração' },

  // ---------------------------------------------------------------- regras
  'regras.visualizar': { grupo: 'Regras', descricao: 'Ver as regras aprendidas pelo sistema' },
  'regras.aprovar': { grupo: 'Regras', descricao: 'Promover ou rebaixar uma regra' },
  // Fixar padrão de fornecedor é diferente de aprovar uma regra de produto: vale
  // para tudo que vier daquele fornecedor, inclusive o que ninguém viu ainda.
  'regras.fixar': { grupo: 'Regras', descricao: 'Fixar o padrão de um fornecedor para a empresa' },
  'regras.apagar': { grupo: 'Regras', descricao: 'Apagar uma regra aprendida' },

  // ---------------------------------------------------------------- empresas
  'empresas.visualizar': { grupo: 'Empresas', descricao: 'Ver a lista de clientes e os dados de cada um' },
  'empresas.criar': { grupo: 'Empresas', descricao: 'Cadastrar um cliente novo' },
  'empresas.editar': { grupo: 'Empresas', descricao: 'Alterar dados e perfil fiscal de um cliente' },
  'empresas.desativar': { grupo: 'Empresas', descricao: 'Desativar um cliente' },
  // Sem esta, a pessoa só enxerga os clientes ligados a ela em `usuario_empresas`.
  // Num escritório com 300 clientes, "vê todos" é decisão, não padrão — e antes
  // ela vinha de carona em `empresas.gerenciar`, sem nome próprio.
  'empresas.todas': { grupo: 'Empresas', descricao: 'Ver TODOS os clientes, sem precisar de vínculo' },

  // ---------------------------------------------------------------- usuários
  'usuarios.visualizar': { grupo: 'Usuários', descricao: 'Ver a lista de usuários e o que cada um pode' },
  'usuarios.criar': { grupo: 'Usuários', descricao: 'Criar usuário e definir papel e empresas' },
  'usuarios.editar': { grupo: 'Usuários', descricao: 'Alterar papel, empresas e exceções de alguém' },
  // Aprovar é a mesma decisão de criar, tomada por outro caminho: quem entra no
  // sistema e com que poder. Tem chave própria para poder ser delegada sozinha.
  'usuarios.aprovar': { grupo: 'Usuários', descricao: 'Liberar contas que se cadastraram e estão esperando' },
  'usuarios.convidar': { grupo: 'Usuários', descricao: 'Gerar links de convite' },
  'usuarios.desativar': { grupo: 'Usuários', descricao: 'Desativar um usuário' },
  // Separadas do resto de propósito: redefinir a senha de outra pessoa e desligar
  // o segundo fator dela são poderes que dão acesso à conta alheia. Quem organiza
  // papéis não precisa necessariamente poder entrar como ninguém.
  'usuarios.redefinir_senha': { grupo: 'Usuários', descricao: 'Redefinir a senha de outro usuário' },
  'usuarios.desativar_mfa': { grupo: 'Usuários', descricao: 'Desligar o segundo fator de outro usuário' },
  'papeis.gerenciar': { grupo: 'Usuários', descricao: 'Criar e editar papéis (conjuntos de permissões)' },

  // ---------------------------------------------------------------- auditoria
  'auditoria.visualizar': { grupo: 'Administração', descricao: 'Consultar a trilha de alterações' },
} as const;

export type Permissao = keyof typeof PERMISSOES;

export const TODAS_PERMISSOES = Object.keys(PERMISSOES) as Permissao[];

/**
 * Papeis-semente. O admin pode editar depois - exceto apagar o papel Admin,
 * senao o escritorio se tranca para fora do proprio sistema.
 */
export const PAPEIS_SEMENTE: { nome: string; descricao: string; sistema: boolean; permissoes: Permissao[] }[] = [
  {
    nome: 'Operador',
    descricao: 'Trata notas: importa, corrige CFOP e descrição.',
    sistema: false,
    permissoes: [
      'notas.visualizar', 'notas.importar', 'notas.editar_cfop', 'notas.editar_descricao',
      'regras.visualizar',
      // Ver a empresa é pré-requisito de ver as notas dela: sem isto o seletor
      // do topo fica vazio e a tela inteira não funciona.
      'empresas.visualizar',
    ],
  },
  {
    nome: 'Supervisor',
    descricao: 'Tudo do operador, mais escrituração, regras, exportação e trilha.',
    sistema: false,
    permissoes: [
      'notas.visualizar', 'notas.importar', 'notas.editar_cfop', 'notas.editar_descricao',
      // O supervisor mexe em escrituração; o operador, não. É a decisão fiscal
      // que exige olho de contador, não o preenchimento do dia a dia.
      'notas.editar_escrituracao', 'notas.exportar',
      'regras.visualizar', 'regras.aprovar', 'regras.fixar',
      'empresas.visualizar', 'empresas.editar',
      'auditoria.visualizar',
    ],
  },
  {
    nome: 'Admin',
    descricao: 'Acesso total, incluindo usuários, papéis e empresas.',
    sistema: true,
    permissoes: TODAS_PERMISSOES,
  },
];

/**
 * Permissões que um papel NÃO pode conceder a si mesmo sem já as ter.
 *
 * Sem isto, quem pode editar papéis pode marcar todas as caixinhas do próprio
 * papel e virar administrador — o que faz de `papeis.gerenciar` a única
 * permissão que importa. Quem edita papel só concede o que já possui.
 */
/** Exige QUALQUER uma da lista. Existe para telas que servem a dois caminhos —
 *  a prévia do CNAE é usada tanto ao criar quanto ao editar um cliente. */
export function exigirAlguma(sessao: Sessao, quais: Permissao[]): void {
  if (!quais.some((p) => sessao.permissoes.has(p))) throw new SemPermissao(quais[0]!);
}

export function permissoesQuePodeConceder(sessao: Sessao): Permissao[] {
  return TODAS_PERMISSOES.filter((p) => sessao.permissoes.has(p));
}

/**
 * O que a pessoa pode, de fato: o papel, mais o que foi concedido à parte,
 * menos o que foi tirado à parte.
 *
 * A exceção por pessoa existe porque o papel resolve quase tudo e o resto é
 * gente. A alternativa — um papel novo para cada exceção — é como matriz de
 * permissão vira sopa de letrinhas que ninguém audita.
 */
export function resolverPermissoes(
  doPapel: Iterable<string>,
  excecoes: { permissao: string; concedida: number | boolean }[],
): Set<Permissao> {
  const efetivas = new Set<string>(doPapel);
  for (const e of excecoes) {
    if (e.concedida === 1 || e.concedida === true) efetivas.add(e.permissao);
    else efetivas.delete(e.permissao);
  }
  // Só chaves do catálogo entram: permissão órfã no banco (de uma migração
  // futura revertida, por exemplo) não vira poder acidental.
  return new Set([...efetivas].filter((p): p is Permissao => p in PERMISSOES));
}

/**
 * Permissões que os campos do template exigem (src/rules/campos.ts).
 * Existe para que um teste garanta que toda permissão exigida por um campo
 * está no catálogo E é concedida por algum papel — senão o campo fica inalcançável.
 */
export const CAMPOS_PERMISSOES_USADAS: string[] = [
  'notas.editar_cfop',
  'notas.editar_descricao',
  'notas.editar_escrituracao',
];

export type Sessao = {
  usuarioId: string;
  tenantId: string;
  email: string;
  nome: string;
  permissoes: Set<Permissao>;
  /** null = sem vínculo explícito; só vê tudo quem tiver `empresas.todas` */
  empresas: Set<string> | null;
  /** Senha redefinida por um administrador: a sessão só serve para trocá-la. */
  deveTrocarSenha: boolean;
};

export function podeVerEmpresa(sessao: Sessao, empresaId: string): boolean {
  if (sessao.empresas === null) return sessao.permissoes.has('empresas.todas');
  return sessao.empresas.has(empresaId);
}

export class SemPermissao extends Error {
  constructor(public readonly permissao: string) {
    super(`Sem permissão: ${permissao}`);
    this.name = 'SemPermissao';
  }
}

export function exigir(sessao: Sessao, permissao: Permissao): void {
  if (!sessao.permissoes.has(permissao)) throw new SemPermissao(permissao);
}
