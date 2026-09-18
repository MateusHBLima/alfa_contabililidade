import { parseNFe, lerEventoNFe, hashXml } from './parser';
import { ErroParserNFe } from './tipos';
import type { Repo } from '../db/repo';
import { chavesDoItem, sugerir, type ContextoNota, type PerfilEmpresa } from '../rules/engine';
import { TODOS_CAMPOS, type Campo } from '../rules/campos';

/**
 * Importacao de notas.
 *
 * Hoje a entrada e upload manual. O cliente ainda vai confirmar de onde os arquivos
 * virao no futuro (outro sistema, e-mail, SEFAZ). Por isso o `lote` guarda a `origem`
 * desde ja: quando a fonte mudar, muda uma string, nao o modelo de dados.
 *
 * O que acontece em cada nota importada:
 *   1. le e valida o XML
 *   2. guarda o original no R2, imutavel, com hash
 *   3. registra o fornecedor na ficha da empresa
 *   4. roda o motor de regras em cada item e ja grava as sugestoes
 *
 * O passo 4 e o que faz a segunda nota de um fornecedor chegar pronta.
 *
 * PRINCIPIO: nenhum arquivo some sem explicacao que a contadora entenda. Todo
 * arquivo termina como `importada`, `duplicada`, `evento` ou `recusada`, com motivo
 * em portugues de escritorio - nao em mensagem de parser nem de banco.
 *
 *   - `duplicada` diz quantos itens ela ja tinha conferido e que nada foi alterado.
 *     Reimportar NUNCA mexe em nota existente (a gravacao e um batch atomico e a
 *     chave e unica por tenant); o que faltava era a tela dizer isso.
 *   - `evento` e XML de cancelamento / carta de correcao. Por decisao de 17/09 o
 *     cancelamento e tratado A MAO pela contabilidade; o sistema nao grava o evento,
 *     mas diz com todas as letras qual nota foi atingida. Evento ignorado e nota
 *     cancelada sendo escriturada.
 */

export type ResultadoArquivo = {
  arquivo: string;
  status: 'importada' | 'duplicada' | 'evento' | 'recusada';
  /** So em `duplicada`: quantos itens a nota tem e quantos ja estavam conferidos. */
  itensConferidos?: number;
  /** So em `evento`. */
  evento?: { tipo: string; descricao: string; cancela: boolean; chaveNota: string; numeroNota: string; notaNoSistema: boolean };
  chave?: string;
  notaId?: string;
  itens?: number;
  preenchidos?: number;
  motivo?: string;
};

export type ResultadoLote = {
  loteId: string;
  envioId: string | null;
  total: number;
  importadas: number;
  duplicadas: number;
  /** Das duplicadas, quantas ja tinham algum item conferido por alguem. */
  duplicadasTratadas: number;
  eventos: number;
  recusadas: number;
  arquivos: ResultadoArquivo[];
};

