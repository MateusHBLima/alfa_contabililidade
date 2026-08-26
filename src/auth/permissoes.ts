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

export const PERMISSOES = {
  'notas.visualizar': { grupo: 'Notas', descricao: 'Ver a lista de notas e abrir uma nota' },
  'notas.importar': { grupo: 'Notas', descricao: 'Subir arquivos XML ou ZIP' },
  'notas.editar_cfop': { grupo: 'Notas', descricao: 'Alterar CFOP (item, lote ou nota inteira)' },
  'notas.editar_descricao': { grupo: 'Notas', descricao: 'Alterar a descrição do produto' },
  'regras.visualizar': { grupo: 'Regras', descricao: 'Ver as regras aprendidas pelo sistema' },
  'regras.aprovar': { grupo: 'Regras', descricao: 'Promover, rebaixar ou apagar regra' },
  'export.gerar': { grupo: 'Exportação', descricao: 'Gerar e baixar o XML corrigido' },
  'empresas.gerenciar': { grupo: 'Administração', descricao: 'Cadastrar clientes e perfis fiscais' },
  'usuarios.gerenciar': { grupo: 'Administração', descricao: 'Criar usuários e atribuir papéis' },
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
    permissoes: ['notas.visualizar', 'notas.importar', 'notas.editar_cfop', 'notas.editar_descricao', 'regras.visualizar'],
  },
  {
    nome: 'Supervisor',
    descricao: 'Tudo do operador, mais aprovar regras, exportar e consultar a trilha.',
    sistema: false,
    permissoes: [
      'notas.visualizar',
      'notas.importar',
      'notas.editar_cfop',
      'notas.editar_descricao',
      'regras.visualizar',
      'regras.aprovar',
      'export.gerar',
      'auditoria.visualizar',
    ],
  },
  {
    nome: 'Admin',
    descricao: 'Acesso total, incluindo usuários e empresas.',
    sistema: true,
    permissoes: TODAS_PERMISSOES,
  },
];

export type Sessao = {
  usuarioId: string;
  tenantId: string;
  email: string;
  nome: string;
  permissoes: Set<Permissao>;
  /** null = todas as empresas do tenant (só válido com empresas.gerenciar) */
  empresas: Set<string> | null;
};

export function podeVerEmpresa(sessao: Sessao, empresaId: string): boolean {
  if (sessao.empresas === null) return sessao.permissoes.has('empresas.gerenciar');
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
