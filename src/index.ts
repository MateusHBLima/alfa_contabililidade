import { Hono } from 'hono';
import { z } from 'zod';
import { Repo, ForaDoEscopo, type ContextoRequisicao } from './db/repo';
import { SemPermissao, exigir, type Sessao, type Permissao } from './auth/permissoes';
import { conferirSenha } from './auth/senha';
import { importarArquivos } from './nfe/importador';
import { analisarCnaes } from './empresas/cnae';
import { gerarXmlCorrigido, verificarInvariantes } from './nfe/serializer';
import { ErroParserNFe } from './nfe/tipos';
import { CAMPOS, TODOS_CAMPOS, ehCampoValido, validarValor, type Campo } from './rules/campos';
import { aprender, chavesDoItem, sugerir, type ContextoNota, type PerfilEmpresa } from './rules/engine';
import { detectarAlertas, estiloDaLinha, resumirNota } from './rules/alertas';

type Env = {
  DB: D1Database;
  XML_ORIGINAL: R2Bucket;
  XML_TRABALHO: R2Bucket;
  SESSION_SECRET: string;
  AUDIT_SEED: string;
  AMBIENTE: string;
};

type Vars = { repo: Repo; sessao: Sessao };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ------------------------------------------------------------------ sessao

const COOKIE = 'pf_sessao';
const DURACAO_H = 12;

async function assinar(valor: string, segredo: string): Promise<string> {
  const chave = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(segredo),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(valor));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function lerSessao(
  db: D1Database,
  cookieHeader: string | null,
  segredo: string,
): Promise<Sessao | null> {
  const m = (cookieHeader ?? '').match(new RegExp(`${COOKIE}=([^;]+)`));
  if (!m) return null;

  const [sessaoId, assinatura] = decodeURIComponent(m[1]!).split('.');
  if (!sessaoId || !assinatura) return null;
  if ((await assinar(sessaoId, segredo)) !== assinatura) return null;

  const linha = await db
    .prepare(
      `SELECT s.id, s.expira_em, s.revogada, u.id AS uid, u.tenant_id, u.email, u.nome, u.ativo
       FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id WHERE s.id = ?`,
    )
    .bind(sessaoId)
    .first<any>();

  if (!linha || linha.revogada === 1 || linha.ativo !== 1) return null;
  if (new Date(linha.expira_em) < new Date()) return null;

  const { results: perms } = await db
    .prepare(
      `SELECT DISTINCT pp.permissao FROM usuario_papeis up
       JOIN papel_permissoes pp ON pp.papel_id = up.papel_id WHERE up.usuario_id = ?`,
    )
    .bind(linha.uid)
    .all<{ permissao: string }>();

  const { results: emps } = await db
    .prepare('SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ?')
    .bind(linha.uid)
    .all<{ empresa_id: string }>();

  return {
    usuarioId: linha.uid,
    tenantId: linha.tenant_id,
    email: linha.email,
    nome: linha.nome,
    permissoes: new Set(perms.map((p) => p.permissao as Permissao)),
    empresas: emps.length ? new Set(emps.map((e) => e.empresa_id)) : null,
  };
}

// ------------------------------------------------------------------ middleware

app.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/login') return next();

  const sessao = await lerSessao(c.env.DB, c.req.header('Cookie') ?? null, c.env.SESSION_SECRET);
  if (!sessao) return c.json({ erro: 'não autenticado' }, 401);

  c.set('sessao', sessao);
  c.set(
    'repo',
    new Repo(
      c.env.DB,
      {
        sessao,
        ip: c.req.header('CF-Connecting-IP') ?? null,
        requestId: c.req.header('CF-Ray') ?? crypto.randomUUID(),
      } satisfies ContextoRequisicao,
      c.env.AUDIT_SEED,
    ),
  );
  return next();
});

app.onError((err, c) => {
  if (err instanceof SemPermissao) return c.json({ erro: err.message }, 403);
  if (err instanceof ForaDoEscopo) return c.json({ erro: err.message }, 404);
  if (err instanceof ErroParserNFe) return c.json({ erro: err.message }, 422);
  if (err instanceof z.ZodError) return c.json({ erro: 'dados inválidos', detalhe: err.issues }, 400);
  console.error('erro não tratado', err);
  return c.json({ erro: 'erro interno' }, 500);
});

