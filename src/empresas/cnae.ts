import type { PerfilEmpresa } from '../rules/engine';

/**
 * Pre-preenchimento do cadastro de empresa a partir do CNAE.
 *
 * Serve para responder a pergunta do cliente: "no cadastro, conseguir escolher
 * informacoes que ja pre-populem a primeira execucao".
 *
 * O CNAE nao decide nada sozinho - ele so evita que a contadora comece do zero.
 * O perfil sugerido aqui alimenta o NIVEL 7 do motor de regras, que e o palpite de
 * ultimo recurso, sempre marcado em amarelo. A partir da primeira nota tratada, o
 * aprendizado por fornecedor e por produto passa por cima disso.
 *
 * IMPORTANTE: e heuristica por divisao (os dois primeiros digitos do CNAE), nao
 * classificacao fiscal. A tela mostra a sugestao e quem confirma e a contadora.
 */

export type SugestaoCadastro = {
  perfil: PerfilEmpresa;
  cfopPadraoDentroUF: string;
  cfopPadraoForaUF: string;
  confianca: 'alta' | 'media' | 'baixa';
  justificativa: string;
};

/** Divisao CNAE (2 primeiros digitos) -> perfil. */
function perfilPorDivisao(divisao: number): { perfil: PerfilEmpresa; nota: string } | null {
  // Industria de transformacao
  if (divisao >= 10 && divisao <= 33)
    return { perfil: 'industrializacao', nota: 'indústria de transformação' };
  // Extrativas
  if (divisao >= 5 && divisao <= 9)
    return { perfil: 'industrializacao', nota: 'indústria extrativa' };
  // Comercio (atacado, varejo, veiculos)
  if (divisao >= 45 && divisao <= 47)
    return { perfil: 'revenda', nota: 'comércio' };
  // Construcao
  if (divisao >= 41 && divisao <= 43)
    return { perfil: 'uso_consumo', nota: 'construção civil' };
  // Eletricidade, gas, agua, esgoto
  if (divisao >= 35 && divisao <= 39)
    return { perfil: 'uso_consumo', nota: 'utilidades' };
  // Agropecuaria
  if (divisao >= 1 && divisao <= 3)
    return { perfil: 'industrializacao', nota: 'agropecuária' };
  // Transporte, alojamento, alimentacao, informacao, financeiro, servicos em geral
  if (divisao >= 49 && divisao <= 99)
    return { perfil: 'uso_consumo', nota: 'prestação de serviços' };
  return null;
}

const CFOP_PADRAO: Record<PerfilEmpresa, { dentro: string; fora: string }> = {
  revenda: { dentro: '1102', fora: '2102' },
  industrializacao: { dentro: '1101', fora: '2101' },
  uso_consumo: { dentro: '1556', fora: '2556' },
};

export function normalizarCnae(cnae: string): string | null {
  const so = cnae.replace(/\D/g, '');
  // CNAE 2.x tem 7 digitos (divisao 2 + grupo 1 + classe 2 + subclasse 2)
  return so.length === 7 ? so : so.length >= 2 ? so.padEnd(7, '0').slice(0, 7) : null;
}

export function sugerirPeloCnae(cnaePrincipal: string): SugestaoCadastro {
  const normalizado = normalizarCnae(cnaePrincipal);
  const divisao = normalizado ? Number(normalizado.slice(0, 2)) : NaN;
  const achado = Number.isFinite(divisao) ? perfilPorDivisao(divisao) : null;

  if (!achado) {
    return {
      perfil: 'uso_consumo',
      cfopPadraoDentroUF: CFOP_PADRAO.uso_consumo.dentro,
      cfopPadraoForaUF: CFOP_PADRAO.uso_consumo.fora,
      confianca: 'baixa',
      justificativa:
        'CNAE não reconhecido. Adotado uso e consumo por ser o mais conservador — confirme o perfil.',
    };
  }

  const cfop = CFOP_PADRAO[achado.perfil];
  return {
    perfil: achado.perfil,
    cfopPadraoDentroUF: cfop.dentro,
    cfopPadraoForaUF: cfop.fora,
    // "media" e o teto de proposito: CNAE indica atividade, nao destinacao da mercadoria.
    confianca: 'media',
    justificativa: `CNAE ${normalizado} — ${achado.nota}. Sugestão inicial; a destinação real de cada item pode divergir.`,
  };
}

/**
 * Empresa com varios CNAEs: se os secundarios apontam para perfil diferente do
 * principal, a tela avisa. Empresa mista (industria que tambem revende) e o caso
 * em que o palpite por perfil erra mais - e melhor a contadora saber disso no cadastro
 * do que descobrir na terceira competencia.
 */
export function analisarCnaes(principal: string, secundarios: string[]): {
  sugestao: SugestaoCadastro;
  alerta: string | null;
} {
  const sugestao = sugerirPeloCnae(principal);
  const perfisSecundarios = new Set(secundarios.map((c) => sugerirPeloCnae(c).perfil));
  perfisSecundarios.delete(sugestao.perfil);

  if (perfisSecundarios.size === 0) return { sugestao, alerta: null };

  return {
    sugestao,
    alerta:
      `Os CNAEs secundários indicam também: ${[...perfisSecundarios].join(', ')}. ` +
      'Empresa com atividade mista costuma precisar de CFOP diferente por fornecedor — ' +
      'vale fixar o padrão fornecedor a fornecedor nas primeiras notas.',
  };
}
