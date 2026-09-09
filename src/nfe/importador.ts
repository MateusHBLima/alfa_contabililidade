import { parseNFe, hashXml } from './parser';
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
 */

export type ResultadoArquivo = {
  arquivo: string;
  status: 'importada' | 'duplicada' | 'recusada';
  chave?: string;
  notaId?: string;
  itens?: number;
  preenchidos?: number;
  motivo?: string;
};

export type ResultadoLote = {
  loteId: string;
  total: number;
  importadas: number;
  duplicadas: number;
  recusadas: number;
  arquivos: ResultadoArquivo[];
};

export async function importarArquivos(
  repo: Repo,
  bucketOriginal: R2Bucket,
  empresaId: string,
  arquivos: { nome: string; conteudo: string }[],
  origem: 'upload' | 'email' | 'sefaz' | 'integracao' = 'upload',
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
      resultados.push({
        arquivo: arq.nome,
        status: 'recusada',
        motivo: e instanceof Error ? e.message : 'erro desconhecido',
      });
    }
  }

  const importadas = resultados.filter((r) => r.status === 'importada').length;
  const duplicadas = resultados.filter((r) => r.status === 'duplicada').length;
  const recusadas = resultados.filter((r) => r.status === 'recusada').length;

  await repo.bd
    .prepare(
      `INSERT INTO lotes_importacao
         (id, tenant_id, empresa_id, origem, nome_arquivo, total_arquivos,
          importadas, duplicadas, recusadas, detalhe, criado_em, criado_por)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      loteId, repo.contexto.sessao.tenantId, empresaId, origem,
      arquivos.length === 1 ? arquivos[0]!.nome : `${arquivos.length} arquivos`,
      arquivos.length, importadas, duplicadas, recusadas,
      JSON.stringify(resultados), repo.agora(), repo.contexto.sessao.usuarioId,
    )
    .run();

  await repo.auditoria().registrar({
    tenantId: repo.contexto.sessao.tenantId,
    usuarioId: repo.contexto.sessao.usuarioId,
    usuarioEmail: repo.contexto.sessao.email,
    acao: 'criar',
    entidade: 'lote_importacao',
    entidadeId: loteId,
    valorDepois: `${importadas} importada(s), ${duplicadas} duplicada(s), ${recusadas} recusada(s)`,
    origem: 'importacao',
    ip: repo.contexto.ip,
    requestId: repo.contexto.requestId,
  });

  return { loteId, total: arquivos.length, importadas, duplicadas, recusadas, arquivos: resultados };
}

async function importarUma(
  repo: Repo,
  bucket: R2Bucket,
  empresa: any,
  loteId: string,
  arq: { nome: string; conteudo: string },
  origem: string,
): Promise<ResultadoArquivo> {
  const nota = parseNFe(arq.conteudo);

  if (await repo.notaExiste(nota.chave)) {
    // Nota sem item e sobra de uma importacao que falhou. Deixar passar como
    // "duplicada" prenderia o arquivo para sempre.
    const eraOrfa = await repo.limparNotaSemItens(nota.chave);
    if (!eraOrfa) {
      return { arquivo: arq.nome, status: 'duplicada', chave: nota.chave };
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

    // Verde se tudo que importa veio de regra específica e provada.
    const confianca =
      sug['cfop']!.confianca === 'alta' && sug['descricao']!.confianca === 'alta'
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

function vazioParaNulo(v: string): string | null {
  return v.trim() === '' ? null : v;
}