// ------------------------------------------------------------------ login

app.post('/api/login', async (c) => {
  const { email, senha } = z
    .object({ email: z.string().email(), senha: z.string().min(1) })
    .parse(await c.req.json());

  const u = await c.env.DB
    .prepare('SELECT * FROM usuarios WHERE email = ? AND ativo = 1')
    .bind(email.toLowerCase())
    .first<any>();

  // Resposta idêntica para e-mail que existe e que não existe: não entregamos
  // a lista de usuários do escritório para quem estiver testando de fora.
  const generico = { erro: 'e-mail ou senha inválidos' };

  if (!u) {
    await conferirSenha(senha, 'pbkdf2$600000$AAAA$AAAA'); // custo constante
    return c.json(generico, 401);
  }

  if (u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date()) {
    return c.json({ erro: 'conta temporariamente bloqueada por tentativas seguidas' }, 429);
  }

  if (!(await conferirSenha(senha, u.senha_hash))) {
    const falhas = (u.tentativas_falhas ?? 0) + 1;
    const bloqueio = falhas >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await c.env.DB
      .prepare('UPDATE usuarios SET tentativas_falhas = ?, bloqueado_ate = ? WHERE id = ?')
      .bind(falhas, bloqueio, u.id)
      .run();
    return c.json(generico, 401);
  }

  const sessaoId = crypto.randomUUID();
  const expira = new Date(Date.now() + DURACAO_H * 3600_000).toISOString();

  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO sessoes (id, usuario_id, criada_em, expira_em, ip, user_agent, revogada)
         VALUES (?,?,?,?,?,?,0)`,
      )
      .bind(
        sessaoId, u.id, new Date().toISOString(), expira,
        c.req.header('CF-Connecting-IP') ?? null, c.req.header('User-Agent') ?? null,
      ),
    c.env.DB
      .prepare('UPDATE usuarios SET tentativas_falhas = 0, bloqueado_ate = NULL, ultimo_login = ? WHERE id = ?')
      .bind(new Date().toISOString(), u.id),
  ]);

  const valor = `${sessaoId}.${await assinar(sessaoId, c.env.SESSION_SECRET)}`;
  c.header(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(valor)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DURACAO_H * 3600}`,
  );

  return c.json({ ok: true, nome: u.nome, deveTrocarSenha: u.deve_trocar_senha === 1 });
});