export async function importarArquivos(
  repo: Repo,
  bucketOriginal: R2Bucket,
  empresaId: string,
  arquivos: { nome: string; conteudo: string }[],
  origem: 'upload' | 'email' | 'sefaz' | 'integracao' = 'upload',
  /** Amarra os lotes de um mesmo envio da tela (20 arquivos por requisicao). */
  envioId: string | null = null,
): Promise<ResultadoLote> {
  const empresa = await repo.obterEmpresa(empresaId);
  if (!empresa) throw new ErroParserNFe('Empresa não encontrada ou fora do seu acesso.');

  const loteId = repo.novoId();
  const resultados: ResultadoArquivo[] = [];

  for (const arq of arquivos) {
    try {
      resultados.push(
        await importarUma(repo, bucketOriginal, empresa, loteId, arq, origem),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'erro desconhecido';
      // Dois envios do mesmo arquivo ao mesmo tempo: o segundo bate na chave unica
      // e o batch inteiro dele e desfeito. Nada se perde - mas "UNIQUE constraint
      // failed" na tela da contadora parece desastre. E duplicata, e dizemos isso.
      if (/UNIQUE constraint failed: notas\./i.test(msg)) {
        resultados.push({
          arquivo: arq.nome,
          status: 'duplicada',
          motivo: 'já estava sendo importada por outro envio — nada foi alterado',
        });
        continue;
      }
      resultados.push({ arquivo: arq.nome, status: 'recusada', motivo: msg });
    }
  }

  const importadas = resultados.filter((r) => r.status === 'importada').length;
  const duplicadas = resultados.filter((r) => r.status === 'duplicada').length;
  const recusadas = resultados.filter((r) => r.status === 'recusada').length;
  const eventos = resultados.filter((r) => r.status === 'evento').length;
  const duplicadasTratadas = resultados.filter(
    (r) => r.status === 'duplicada' && (r.itensConferidos ?? 0) > 0,
  ).length;

  await repo.bd
    .prepare(
      `INSERT INTO lotes_importacao
         (id, tenant_id, empresa_id, origem, nome_arquivo, total_arquivos,
          importadas, duplicadas, recusadas, detalhe, criado_em, criado_por, envio_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      loteId, repo.contexto.sessao.tenantId, empresaId, origem,
      arquivos.length === 1 ? arquivos[0]!.nome : `${arquivos.length} arquivos`,
      arquivos.length, importadas, duplicadas, recusadas,
      JSON.stringify(resultados), repo.agora(), repo.contexto.sessao.usuarioId,
      envioId,
    )
    .run();

  await repo.auditoria().registrar({
    tenantId: repo.contexto.sessao.tenantId,
    usuarioId: repo.contexto.sessao.usuarioId,
    usuarioEmail: repo.contexto.sessao.email,
    acao: 'criar',
    entidade: 'lote_importacao',
    entidadeId: loteId,
    valorDepois:
      `${importadas} importada(s), ${duplicadas} duplicada(s), ${recusadas} recusada(s)` +
      (eventos ? `, ${eventos} evento(s)` : ''),
    origem: 'importacao',
    ip: repo.contexto.ip,
    requestId: repo.contexto.requestId,
  });

  return {
    loteId, envioId, total: arquivos.length, importadas, duplicadas, duplicadasTratadas,
    eventos, recusadas, arquivos: resultados,
  };
}

async function importarUma(
  repo: Repo,
  bucket: R2Bucket,
  empresa: any,
  loteId: string,
  arq: { nome: string; conteudo: string },
  origem: string,
): Promise<ResultadoArquivo> {
  const evento = lerEventoNFe(arq.conteudo);
  if (evento) {
    const atingida = await repo.situacaoDaNota(evento.chNFe);
    const quando = evento.dhEvento ? ` em ${dataBr(evento.dhEvento)}` : '';
    const porque = evento.justificativa ? ` — "${evento.justificativa}"` : '';
    const onde = atingida
      ? `A nota ESTÁ no sistema${atingida.emitNome ? ` (${atingida.emitNome})` : ''}` +
        (atingida.revisados > 0 ? `, com ${atingida.revisados} item(ns) já conferido(s)` : '') + '.'
      : 'A nota não está no sistema.';
    const oQueFazer = evento.cancela
      ? ' O sistema não cancela sozinho: trate esta nota manualmente.'
      : ' O evento não foi gravado: confira a nota manualmente.';
    return {
      arquivo: arq.nome,
      status: 'evento',
      chave: evento.chNFe,
      notaId: atingida?.id,
      motivo:
        `${evento.descricao.toUpperCase()} da NF ${evento.numeroNota} (série ${evento.serieNota})` +
        `${quando}${porque}. ${onde}${oQueFazer}`,
      evento: {
        tipo: evento.tpEvento, descricao: evento.descricao, cancela: evento.cancela,
        chaveNota: evento.chNFe, numeroNota: evento.numeroNota, notaNoSistema: atingida !== null,
      },
    };
  }

  const nota = parseNFe(arq.conteudo);

  if (await repo.notaExiste(nota.chave)) {
    // Nota sem item e sobra de uma importacao que falhou. Deixar passar como
    // "duplicada" prenderia o arquivo para sempre.
    const eraOrfa = await repo.limparNotaSemItens(nota.chave);
    if (!eraOrfa) {
      const sit = await repo.situacaoDaNota(nota.chave);
      const conferidos = sit?.revisados ?? 0;
      return {
        arquivo: arq.nome,
        status: 'duplicada',
        chave: nota.chave,
        notaId: sit?.id,
        itens: sit?.itens,
        itensConferidos: conferidos,
        motivo:
          conferidos > 0
            ? `já estava no sistema, com ${conferidos} de ${sit!.itens} itens conferidos — nada foi alterado`
            : 'já estava no sistema — nada foi alterado',
      };
    }
  }

  // Aviso, nao bloqueio: nota de outro CNPJ pode ser engano de pasta, mas tambem pode
  // ser filial. Quem decide e a contadora - o sistema so nao deixa passar despercebido.
  const motivoAviso =
    nota.dest.cnpj && empresa.cnpj && nota.dest.cnpj !== empresa.cnpj
      ? `destinatário ${nota.dest.cnpj} difere do CNPJ da empresa (${empresa.cnpj})`
      : undefined;

  const hash = await hashXml(arq.conteudo);
  const chaveR2 = `${empresa.tenant_id}/${empresa.id}/${nota.competencia ?? 'sem-competencia'}/${nota.chave}.xml`;

  await bucket.put(chaveR2, arq.conteudo, {
    httpMetadata: { contentType: 'application/xml' },
    customMetadata: { chave: nota.chave, hash, empresa: empresa.id, lote: loteId },
  });

  const notaId = repo.novoId();
  const tenant = repo.contexto.sessao.tenantId;

  // A nota so e gravada junto com os itens, num batch unico (o batch do D1 e
  // atomico). Antes ela entrava primeiro: se o motor de regras falhasse depois,
  // sobrava uma nota sem item nenhum na tela - foi o que aconteceu com a
  // primeira nota real de 20 itens.
  const insertNota = repo.bd
    .prepare(
      `INSERT INTO notas
         (id, tenant_id, empresa_id, chave, numero, serie, modelo, emit_cnpj, emit_nome,
          emit_uf, dest_cnpj, dh_emi, competencia, valor_total, protocolo, status,
          r2_original, hash_original, lote_id, origem, criado_em, criado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'importada',?,?,?,?,?,?)`,
    )
    .bind(
      notaId, tenant, empresa.id, nota.chave, nota.numero, nota.serie, nota.modelo,
      nota.emit.cnpj, nota.emit.nome, nota.emit.uf, nota.dest.cnpj, nota.dhEmi,
      nota.competencia, nota.vNF, nota.protocolo, chaveR2, hash, loteId, origem,
      repo.agora(), repo.contexto.sessao.usuarioId,
    );

  // --- motor de regras: uma consulta para a nota inteira -----------------
  const todasChaves = nota.itens.flatMap((it) => chavesDoItem(it, nota.emit.cnpj));
  const candidatas = await repo.carregarRegrasCandidatas(empresa.id, todasChaves);

  const contexto: ContextoNota = {
    perfil: (empresa.perfil ?? 'revenda') as PerfilEmpresa,
    ufEmitente: nota.emit.uf,
    ufDestinatario: empresa.uf ?? nota.dest.uf,
  };

  let preenchidos = 0;
  const inserts: D1PreparedStatement[] = [];

  for (const item of nota.itens) {
    const chaves = chavesDoItem(item, nota.emit.cnpj);
    const doItem = candidatas.filter((r) =>
      chaves.some((c) => c.nivel === r.nivel && c.chave === r.chave),
    );

    const sug: Record<Campo, ReturnType<typeof sugerir>> = {} as any;
    for (const campo of TODOS_CAMPOS) {
      sug[campo] = sugerir(campo, item, doItem, contexto);
    }

    // Quem decide se a linha esta pronta e o CFOP.
    //
    // Antes exigia CFOP *e* descricao no verde, e isso tornava o verde quase
    // inalcancavel: a contadora mandava fixar o padrao do fornecedor - a ordem
    // mais forte que o sistema aceita - e a linha continuava dizendo "Conferir"
    // na nota seguinte, e na outra, para sempre. Do ponto de vista dela, fixar
    // nao fazia nada.
    //
    // A assimetria e proposital e e fiscal: o CFOP de entrada e a DECISAO
    // tributaria, e errar nele tem consequencia no cliente do cliente. A
    // descricao padronizada e conveniencia de escrituracao - quando ninguem
    // ensinou, o XML corrigido sai com a descricao do proprio fornecedor, que e
    // exatamente o que ja acontecia. Nao se perde nada; deixa-se de mentir sobre
    // o que falta.
    //
    // A descricao pendente nao some da tela: vira o alerta `descricao_padrao`,
    // informativo, que a linha carrega sem pedir acao.
    const confianca =
      sug['cfop']!.confianca === 'alta'
        ? 'alta'
        : sug['cfop']!.regraId || sug['descricao']!.regraId
          ? 'media'
          : 'nenhuma';

    if (sug['cfop']!.regraId) preenchidos += 1;

    inserts.push(
      repo.bd
        .prepare(
          `INSERT INTO itens
             (id, tenant_id, nota_id, n_item, c_prod, c_ean, x_prod_original, ncm, cest,
              cfop_original, cst_origem, unidade, quantidade, valor_unitario, valor_total,
              cfop_novo, cfop_origem, x_prod_novo, x_prod_origem,
              cst_entrada, cst_entrada_origem, conta_contabil, conta_contabil_origem,
              credito_icms, credito_icms_origem, credito_pis, credito_pis_origem,
              credito_cofins, credito_cofins_origem, confianca, revisado)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .bind(
          repo.novoId(), tenant, notaId, item.nItem, item.cProd, item.cEAN, item.xProd,
          item.NCM, item.CEST, item.CFOP, item.cstIcms,
          item.uCom, item.qCom, item.vUnCom, item.vProd,
          sug['cfop']!.valor, sug['cfop']!.origem,
          sug['descricao']!.valor, sug['descricao']!.origem,
          vazioParaNulo(sug['cst_entrada']!.valor), sug['cst_entrada']!.origem,
          vazioParaNulo(sug['conta_contabil']!.valor), sug['conta_contabil']!.origem,
          vazioParaNulo(sug['credito_icms']!.valor), sug['credito_icms']!.origem,
          vazioParaNulo(sug['credito_pis']!.valor), sug['credito_pis']!.origem,
          vazioParaNulo(sug['credito_cofins']!.valor), sug['credito_cofins']!.origem,
          confianca,
        ),
    );
  }

  await repo.bd.batch([insertNota, ...inserts]);

  await repo.registrarFornecedor(empresa.id, nota.emit.cnpj, nota.emit.nome, nota.emit.uf);

  return {
    arquivo: arq.nome,
    status: 'importada',
    chave: nota.chave,
    notaId,
    itens: nota.itens.length,
    preenchidos,
    motivo: motivoAviso,
  };
}

/** 2026-09-09T10:02:20-03:00 -> 09/09/2026. Sem Date: o fuso do servidor nao e o da nota. */
function dataBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function vazioParaNulo(v: string): string | null {
  return v.trim() === '' ? null : v;
}