app.post('/api/logout', async (c) => {
  const sessao = c.get('sessao');
  await c.env.DB
    .prepare('UPDATE sessoes SET revogada = 1 WHERE usuario_id = ?')
    .bind(sessao.usuarioId)
    .run();
  c.header('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  return c.json({ ok: true });
});

app.get('/api/eu', (c) => {
  const s = c.get('sessao');
  return c.json({
    nome: s.nome,
    email: s.email,
    permissoes: [...s.permissoes],
    campos: TODOS_CAMPOS.map((k) => ({
      chave: k,
      rotulo: CAMPOS[k]!.rotulo,
      tipo: CAMPOS[k]!.tipo,
      escreveNoXml: CAMPOS[k]!.escreveNoXml,
      ajuda: CAMPOS[k]!.ajuda,
    })),
  });
});

// ------------------------------------------------------------------ empresas

app.get('/api/empresas', async (c) => c.json(await c.get('repo').listarEmpresas()));

/** Pré-visualização do que o CNAE sugere, antes de salvar o cadastro. */
app.post('/api/empresas/sugestao', async (c) => {
  exigir(c.get('sessao'), 'empresas.gerenciar');
  const { cnaePrincipal, cnaesSecundarios } = z
    .object({ cnaePrincipal: z.string(), cnaesSecundarios: z.array(z.string()).default([]) })
    .parse(await c.req.json());
  return c.json(analisarCnaes(cnaePrincipal, cnaesSecundarios));
});

app.post('/api/empresas', async (c) => {
  exigir(c.get('sessao'), 'empresas.gerenciar');
  const corpo = z
    .object({
      cnpj: z.string().min(11),
      razaoSocial: z.string().min(2),
      nomeFantasia: z.string().nullish(),
      uf: z.string().length(2).nullish(),
      perfil: z.enum(['revenda', 'industrializacao', 'uso_consumo']),
      regime: z.string().nullish(),
      cnaePrincipal: z.string().nullish(),
      cnaesSecundarios: z.array(z.string()).default([]),
      cfopPadraoDentroUF: z.string().nullish(),
      cfopPadraoForaUF: z.string().nullish(),
      cstEntradaPadrao: z.string().nullish(),
      creditoIcmsPadrao: z.enum(['S', 'N']).nullish(),
      creditoPisPadrao: z.enum(['S', 'N']).nullish(),
      creditoCofinsPadrao: z.enum(['S', 'N']).nullish(),
      observacoes: z.string().nullish(),
    })
    .parse(await c.req.json());

  const id = await c.get('repo').criarEmpresa(corpo);
  return c.json({ id }, 201);
});

app.patch('/api/empresas/:id', async (c) => {
  exigir(c.get('sessao'), 'empresas.gerenciar');
  const mudancas = z.record(z.string().nullable()).parse(await c.req.json());
  await c.get('repo').atualizarEmpresa(c.req.param('id'), mudancas);
  return c.json({ ok: true });
});

app.get('/api/empresas/:id/fornecedores', async (c) =>
  c.json(await c.get('repo').listarFornecedores(c.req.param('id'))),
);

// ------------------------------------------------------------------ importação

app.post('/api/empresas/:id/importar', async (c) => {
  exigir(c.get('sessao'), 'notas.importar');
  const empresaId = c.req.param('id');

  const form = await c.req.formData();

  // Duck typing em vez de `instanceof File`: as definições de tipo do Workers e as do
  // Node discordam sobre o que FormData.getAll devolve, e o que importa aqui é ter
  // nome, tamanho e text().
  type ArquivoEnviado = { name: string; size: number; text(): Promise<string> };
  const ehArquivo = (v: unknown): v is ArquivoEnviado =>
    typeof v === 'object' && v !== null && 'text' in v && 'name' in v;

  const enviados = (form.getAll('arquivos') as unknown[]).filter(ehArquivo);
  if (enviados.length === 0) return c.json({ erro: 'nenhum arquivo enviado' }, 400);
  if (enviados.length > 200) return c.json({ erro: 'máximo de 200 arquivos por vez' }, 400);

  const arquivos: { nome: string; conteudo: string }[] = [];
  for (const f of enviados) {
    if (f.size > 5_000_000) {
      // Não lemos o arquivo: entra no lote como recusado, com motivo.
      arquivos.push({ nome: f.name, conteudo: '' });
      continue;
    }
    arquivos.push({ nome: f.name, conteudo: await f.text() });
  }

  const resultado = await importarArquivos(
    c.get('repo'), c.env.XML_ORIGINAL, empresaId, arquivos, 'upload',
  );
  return c.json(resultado);
});

// ------------------------------------------------------------------ notas e itens

app.get('/api/empresas/:id/notas', async (c) =>
  c.json(
    await c.get('repo').listarNotas(c.req.param('id'), c.req.query('competencia') ?? undefined),
  ),
);

/**
 * A nota com os itens, os alertas de divergência e o resumo do topo da tela.
 *
 * É aqui que "quando não bater, chamar a atenção" vira dado. A tela não decide o que
 * é grave — ela recebe pronto, para que o critério seja um só e esteja testado.
 */
app.get('/api/notas/:id', async (c) => {
  const repo = c.get('repo');
  const r = await repo.obterNotaComItens(c.req.param('id'));
  if (!r) return c.json({ erro: 'nota não encontrada' }, 404);

  const historico = await repo.carregarHistoricoProdutos(
    r.nota.empresa_id, r.nota.emit_cnpj, r.nota.id,
  );

  const idsRegra = r.itens
    .flatMap((i: any) => [i.cfop_origem, i.x_prod_origem])
    .filter((o: string | null) => typeof o === 'string' && o.startsWith('regra:'))
    .map((o: string) => o.slice('regra:'.length));
  const suspeitas = await repo.regrasSuspeitasDe(r.nota.empresa_id, idsRegra);

  const itens = r.itens.map((i: any) => {
    const item = {
      nItem: i.n_item, cProd: i.c_prod, cEAN: i.c_ean, xProd: i.x_prod_original,
      NCM: i.ncm, CEST: i.cest, CFOP: i.cfop_original, uCom: i.unidade,
      qCom: i.quantidade, vUnCom: i.valor_unitario, vProd: i.valor_total,
      cstIcms: i.cst_origem ?? null, temIbsCbs: false,
    };

    const usouRegraSuspeita = [i.cfop_origem, i.x_prod_origem].some(
      (o: string | null) => typeof o === 'string' && o.startsWith('regra:') && suspeitas.has(o.slice(6)),
    );

    const alertas = detectarAlertas(item, {
      historico: historico.get(String(i.c_prod ?? '').trim().toUpperCase()) ?? null,
      cfopEntrada: i.cfop_novo,
      confianca: i.confianca,
      regraSuspeita: usouRegraSuspeita,
    });

    return { ...i, alertas, estilo: estiloDaLinha(i.confianca, alertas) };
  });

  const resumo = resumirNota(
    itens.map((i: any) => ({ confianca: i.confianca, alertas: i.alertas })),
  );

  return c.json({ nota: r.nota, itens, resumo });
});

/**
 * Altera campos de um item e ensina o sistema.
 *
 * `fixar: true` = a contabilidade está dizendo "para esta empresa e este fornecedor é
 * assim, ponto". A regra nasce verde e não é rebaixada por divergência.
 *
 * `escopo: 'fornecedor'` = aplica o padrão a todo o fornecedor, não só a este produto.
 */
app.patch('/api/itens/:id', async (c) => {
  const sessao = c.get('sessao');
  const repo = c.get('repo');

  const corpo = z
    .object({
      mudancas: z.array(z.object({ campo: z.string(), valor: z.string() })).min(1),
      fixar: z.boolean().default(false),
      escopo: z.enum(['item', 'fornecedor']).default('item'),
    })
    .parse(await c.req.json());

  const linha = await c.env.DB
    .prepare(
      `SELECT i.*, n.emit_cnpj, n.emit_uf, n.empresa_id FROM itens i
       JOIN notas n ON n.id = i.nota_id WHERE i.tenant_id = ? AND i.id = ?`,
    )
    .bind(sessao.tenantId, c.req.param('id'))
    .first<any>();
  if (!linha) return c.json({ erro: 'item não encontrado' }, 404);

  const empresa = await repo.obterEmpresa(linha.empresa_id);
  if (!empresa) return c.json({ erro: 'empresa fora do seu acesso' }, 404);

  // valida campo por campo, e confere permissão de cada um
  const validadas: { campo: Campo; valor: string }[] = [];
  for (const m of corpo.mudancas) {
    if (!ehCampoValido(m.campo)) return c.json({ erro: `campo desconhecido: ${m.campo}` }, 400);
    const problema = validarValor(m.campo, m.valor);
    if (problema) return c.json({ erro: `${CAMPOS[m.campo]!.rotulo}: ${problema}` }, 400);
    exigir(sessao, CAMPOS[m.campo]!.permissao as Permissao);
    validadas.push({ campo: m.campo, valor: m.valor });
  }

  const item = {
    nItem: linha.n_item, cProd: linha.c_prod, cEAN: linha.c_ean, xProd: linha.x_prod_original,
    NCM: linha.ncm, CEST: linha.cest, CFOP: linha.cfop_original, uCom: linha.unidade,
    qCom: linha.quantidade, vUnCom: linha.valor_unitario, vProd: linha.valor_total,
    cstIcms: null, temIbsCbs: false,
  };

  const contexto: ContextoNota = {
    perfil: (empresa.perfil ?? 'revenda') as PerfilEmpresa,
    ufEmitente: linha.emit_uf,
    ufDestinatario: empresa.uf,
  };

  const chaves = chavesDoItem(item, linha.emit_cnpj);
  const candidatas = await repo.carregarRegrasCandidatas(empresa.id, chaves);

  // Aplicar a todo o fornecedor = aprender só no nível 5 (padrão do fornecedor).
  const apenasNiveis = corpo.escopo === 'fornecedor' ? ([5] as const).slice() : undefined;

  for (const m of validadas) {
    const sugestaoAnterior = sugerir(m.campo, item, candidatas, contexto);
    await repo.aplicarAprendizado(
      empresa.id,
      aprender({
        item, emitCnpj: linha.emit_cnpj, campo: m.campo, valorFinal: m.valor,
        sugestao: sugestaoAnterior, fixar: corpo.fixar, apenasNiveis: apenasNiveis as any,
      }),
    );
  }

  await repo.alterarItem(
    c.req.param('id'),
    validadas.map((m) => ({ ...m, origem: corpo.fixar ? 'manual:fixada' : 'manual' })),
  );

  return c.json({ ok: true });
});

// ------------------------------------------------------------------ regras

app.get('/api/empresas/:id/regras', async (c) => {
  exigir(c.get('sessao'), 'regras.visualizar');
  return c.json(
    await c.get('repo').listarRegras(c.req.param('id'), {
      suspeitas: c.req.query('suspeitas') === '1',
    }),
  );
});

// ------------------------------------------------------------------ exportação

app.get('/api/notas/:id/xml-corrigido', async (c) => {
  exigir(c.get('sessao'), 'export.gerar');
  const repo = c.get('repo');
  const r = await repo.obterNotaComItens(c.req.param('id'));
  if (!r) return c.json({ erro: 'nota não encontrada' }, 404);

  const obj = await c.env.XML_ORIGINAL.get(r.nota.r2_original);
  if (!obj) return c.json({ erro: 'XML original não encontrado no arquivo' }, 500);
  const original = await obj.text();

  const correcoes = r.itens.map((i: any) => ({
    nItem: i.n_item,
    cfop: i.cfop_novo,
    xProd: i.x_prod_novo,
  }));

  const { xml } = gerarXmlCorrigido(original, correcoes);
  const invariantes = verificarInvariantes(original, xml);
  const falhas = invariantes.filter((i) => !i.ok);

  // Nota corrompida não sai daqui.
  if (falhas.length > 0) {
    return c.json({ erro: 'exportação bloqueada: a nota não passou na validação', falhas }, 422);
  }

  await repo.auditoria().registrar({
    tenantId: repo.contexto.sessao.tenantId,
    usuarioId: repo.contexto.sessao.usuarioId,
    usuarioEmail: repo.contexto.sessao.email,
    acao: 'exportar', entidade: 'nota', entidadeId: r.nota.id,
    valorDepois: `xml corrigido · ${r.itens.length} itens`, origem: 'manual',
    ip: repo.contexto.ip, requestId: repo.contexto.requestId,
  });

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${r.nota.chave}-corrigido.xml"`,
    },
  });
});

/** Dados de escrituração que NÃO vão para o XML (ver src/rules/campos.ts). */
app.get('/api/notas/:id/escrituracao.csv', async (c) => {
  exigir(c.get('sessao'), 'export.gerar');
  const r = await c.get('repo').obterNotaComItens(c.req.param('id'));
  if (!r) return c.json({ erro: 'nota não encontrada' }, 404);

  const cab = [
    'chave', 'item', 'codigo_fornecedor', 'ean', 'ncm', 'descricao_original',
    'descricao_corrigida', 'cfop_original', 'cfop_entrada', 'cst_entrada',
    'conta_contabil', 'credito_icms', 'credito_pis', 'credito_cofins',
    'valor', 'origem_cfop', 'revisado',
  ];
  const linhas = r.itens.map((i: any) =>
    [
      r.nota.chave, i.n_item, i.c_prod, i.c_ean, i.ncm, i.x_prod_original,
      i.x_prod_novo, i.cfop_original, i.cfop_novo, i.cst_entrada, i.conta_contabil,
      i.credito_icms, i.credito_pis, i.credito_cofins, i.valor_total,
      i.cfop_origem, i.revisado === 1 ? 'S' : 'N',
    ]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
      .join(';'),
  );

  return new Response([cab.join(';'), ...linhas].join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${r.nota.chave}-escrituracao.csv"`,
    },
  });
});

app.get('/api/saude', (c) => c.json({ ok: true, ambiente: c.env.AMBIENTE }));

export default app;
