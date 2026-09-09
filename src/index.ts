import { Hono } from 'hono';
import { z } from 'zod';
import { Repo, ForaDoEscopo, type ContextoRequisicao } from './db/repo';
import { Auditoria } from './db/auditoria';
import {
  SemPermissao, exigir, exigirAlguma, resolverPermissoes, permissoesQuePodeConceder,
  PERMISSOES, TODAS_PERMISSOES, type Sessao, type Permissao,
} from './auth/permissoes';
import { conferirSenha, gerarHashSenha, avaliarSenha, HashIncompativel, HASH_INEXISTENTE } from './auth/senha';
import {
  gerarSegredo, conferirTotp, uriDeProvisionamento, segredoLegivel,
} from './auth/totp';
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
  ASSETS: { fetch(req: Request): Promise<Response> };
  SESSION_SECRET: string;
  AUDIT_SEED: string;
  /**
   * Credenciais de teste do ambiente local, no formato `email|senha`.
   *
   * Vive so no .dev.vars, que o wrangler le APENAS em `wrangler dev` e nunca envia
   * no deploy. Em producao so existiria se alguem rodasse `wrangler secret put
   * LOGIN_DEMO` de proposito. Nao amarramos essa trava ao AMBIENTE porque
   * AMBIENTE e "dev" tambem no wrangler.jsonc que vai para producao - uma trava
   * que depende de alguem lembrar de trocar uma string nao e trava.
   */
  LOGIN_DEMO?: string;
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
       , u.deve_trocar_senha
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

  const { results: exc } = await db
    .prepare('SELECT permissao, concedida FROM usuario_permissoes WHERE usuario_id = ?')
    .bind(linha.uid)
    .all<{ permissao: string; concedida: number }>();

  return {
    usuarioId: linha.uid,
    tenantId: linha.tenant_id,
    email: linha.email,
    nome: linha.nome,
    permissoes: resolverPermissoes(perms.map((p) => p.permissao), exc),
    empresas: emps.length ? new Set(emps.map((e) => e.empresa_id)) : null,
    deveTrocarSenha: linha.deve_trocar_senha === 1,
  };
}

// ------------------------------------------------------------------ middleware

app.use('/api/*', async (c, next) => {
  // Sem SESSION_SECRET nao ha como assinar o cookie; sem AUDIT_SEED nao ha primeiro elo
  // da cadeia de auditoria. Faltando qualquer um dos dois, o HMAC estoura la dentro e a
  // API responde "erro interno" - mensagem que nao diz nada a quem esta olhando a tela
  // de login. Foi bug real: .dev.vars esta no .gitignore, entao a maquina que clonou o
  // repositorio nao tinha nenhum dos dois e o login morria sem explicacao.
  const faltando = (['SESSION_SECRET', 'AUDIT_SEED'] as const).filter((k) => !c.env[k]);
  if (faltando.length) {
    return c.json({
      erro: `configuração ausente: ${faltando.join(' e ')}. Em desenvolvimento, rode o `
        + `subir.cmd — ele cria o .dev.vars. Em produção, use npx wrangler secret put.`,
    }, 500);
  }

  // Login e health check ficam fora da exigencia de sessao. O /api/saude protegido
  // foi bug real: o proprio DEPLOY.md manda dar curl nele para conferir se subiu,
  // e ele respondia 401 - sinal de servico no ar lido como servico quebrado.
  // Rotas que existem PARA quem ainda não tem sessão. A segunda etapa do login
  // é a mais fácil de esquecer: ela vem depois da senha e antes da sessão, e
  // exigir sessão nela torna o segundo fator impossível de completar.
  const PUBLICAS = new Set([
    '/api/login', '/api/login/mfa', '/api/saude', '/api/local', '/api/cadastrar',
    '/api/esqueci',
  ]);
  if (PUBLICAS.has(c.req.path)) return next();

  const sessao = await lerSessao(c.env.DB, c.req.header('Cookie') ?? null, c.env.SESSION_SECRET);
  if (!sessao) return c.json({ erro: 'não autenticado' }, 401);

  // Enquanto a troca de senha for obrigatória, a sessão só serve para trocá-la.
  // Antes disso `deve_trocar_senha` era só um aviso para a tela — e uma dica de
  // interface não é uma regra: bastava fechar o modal para usar tudo.
  const LIVRES_NA_TROCA = new Set(['/api/eu', '/api/trocar-senha', '/api/logout', '/api/mfa']);
  if (sessao.deveTrocarSenha && !LIVRES_NA_TROCA.has(c.req.path)) {
    return c.json({ erro: 'troque sua senha antes de continuar', deveTrocarSenha: true }, 403);
  }

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

/**
 * Violação de unicidade tem nome e dono — não é "erro interno".
 *
 * O banco recusa duplicata com uma mensagem que diz exatamente qual: "UNIQUE
 * constraint failed: empresas.tenant_id, empresas.cnpj". Deixar isso virar 500
 * genérico faz o operador ver "erro interno" ao cadastrar um cliente que já
 * existe — e procurar defeito no sistema em vez de olhar a lista.
 *
 * O mapa traduz as colunas para o que a pessoa reconhece. Constraint que não
 * estiver aqui ainda cai numa frase melhor que "erro interno".
 */
const NOMES_UNICOS: [RegExp, string][] = [
  [/empresas\.[^:]*cnpj/i, 'já existe uma empresa cadastrada com este CNPJ'],
  [/usuarios\.[^:]*email|idx_usuarios_email/i, 'já existe um usuário com este e-mail'],
  [/papeis\.[^:]*nome/i, 'já existe um papel com este nome'],
  [/notas\.[^:]*chave/i, 'esta nota já foi importada'],
  [/fornecedores\.[^:]*cnpj/i, 'este fornecedor já está cadastrado para esta empresa'],
];

function traduzirUnicidade(mensagem: string): string | null {
  if (!/UNIQUE constraint failed/i.test(mensagem)) return null;
  for (const [padrao, texto] of NOMES_UNICOS) if (padrao.test(mensagem)) return texto;
  return 'este registro já existe';
}

app.onError((err, c) => {
  const dupe = traduzirUnicidade(err.message ?? '');
  if (dupe) return c.json({ erro: dupe }, 409);

  // Defeito de configuração tem que aparecer como defeito, e não como
  // "senha inválida" — foi assim que o teto de iterações do PBKDF2 no runtime
  // da Cloudflare passou horas se disfarçando de credencial errada.
  if (err instanceof HashIncompativel) {
    console.error('hash incompatível com o runtime', err.message);
    return c.json({ erro: err.message }, 500);
  }
  if (err instanceof SemPermissao) return c.json({ erro: err.message }, 403);
  if (err instanceof ForaDoEscopo) return c.json({ erro: err.message }, 404);
  if (err instanceof ErroParserNFe) return c.json({ erro: err.message }, 422);
  if (err instanceof z.ZodError) return c.json({ erro: 'dados inválidos', detalhe: err.issues }, 400);
  console.error('erro não tratado', err);
  return c.json({ erro: 'erro interno' }, 500);
});

// ------------------------------------------------------------------ login

/* ------------------------------------------------------------------ limite por origem
 *
 * O bloqueio de 5 tentativas é POR CONTA: trava quem insiste numa conta, e não
 * faz nada contra quem tenta uma senha em cem contas — que é como ataque de
 * verdade funciona. Este limite é por ORIGEM e fecha o buraco.
 *
 * 20 falhas em 15 minutos vindas do mesmo IP. Escritório inteiro sai pelo mesmo
 * endereço, então o número precisa caber num dia ruim de gente distraída sem
 * caber numa varredura automatizada.
 */
/** Código de recuperação: hífen e caixa são enfeite; o valor é o miolo. */
const normalizarRecuperacao = (t: string) => (t ?? '').replace(/[\s-]/g, '').toUpperCase();

/** Confere a senha de quem está agindo. Poder que dá acesso à conta alheia não
 *  pode depender só de um cookie aberto numa máquina esquecida. */
async function reautenticar(db: D1Database, usuarioId: string, senha: string): Promise<boolean> {
  const eu = await db
    .prepare('SELECT senha_hash FROM usuarios WHERE id = ?')
    .bind(usuarioId)
    .first<{ senha_hash: string }>();
  return !!eu && (await conferirSenha(senha, eu.senha_hash));
}


const TETO_FALHAS_IP = 20;
const JANELA_MIN = 15;

/**
 * Origem ausente vira uma origem só, compartilhada — nunca "sem limite".
 *
 * `if (!ip) return false` era falha aberta: bastava o cabeçalho não chegar para
 * o teto deixar de existir. Um balde comum é pior para quem cair nele e
 * infinitamente melhor do que nenhum.
 */
const ORIGEM_DESCONHECIDA = '(sem-ip)';

async function origemBloqueada(db: D1Database, ipBruto: string | null): Promise<boolean> {
  const ip = ipBruto || ORIGEM_DESCONHECIDA;
  const desde = new Date(Date.now() - JANELA_MIN * 60_000).toISOString();
  const r = await db
    .prepare('SELECT COUNT(*) AS n FROM tentativas_login WHERE ip = ? AND quando > ? AND sucesso = 0')
    .bind(ip, desde)
    .first<{ n: number }>();
  return (r?.n ?? 0) >= TETO_FALHAS_IP;
}

async function registrarTentativa(db: D1Database, ipBruto: string | null, sucesso: boolean): Promise<void> {
  const ip = ipBruto || ORIGEM_DESCONHECIDA;
  const agora = new Date().toISOString();
  await db.batch([
    db.prepare('INSERT INTO tentativas_login (ip, quando, sucesso) VALUES (?,?,?)')
      .bind(ip, agora, sucesso ? 1 : 0),
    // Faxina oportunista: a tabela só serve para a janela de 15 minutos, e sem
    // isso ela cresce para sempre guardando IP — dado pessoal que não queremos.
    db.prepare("DELETE FROM tentativas_login WHERE quando < ?")
      .bind(new Date(Date.now() - 24 * 3600_000).toISOString()),
  ]);
}

/** Abre a sessão e devolve o cabeçalho do cookie. Um lugar só, usado por todos. */
async function abrirSessao(c: any, u: { id: string }): Promise<void> {
  const sessaoId = crypto.randomUUID();
  const expira = new Date(Date.now() + DURACAO_H * 3600_000).toISOString();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO sessoes (id, usuario_id, criada_em, expira_em, ip, user_agent, revogada)
         VALUES (?,?,?,?,?,?,0)`,
      )
      .bind(sessaoId, u.id, new Date().toISOString(), expira,
        c.req.header('CF-Connecting-IP') ?? null, c.req.header('User-Agent') ?? null),
    c.env.DB
      .prepare('UPDATE usuarios SET tentativas_falhas = 0, bloqueado_ate = NULL, ultimo_login = ? WHERE id = ?')
      .bind(new Date().toISOString(), u.id),
  ]);
  const valor = `${sessaoId}.${await assinar(sessaoId, c.env.SESSION_SECRET)}`;
  c.header(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(valor)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DURACAO_H * 3600}`,
  );
}

/** Hash do código do convite: quem lê o banco não usa convite de ninguém. */
async function hashConvite(codigo: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codigo.trim().toUpperCase()));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function convitePorCodigo(
  db: D1Database, codigo: string,
): Promise<{ id: string; papel_id: string } | null> {
  const c = await db
    .prepare(
      `SELECT id, papel_id FROM convites
        WHERE codigo_hash = ? AND revogado = 0 AND usos < usos_max AND expira_em > ?`,
    )
    .bind(await hashConvite(codigo), new Date().toISOString())
    .first<{ id: string; papel_id: string }>();
  return c ?? null;
}

/**
 * Cadastro público. A conta nasce PENDENTE: existe, tem senha, e não faz nada.
 *
 * Uma tela de criar conta é conveniência para o escritório — a pessoa se
 * cadastra sozinha e escolhe a própria senha, sem ninguém trocar senha
 * provisória por mensagem. O preço é uma porta pública, e ela é fechada em três
 * pontos: a conta nasce sem papel nenhum, o limite por origem vale aqui igual ao
 * login, e a resposta é a mesma para e-mail novo e e-mail que já existe.
 *
 * Esse último ponto é o que evita transformar o cadastro num descobridor de
 * usuários: sem ele, tentar "fulano@alfacontabil.net" e receber "já existe"
 * entrega a lista do escritório para quem quiser montá-la.
 */
app.post('/api/cadastrar', async (c) => {
  const { email, nome, senha, convite } = z
    .object({
      email: z.string().email(),
      nome: z.string().min(2).max(80),
      senha: z.string().min(1),
      convite: z.string().optional(),
    })
    .parse(await c.req.json());

  const ip = c.req.header('CF-Connecting-IP') ?? null;
  if (await origemBloqueada(c.env.DB, ip)) {
    return c.json({ erro: 'muitas tentativas deste computador. Espere alguns minutos.' }, 429);
  }

  const forca = avaliarSenha(senha, email);
  if (!forca.ok) return c.json({ erro: forca.problemas.join('; ') }, 400);

  // Resposta única, dita antes de olhar o banco, para o tempo também não denunciar.
  const resposta = {
    ok: true,
    mensagem: 'Pedido registrado. Um administrador precisa liberar seu acesso — '
      + 'avise alguém do escritório. Você receberá o mesmo aviso se já tiver conta aqui.',
  };

  const jaExiste = await c.env.DB
    .prepare('SELECT id FROM usuarios WHERE lower(email) = ?')
    .bind(email.toLowerCase())
    .first();

  if (jaExiste) {
    // Custo constante: sem isto, "já existe" volta instantâneo e "novo" demora
    // o PBKDF2 — e a diferença de tempo diz o que a mensagem se recusa a dizer.
    await gerarHashSenha(senha);
    await registrarTentativa(c.env.DB, ip, false);
    return c.json(resposta);
  }

  const agora = new Date().toISOString();
  const id = crypto.randomUUID();

  // Com convite válido, a conta já nasce liberada e com o papel do convite.
  // É o que tira o trabalho de aprovar: quem recebeu o link entra e trabalha.
  const conv = convite ? await convitePorCodigo(c.env.DB, convite) : null;

  if (convite && !conv) {
    // Convite errado NÃO cria conta pendente em silêncio: quem digitou um código
    // acha que vai entrar direto, e descobriria só depois que ficou esperando.
    return c.json({ erro: 'convite inválido, expirado ou já usado' }, 400);
  }

  const escritas = [
    c.env.DB
      .prepare(
        `INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, ativo, pendente,
           deve_trocar_senha, criado_em, solicitado_em, aprovado_em, convite_id)
         VALUES (?,?,?,?,?,?,?,0,?,?,?,?)`,
      )
      .bind(id, 'alfa', email.toLowerCase(), nome, await gerarHashSenha(senha),
        conv ? 1 : 0, conv ? 0 : 1, agora, agora, conv ? agora : null, conv?.id ?? null),
  ];
  if (conv) {
    escritas.push(
      c.env.DB.prepare('INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES (?,?)')
        .bind(id, conv.papel_id),
      // Incremento condicional: dois cliques simultâneos no mesmo link não podem
      // gastar o mesmo uso duas vezes.
      c.env.DB.prepare('UPDATE convites SET usos = usos + 1 WHERE id = ? AND usos < usos_max')
        .bind(conv.id),
    );
  }
  await c.env.DB.batch(escritas);

  await registrarTentativa(c.env.DB, ip, !!conv);
  if (conv) {
    return c.json({
      ok: true,
      liberado: true,
      mensagem: 'Conta criada e liberada. Pode entrar com o e-mail e a senha que você escolheu.',
    });
  }
  return c.json(resposta);
});

/**
 * "Esqueci minha senha": registra o pedido para um administrador atender.
 *
 * O caminho clássico manda um link com token para o e-mail. Não temos serviço de
 * envio, e montar um agora seria acrescentar um serviço externo, uma chave a mais
 * para vazar e um domínio a configurar — num escritório onde todo mundo se fala.
 *
 * Aqui o pedido aparece na tela de usuários e o administrador entrega a senha
 * provisória. Menos automático e, por enquanto, mais seguro: não existe link de
 * redefinição circulando por caixa de entrada nenhuma.
 *
 * A resposta é sempre a mesma, exista o e-mail ou não. Um "não encontramos esse
 * e-mail" seria um verificador de contas com convite na tela de login.
 */
app.post('/api/esqueci', async (c) => {
  const { email } = z.object({ email: z.string().email() }).parse(await c.req.json());
  const ip = c.req.header('CF-Connecting-IP') ?? null;
  if (await origemBloqueada(c.env.DB, ip)) {
    return c.json({ erro: 'muitas tentativas deste computador. Espere alguns minutos.' }, 429);
  }

  await c.env.DB
    .prepare(
      `UPDATE usuarios SET senha_solicitada_em = ?
        WHERE lower(email) = ? AND ativo = 1 AND pendente = 0`,
    )
    .bind(new Date().toISOString(), email.toLowerCase())
    .run();

  await registrarTentativa(c.env.DB, ip, false);
  return c.json({
    ok: true,
    mensagem: 'Pedido registrado. Fale com um administrador do escritório: ele vai gerar '
      + 'uma senha provisória para você. Se este e-mail não tiver conta aqui, nada acontece.',
  });
});

app.post('/api/login', async (c) => {
  const { email, senha } = z
    .object({ email: z.string().email(), senha: z.string().min(1) })
    .parse(await c.req.json());

  const ip = c.req.header('CF-Connecting-IP') ?? null;
  if (await origemBloqueada(c.env.DB, ip)) {
    return c.json({
      erro: 'muitas tentativas deste computador. Espere alguns minutos.',
    }, 429);
  }

  // Busca SEM filtrar por `ativo`: conta pendente tem ativo = 0, e filtrar aqui
  // fazia ela cair no caminho de "e-mail não existe" — a pessoa recebia
  // "senha inválida" com a senha certa, e ia procurar o problema na senha.
  // Os três casos são separados abaixo, depois de a senha conferir.
  const u = await c.env.DB
    .prepare('SELECT * FROM usuarios WHERE email = ?')
    .bind(email.toLowerCase())
    .first<any>();

  // Resposta idêntica para e-mail que existe e que não existe: não entregamos
  // a lista de usuários do escritório para quem estiver testando de fora.
  const generico = { erro: 'e-mail ou senha inválidos' };

  if (!u) {
    await conferirSenha(senha, HASH_INEXISTENTE); // custo constante, mesmas iterações
    await registrarTentativa(c.env.DB, ip, false);
    return c.json(generico, 401);
  }

  if (u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date()) {
    // Resposta genérica, e não "conta bloqueada": a mensagem específica dizia a
    // quem sondasse que aquele e-mail EXISTE. Cinco tentativas por endereço
    // reconstruíam a lista de usuários do escritório. O custo em PBKDF2 também
    // é pago aqui, senão a resposta instantânea vira o mesmo oráculo pelo tempo.
    await conferirSenha(senha, HASH_INEXISTENTE);
    await registrarTentativa(c.env.DB, ip, false);
    return c.json(generico, 401);
  }

  if (!(await conferirSenha(senha, u.senha_hash))) {
    const falhas = (u.tentativas_falhas ?? 0) + 1;
    const bloqueio = falhas >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await c.env.DB
      .prepare('UPDATE usuarios SET tentativas_falhas = ?, bloqueado_ate = ? WHERE id = ?')
      .bind(falhas, bloqueio, u.id)
      .run();
    await registrarTentativa(c.env.DB, ip, false);
    return c.json(generico, 401);
  }

  // Conta pendente: só dizemos isso DEPOIS de a senha conferir. Quem acertou a
  // senha é dono da conta e merece saber por que não entra; quem não acertou
  // recebeu a resposta genérica lá em cima e não descobriu nada.
  if (u.pendente === 1) {
    await registrarTentativa(c.env.DB, ip, false);
    return c.json({
      erro: 'sua conta ainda não foi liberada. Peça a um administrador do escritório.',
      pendente: true,
    }, 403);
  }

  // Conta desativada é diferente de pendente: alguém teve acesso e o perdeu.
  // Aqui a resposta volta a ser a genérica — quem foi desligado não precisa de
  // confirmação de que a conta continua existindo, e quem tenta a senha de um
  // ex-funcionário não descobre que ela ainda é válida.
  if (u.ativo !== 1) {
    await registrarTentativa(c.env.DB, ip, false);
    return c.json(generico, 401);
  }

  // Senha certa. Se houver segundo fator, a sessão AINDA NÃO nasce: nasce um
  // desafio de curta duração. Emitir a sessão aqui e "pedir o código depois"
  // seria teatro — o cookie já estaria valendo.
  const mfa = await c.env.DB
    .prepare('SELECT segredo, ativo FROM usuario_mfa WHERE usuario_id = ? AND ativo = 1')
    .bind(u.id)
    .first<{ segredo: string }>();

  if (mfa) {
    const desafio = crypto.randomUUID();
    await c.env.DB
      .prepare(
        `INSERT INTO desafios_mfa (id, usuario_id, expira_em, usado, ip, criado_em)
         VALUES (?,?,?,0,?,?)`,
      )
      .bind(desafio, u.id, new Date(Date.now() + 5 * 60_000).toISOString(),
        ip, new Date().toISOString())
      .run();
    // Emitir desafio NÃO é entrar. Marcar como sucesso zerava o limite por
    // origem para quem já tem a senha — que é exatamente quem sobrou para
    // atacar os seis dígitos.
    await registrarTentativa(c.env.DB, ip, false);
    return c.json({ ok: true, mfaRequerido: true, desafio });
  }

  await abrirSessao(c, u);
  await registrarTentativa(c.env.DB, ip, true);
  return c.json({ ok: true, nome: u.nome, deveTrocarSenha: u.deve_trocar_senha === 1 });
});

/**
 * Segunda etapa: o código do aplicativo, ou um código de recuperação.
 *
 * O desafio vale 5 minutos e uma vez só. Sem ele não há como chegar aqui, então
 * quem roubou só o código de seis dígitos não entra — precisa da senha também.
 */
app.post('/api/login/mfa', async (c) => {
  const { desafio, codigo } = z
    .object({ desafio: z.string().uuid(), codigo: z.string().min(1) })
    .parse(await c.req.json());

  const ip = c.req.header('CF-Connecting-IP') ?? null;
  if (await origemBloqueada(c.env.DB, ip)) {
    return c.json({ erro: 'muitas tentativas deste computador. Espere alguns minutos.' }, 429);
  }

  const d = await c.env.DB
    .prepare('SELECT * FROM desafios_mfa WHERE id = ? AND usado = 0')
    .bind(desafio)
    .first<any>();
  if (!d || new Date(d.expira_em) < new Date()) {
    return c.json({ erro: 'esta tentativa de entrada expirou. Comece de novo.', expirado: true }, 401);
  }

  // Seis dígitos são um milhão de combinações; cinco minutos de tentativas sem
  // conta nenhuma mordem um pedaço perigoso disso. O incremento é condicional
  // para não depender de ler-e-depois-gravar sob concorrência.
  const inc = await c.env.DB
    .prepare('UPDATE desafios_mfa SET tentativas = tentativas + 1 WHERE id = ? AND tentativas < 5')
    .bind(desafio)
    .run();
  if (!inc.meta.changes) {
    await c.env.DB.prepare('UPDATE desafios_mfa SET usado = 1 WHERE id = ?').bind(desafio).run();
    await registrarTentativa(c.env.DB, ip, false);
    return c.json({ erro: 'tentativas demais. Comece de novo.', expirado: true }, 401);
  }

  const u = await c.env.DB
    .prepare('SELECT id, nome, deve_trocar_senha FROM usuarios WHERE id = ? AND ativo = 1')
    .bind(d.usuario_id)
    .first<any>();
  if (!u) return c.json({ erro: 'usuário indisponível' }, 401);

  const mfa = await c.env.DB
    .prepare('SELECT segredo, ultimo_contador FROM usuario_mfa WHERE usuario_id = ? AND ativo = 1')
    .bind(u.id)
    .first<{ segredo: string; ultimo_contador: number | null }>();
  if (!mfa) return c.json({ erro: 'segundo fator não configurado' }, 400);

  const contador = await conferirTotp(mfa.segredo, codigo);

  if (contador !== null) {
    // Mesmo código, duas vezes, não. Quem espiou a tela por cima do ombro tem
    // 30 segundos de janela; sem esta trava, tem 30 segundos de conta.
    // Escrita condicional, não "ler, comparar, gravar": duas requisições
    // paralelas com o mesmo código liam o mesmo valor antigo e as duas entravam.
    // Aqui só uma consegue avançar o contador, e quem não conseguir é recusado.
    const avancou = await c.env.DB
      .prepare(
        `UPDATE usuario_mfa SET ultimo_contador = ?
          WHERE usuario_id = ? AND (ultimo_contador IS NULL OR ultimo_contador < ?)`,
      )
      .bind(contador, u.id, contador).run();
    if (!avancou.meta.changes) {
      await registrarTentativa(c.env.DB, ip, false);
      return c.json({ erro: 'este código já foi usado. Espere o próximo.' }, 401);
    }
  } else {
    // Não é código do aplicativo. Pode ser um de recuperação — celular perdido
    // não pode significar conta perdida.
    const candidatos = await c.env.DB
      .prepare('SELECT id, codigo_hash FROM mfa_recuperacao WHERE usuario_id = ? AND usado_em IS NULL')
      .bind(u.id)
      .all<{ id: string; codigo_hash: string }>();

    let usado: string | null = null;
    const limpo = normalizarRecuperacao(codigo);
    for (const cand of candidatos.results) {
      if (await conferirSenha(limpo, cand.codigo_hash)) { usado = cand.id; break; }
    }
    if (!usado) {
      await registrarTentativa(c.env.DB, ip, false);
      return c.json({ erro: 'código inválido' }, 401);
    }
    // Também condicional: dois POSTs simultâneos com o mesmo código encontravam
    // `usado_em IS NULL` e ambos entravam.
    const gastou = await c.env.DB
      .prepare('UPDATE mfa_recuperacao SET usado_em = ? WHERE id = ? AND usado_em IS NULL')
      .bind(new Date().toISOString(), usado).run();
    if (!gastou.meta.changes) {
      await registrarTentativa(c.env.DB, ip, false);
      return c.json({ erro: 'código inválido' }, 401);
    }
  }

  await c.env.DB.prepare('UPDATE desafios_mfa SET usado = 1 WHERE id = ?').bind(desafio).run();
  await abrirSessao(c, u);
  await registrarTentativa(c.env.DB, ip, true);
  return c.json({ ok: true, nome: u.nome, deveTrocarSenha: u.deve_trocar_senha === 1 });
});

/**
 * Troca de senha pelo próprio usuário.
 *
 * Faltava, e a falta apareceu do pior jeito: no primeiro acesso em produção a
 * senha do admin tinha sido digitada às cegas, sem confirmação, e a única saída
 * era um script na máquina de quem publicou. Um sistema que várias pessoas vão
 * usar não pode depender disso.
 *
 * Três decisões:
 *  - exige a senha ATUAL. Sem isso, uma sessão roubada vira conta roubada.
 *  - revoga todas as sessões e abre uma nova para quem trocou. Trocar senha é o
 *    que se faz quando se desconfia de alguém dentro da conta; deixar as outras
 *    sessões de pé anularia o gesto.
 *  - fica na trilha de auditoria — sem o valor, claro, só o fato.
 */
app.post('/api/trocar-senha', async (c) => {
  const sessao = c.get('sessao');
  const { senhaAtual, senhaNova } = z
    .object({ senhaAtual: z.string().min(1), senhaNova: z.string().min(1) })
    .parse(await c.req.json());

  const u = await c.env.DB
    .prepare('SELECT id, senha_hash FROM usuarios WHERE id = ? AND ativo = 1')
    .bind(sessao.usuarioId)
    .first<{ id: string; senha_hash: string }>();
  if (!u) return c.json({ erro: 'usuário não encontrado' }, 404);

  if (!(await conferirSenha(senhaAtual, u.senha_hash))) {
    return c.json({ erro: 'a senha atual não confere' }, 400);
  }
  if (senhaNova === senhaAtual) {
    return c.json({ erro: 'a senha nova é igual à atual' }, 400);
  }

  const forca = avaliarSenha(senhaNova, sessao.email);
  if (!forca.ok) return c.json({ erro: forca.problemas.join('; ') }, 400);

  const agora = new Date().toISOString();
  const sessaoId = crypto.randomUUID();
  const expira = new Date(Date.now() + DURACAO_H * 3600_000).toISOString();

  await c.env.DB.batch([
    c.env.DB
      .prepare('UPDATE usuarios SET senha_hash = ?, deve_trocar_senha = 0, tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = ?')
      .bind(await gerarHashSenha(senhaNova), u.id),
    // Todas as sessões caem, inclusive a de quem está trocando...
    c.env.DB.prepare('UPDATE sessoes SET revogada = 1 WHERE usuario_id = ?').bind(u.id),
    // ...e uma nova nasce aqui, para quem trocou não ser expulso da própria tela.
    c.env.DB
      .prepare(
        `INSERT INTO sessoes (id, usuario_id, criada_em, expira_em, ip, user_agent, revogada)
         VALUES (?,?,?,?,?,?,0)`,
      )
      .bind(sessaoId, u.id, agora, expira,
        c.req.header('CF-Connecting-IP') ?? null, c.req.header('User-Agent') ?? null),
  ]);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: sessao.tenantId,
    usuarioId: sessao.usuarioId,
    usuarioEmail: sessao.email,
    acao: 'alterar',
    entidade: 'usuario',
    entidadeId: u.id,
    campo: 'senha',
    // Nem o valor antigo nem o novo entram na trilha. O que importa é o fato.
    valorAntes: null,
    valorDepois: null,
    origem: 'manual',
    ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });

  const valor = `${sessaoId}.${await assinar(sessaoId, c.env.SESSION_SECRET)}`;
  c.header(
    'Set-Cookie',
    `${COOKIE}=${encodeURIComponent(valor)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${DURACAO_H * 3600}`,
  );
  return c.json({ ok: true, sessoesEncerradas: true });
});

/* ------------------------------------------------------------------ segundo fator
 *
 * Três rotas, todas autenticadas: ver o estado, ligar, desligar. Ligar tem dois
 * passos de propósito — gerar o segredo e CONFIRMAR com um código de verdade.
 * Sem a confirmação, um erro na leitura do QR só apareceria no próximo login,
 * com a pessoa já trancada para fora.
 */
app.get('/api/mfa', async (c) => {
  const s = c.get('sessao');
  const m = await c.env.DB
    .prepare('SELECT ativo, confirmado_em FROM usuario_mfa WHERE usuario_id = ?')
    .bind(s.usuarioId)
    .first<{ ativo: number; confirmado_em: string | null }>();
  const rec = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM mfa_recuperacao WHERE usuario_id = ? AND usado_em IS NULL')
    .bind(s.usuarioId)
    .first<{ n: number }>();
  return c.json({
    ativo: m?.ativo === 1,
    confirmadoEm: m?.confirmado_em ?? null,
    codigosRestantes: rec?.n ?? 0,
  });
});

app.post('/api/mfa/iniciar', async (c) => {
  const s = c.get('sessao');
  const jaAtivo = await c.env.DB
    .prepare('SELECT ativo FROM usuario_mfa WHERE usuario_id = ? AND ativo = 1')
    .bind(s.usuarioId).first();
  if (jaAtivo) return c.json({ erro: 'o segundo fator já está ligado' }, 400);

  const segredo = gerarSegredo();
  await c.env.DB
    .prepare(
      `INSERT INTO usuario_mfa (usuario_id, segredo, ativo, criado_em) VALUES (?,?,0,?)
       ON CONFLICT(usuario_id) DO UPDATE SET segredo = excluded.segredo, ativo = 0,
         ultimo_contador = NULL, confirmado_em = NULL`,
    )
    .bind(s.usuarioId, segredo, new Date().toISOString())
    .run();

  return c.json({
    segredo,
    segredoLegivel: segredoLegivel(segredo),
    uri: uriDeProvisionamento(segredo, s.email),
  });
});

app.post('/api/mfa/confirmar', async (c) => {
  const s = c.get('sessao');
  const { codigo } = z.object({ codigo: z.string().min(1) }).parse(await c.req.json());

  // `ativo = 0` é a trava que faltava, e a falta era grave: com o MFA JÁ ligado,
  // quem tivesse a sessão e um único código de seis dígitos — o mesmo que a
  // vítima acabou de digitar no login, dentro da janela de 60s — chamava esta
  // rota direto e recebia oito códigos de recuperação novos. Bypass permanente
  // do segundo fator, e de quebra os códigos que a pessoa guardou eram apagados.
  const m = await c.env.DB
    .prepare('SELECT segredo FROM usuario_mfa WHERE usuario_id = ? AND ativo = 0')
    .bind(s.usuarioId).first<{ segredo: string }>();
  if (!m) {
    return c.json({
      erro: 'não há ativação pendente. Para gerar códigos novos, desligue e ligue de novo.',
    }, 400);
  }

  const contador = await conferirTotp(m.segredo, codigo);
  if (contador === null) {
    return c.json({
      erro: 'código não confere. Confira se o relógio do celular está certo.',
    }, 400);
  }

  // Códigos de recuperação: a saída para celular perdido. Aparecem UMA vez.
  // Sem 0/O e 1/I no alfabeto: quem copia à mão confunde, e o preço do engano é
  // ficar trancado para fora justamente no dia em que precisou do código.
  const ALFABETO_REC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  // A MESMA normalização dos dois lados. O hífen existe só para leitura humana;
  // guardar o hash com ele e conferir sem ele fazia todo código de recuperação
  // ser recusado — e isso só apareceria no dia em que alguém perdesse o celular.
  const codigos = Array.from({ length: 8 }, () => {
    const b = crypto.getRandomValues(new Uint8Array(10));
    const t = [...b].map((x) => ALFABETO_REC[x % ALFABETO_REC.length]).join('');
    return `${t.slice(0, 5)}-${t.slice(5)}`;   // 10 caracteres, ~50 bits
  });

  const agora = new Date().toISOString();
  const linhas = [];
  for (const cod of codigos) {
    linhas.push(
      c.env.DB
        .prepare('INSERT INTO mfa_recuperacao (id, usuario_id, codigo_hash, criado_em) VALUES (?,?,?,?)')
        .bind(crypto.randomUUID(), s.usuarioId, await gerarHashSenha(normalizarRecuperacao(cod)), agora),
    );
  }
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM mfa_recuperacao WHERE usuario_id = ?').bind(s.usuarioId),
    c.env.DB
      .prepare('UPDATE usuario_mfa SET ativo = 1, confirmado_em = ?, ultimo_contador = ? WHERE usuario_id = ?')
      .bind(agora, contador, s.usuarioId),
    ...linhas,
  ]);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'alterar', entidade: 'usuario', entidadeId: s.usuarioId,
    campo: 'mfa', valorAntes: 'desligado', valorDepois: 'ligado',
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });

  return c.json({ ok: true, codigosRecuperacao: codigos });
});

app.post('/api/mfa/desativar', async (c) => {
  const s = c.get('sessao');
  const { senha, codigo } = z
    .object({ senha: z.string().min(1), codigo: z.string().min(1) })
    .parse(await c.req.json());

  // Senha E código: desligar a proteção exige provar as duas coisas que ela
  // protege. Uma sessão esquecida aberta num computador não basta.
  const u = await c.env.DB
    .prepare('SELECT senha_hash FROM usuarios WHERE id = ?')
    .bind(s.usuarioId).first<{ senha_hash: string }>();
  if (!u || !(await conferirSenha(senha, u.senha_hash))) {
    return c.json({ erro: 'a senha não confere' }, 400);
  }
  const m = await c.env.DB
    .prepare('SELECT segredo, ultimo_contador FROM usuario_mfa WHERE usuario_id = ? AND ativo = 1')
    .bind(s.usuarioId).first<{ segredo: string; ultimo_contador: number | null }>();
  if (!m) return c.json({ erro: 'o segundo fator não está ligado' }, 400);
  const cont = await conferirTotp(m.segredo, codigo);
  if (cont === null) return c.json({ erro: 'código não confere' }, 400);
  // O mesmo código não pode entrar E desligar a proteção. Sem esta condição,
  // o código gasto no login servia para desativar o segundo fator em seguida.
  const avancou = await c.env.DB
    .prepare(
      `UPDATE usuario_mfa SET ultimo_contador = ?
        WHERE usuario_id = ? AND (ultimo_contador IS NULL OR ultimo_contador < ?)`,
    )
    .bind(cont, s.usuarioId, cont).run();
  if (!avancou.meta.changes) {
    return c.json({ erro: 'este código já foi usado. Espere o próximo.' }, 400);
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM usuario_mfa WHERE usuario_id = ?').bind(s.usuarioId),
    c.env.DB.prepare('DELETE FROM mfa_recuperacao WHERE usuario_id = ?').bind(s.usuarioId),
  ]);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'alterar', entidade: 'usuario', entidadeId: s.usuarioId,
    campo: 'mfa', valorAntes: 'ligado', valorDepois: 'desligado',
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });
  return c.json({ ok: true });
});

/**
 * O administrador redefine a senha de outra pessoa.
 *
 * Sem isto, quem esquece a senha depende de alguém rodar script na máquina de
 * quem publicou — que foi exatamente o buraco que apareceu no primeiro acesso
 * em produção. Não é "recuperação por e-mail" (isso exige serviço de envio, que
 * ainda não temos); é o caminho que um escritório usa de verdade: a pessoa fala
 * com o administrador.
 *
 * Consequências deliberadas: todas as sessões da pessoa caem, ela é obrigada a
 * trocar a senha no próximo login, e o ato fica na trilha com o nome de quem fez.
 */
/* ------------------------------------------------------------------ administração
 *
 * O admin cria a conta, escolhe o papel, recorta as empresas e, se precisar,
 * marca exceções para aquela pessoa. Não existe cadastro público: ninguém entra
 * sem passar por alguém — e não há porta aberta para atacar.
 */

/** O catálogo, agrupado, para a tela montar as caixinhas. */
app.get('/api/permissoes', async (c) => {
  const s = c.get('sessao');
  exigirAlguma(s, ['usuarios.visualizar', 'papeis.gerenciar']);
  const grupos: Record<string, { chave: string; descricao: string; podeConceder: boolean }[]> = {};
  const minhas = new Set(permissoesQuePodeConceder(s));
  for (const chave of TODAS_PERMISSOES) {
    const info = PERMISSOES[chave];
    (grupos[info.grupo] ??= []).push({
      chave,
      descricao: info.descricao,
      // Quem não tem a permissão não pode dá-la a ninguém — nem a si mesmo.
      podeConceder: minhas.has(chave),
    });
  }
  return c.json(grupos);
});

app.get('/api/papeis', async (c) => {
  const s = c.get('sessao');
  exigirAlguma(s, ['usuarios.visualizar', 'papeis.gerenciar']);
  const { results } = await c.env.DB
    .prepare(
      `SELECT p.id, p.nome, p.descricao, p.sistema,
              (SELECT COUNT(*) FROM papel_permissoes pp WHERE pp.papel_id = p.id) AS n_permissoes,
              (SELECT COUNT(*) FROM usuario_papeis up WHERE up.papel_id = p.id)   AS n_usuarios
         FROM papeis p WHERE p.tenant_id = ? ORDER BY p.sistema DESC, p.nome`,
    )
    .bind(s.tenantId)
    .all<any>();

  const { results: perms } = await c.env.DB
    .prepare(
      `SELECT pp.papel_id, pp.permissao FROM papel_permissoes pp
         JOIN papeis p ON p.id = pp.papel_id WHERE p.tenant_id = ?`,
    )
    .bind(s.tenantId)
    .all<{ papel_id: string; permissao: string }>();

  return c.json(results.map((p) => ({
    ...p,
    sistema: p.sistema === 1,
    permissoes: perms.filter((x) => x.papel_id === p.id).map((x) => x.permissao),
  })));
});

/** Cria ou atualiza um papel. O corpo traz a lista completa de permissões. */
async function gravarPapel(c: any, id: string | null): Promise<Response> {
  const db: D1Database = c.env.DB;
  const s = c.get('sessao');
  exigir(s, 'papeis.gerenciar');
  const corpo = z
    .object({
      nome: z.string().min(2).max(40),
      descricao: z.string().max(200).nullish(),
      permissoes: z.array(z.string()),
    })
    .parse(await c.req.json());

  // Ninguém concede o que não tem. Sem esta trava, quem edita papéis marca
  // todas as caixinhas do próprio papel e vira administrador — o que faria de
  // `papeis.gerenciar` a única permissão que importa no sistema inteiro.
  const permitidas = new Set(permissoesQuePodeConceder(s));
  const excedentes = corpo.permissoes.filter((p) => !permitidas.has(p as Permissao));
  if (excedentes.length) {
    return c.json({
      erro: `você não pode conceder permissões que não possui: ${excedentes.join(', ')}`,
    }, 403);
  }

  const papelId = id ?? crypto.randomUUID();
  if (id) {
    const atual = await db
      .prepare('SELECT sistema FROM papeis WHERE id = ? AND tenant_id = ?')
      .bind(id, s.tenantId).first<{ sistema: number }>();
    if (!atual) return c.json({ erro: 'papel não encontrado' }, 404);
    // O papel Admin é intocável: mexer nele é o jeito mais rápido de o
    // escritório se trancar para fora do próprio sistema.
    if (atual.sistema === 1) return c.json({ erro: 'o papel Admin não pode ser alterado' }, 400);
  }

  const escritas = [
    id
      ? c.env.DB.prepare('UPDATE papeis SET nome = ?, descricao = ? WHERE id = ? AND tenant_id = ?')
        .bind(corpo.nome, corpo.descricao ?? null, id, s.tenantId)
      : c.env.DB.prepare('INSERT INTO papeis (id, tenant_id, nome, descricao, sistema) VALUES (?,?,?,?,0)')
        .bind(papelId, s.tenantId, corpo.nome, corpo.descricao ?? null),
    c.env.DB.prepare('DELETE FROM papel_permissoes WHERE papel_id = ?').bind(papelId),
    ...corpo.permissoes.map((p) =>
      c.env.DB.prepare('INSERT INTO papel_permissoes (papel_id, permissao) VALUES (?,?)')
        .bind(papelId, p)),
  ];
  await c.env.DB.batch(escritas);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: id ? 'alterar' : 'criar', entidade: 'papel', entidadeId: papelId,
    campo: 'permissoes', valorAntes: null, valorDepois: corpo.permissoes.join(','),
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });
  return c.json({ id: papelId, ok: true });
}

app.post('/api/papeis', (c) => gravarPapel(c, null));
app.put('/api/papeis/:id', (c) => gravarPapel(c, c.req.param('id')));

app.delete('/api/papeis/:id', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'papeis.gerenciar');
  const id = c.req.param('id');
  const p = await c.env.DB
    .prepare('SELECT sistema FROM papeis WHERE id = ? AND tenant_id = ?')
    .bind(id, s.tenantId).first<{ sistema: number }>();
  if (!p) return c.json({ erro: 'papel não encontrado' }, 404);
  if (p.sistema === 1) return c.json({ erro: 'o papel Admin não pode ser apagado' }, 400);

  const emUso = await c.env.DB
    .prepare('SELECT COUNT(*) AS n FROM usuario_papeis WHERE papel_id = ?')
    .bind(id).first<{ n: number }>();
  if ((emUso?.n ?? 0) > 0) {
    return c.json({ erro: `este papel está em uso por ${emUso!.n} usuário(s)` }, 400);
  }
  await c.env.DB.prepare('DELETE FROM papeis WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.get('/api/usuarios', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.visualizar');
  const { results } = await c.env.DB
    .prepare(
      `SELECT u.id, u.email, u.nome, u.ativo, u.pendente, u.solicitado_em, u.senha_solicitada_em,
              u.ultimo_login, u.criado_em, u.deve_trocar_senha,
              (SELECT p.nome FROM usuario_papeis up JOIN papeis p ON p.id = up.papel_id
                WHERE up.usuario_id = u.id LIMIT 1) AS papel,
              (SELECT up.papel_id FROM usuario_papeis up WHERE up.usuario_id = u.id LIMIT 1) AS papel_id,
              (SELECT COUNT(*) FROM usuario_mfa m WHERE m.usuario_id = u.id AND m.ativo = 1) AS mfa,
              (SELECT COUNT(*) FROM usuario_permissoes e WHERE e.usuario_id = u.id) AS excecoes
         FROM usuarios u WHERE u.tenant_id = ?
         ORDER BY u.pendente DESC, (u.senha_solicitada_em IS NOT NULL) DESC, u.ativo DESC, u.nome`,
    )
    .bind(s.tenantId)
    .all<any>();
  return c.json(results.map((u) => ({
    ...u, ativo: u.ativo === 1, pendente: u.pendente === 1,
    pediuSenha: !!u.senha_solicitada_em,
    mfa: u.mfa === 1, deveTrocarSenha: u.deve_trocar_senha === 1,
  })));
});

app.get('/api/usuarios/:id', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.visualizar');
  const id = c.req.param('id');
  const u = await c.env.DB
    .prepare('SELECT id, email, nome, ativo FROM usuarios WHERE id = ? AND tenant_id = ?')
    .bind(id, s.tenantId).first<any>();
  if (!u) return c.json({ erro: 'usuário não encontrado' }, 404);
  const { results: papeis } = await c.env.DB
    .prepare('SELECT papel_id FROM usuario_papeis WHERE usuario_id = ?').bind(id).all<any>();
  const { results: empresas } = await c.env.DB
    .prepare('SELECT empresa_id FROM usuario_empresas WHERE usuario_id = ?').bind(id).all<any>();
  const { results: excecoes } = await c.env.DB
    .prepare('SELECT permissao, concedida FROM usuario_permissoes WHERE usuario_id = ?').bind(id).all<any>();
  return c.json({
    ...u, ativo: u.ativo === 1,
    papelId: papeis[0]?.papel_id ?? null,
    empresas: empresas.map((e: any) => e.empresa_id),
    excecoes: excecoes.map((e: any) => ({ permissao: e.permissao, concedida: e.concedida === 1 })),
  });
});

app.post('/api/usuarios', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.criar');
  const corpo = z
    .object({
      email: z.string().email(),
      nome: z.string().min(2),
      papelId: z.string().min(1),
      empresas: z.array(z.string()).default([]),
      excecoes: z.array(z.object({ permissao: z.string(), concedida: z.boolean() })).default([]),
    })
    .parse(await c.req.json());

  const permitidas = new Set(permissoesQuePodeConceder(s));
  const excedentes = corpo.excecoes
    .filter((e) => e.concedida && !permitidas.has(e.permissao as Permissao))
    .map((e) => e.permissao);
  if (excedentes.length) {
    return c.json({ erro: `você não pode conceder: ${excedentes.join(', ')}` }, 403);
  }

  const email = corpo.email.toLowerCase();
  const jaTem = await c.env.DB
    .prepare('SELECT id FROM usuarios WHERE lower(email) = ?').bind(email).first();
  if (jaTem) return c.json({ erro: 'já existe um usuário com este e-mail' }, 400);

  // Senha provisória gerada aqui e mostrada UMA vez a quem criou. A pessoa é
  // obrigada a trocá-la no primeiro acesso — o admin não fica sabendo a senha
  // definitiva de ninguém, o que é o ponto.
  const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const provisoria = [...bytes].map((b) => ALFABETO[b % ALFABETO.length]).join('');

  const id = crypto.randomUUID();
  const agora = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `INSERT INTO usuarios (id, tenant_id, email, nome, senha_hash, deve_trocar_senha,
           ativo, criado_em, criado_por) VALUES (?,?,?,?,?,1,1,?,?)`,
      )
      .bind(id, s.tenantId, email, corpo.nome, await gerarHashSenha(provisoria), agora, s.usuarioId),
    c.env.DB.prepare('INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES (?,?)')
      .bind(id, corpo.papelId),
    ...corpo.empresas.map((e) =>
      c.env.DB.prepare('INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES (?,?)').bind(id, e)),
    ...corpo.excecoes.map((e) =>
      c.env.DB
        .prepare(
          `INSERT INTO usuario_permissoes (usuario_id, permissao, concedida, definida_em, definida_por)
           VALUES (?,?,?,?,?)`,
        )
        .bind(id, e.permissao, e.concedida ? 1 : 0, agora, s.usuarioId)),
  ]);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'criar', entidade: 'usuario', entidadeId: id,
    campo: 'papel', valorAntes: null, valorDepois: corpo.papelId,
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });

  return c.json({ id, email, senhaProvisoria: provisoria }, 201);
});

app.put('/api/usuarios/:id', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.editar');
  const id = c.req.param('id');
  const corpo = z
    .object({
      nome: z.string().min(2),
      papelId: z.string().min(1),
      empresas: z.array(z.string()).default([]),
      excecoes: z.array(z.object({ permissao: z.string(), concedida: z.boolean() })).default([]),
    })
    .parse(await c.req.json());

  const permitidas = new Set(permissoesQuePodeConceder(s));
  const excedentes = corpo.excecoes
    .filter((e) => e.concedida && !permitidas.has(e.permissao as Permissao))
    .map((e) => e.permissao);
  if (excedentes.length) {
    return c.json({ erro: `você não pode conceder: ${excedentes.join(', ')}` }, 403);
  }

  const u = await c.env.DB
    .prepare('SELECT id FROM usuarios WHERE id = ? AND tenant_id = ?')
    .bind(id, s.tenantId).first();
  if (!u) return c.json({ erro: 'usuário não encontrado' }, 404);

  const agora = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE usuarios SET nome = ? WHERE id = ?').bind(corpo.nome, id),
    c.env.DB.prepare('DELETE FROM usuario_papeis WHERE usuario_id = ?').bind(id),
    c.env.DB.prepare('INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES (?,?)').bind(id, corpo.papelId),
    c.env.DB.prepare('DELETE FROM usuario_empresas WHERE usuario_id = ?').bind(id),
    ...corpo.empresas.map((e) =>
      c.env.DB.prepare('INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES (?,?)').bind(id, e)),
    c.env.DB.prepare('DELETE FROM usuario_permissoes WHERE usuario_id = ?').bind(id),
    ...corpo.excecoes.map((e) =>
      c.env.DB
        .prepare(
          `INSERT INTO usuario_permissoes (usuario_id, permissao, concedida, definida_em, definida_por)
           VALUES (?,?,?,?,?)`,
        )
        .bind(id, e.permissao, e.concedida ? 1 : 0, agora, s.usuarioId)),
    // Permissão que muda tem de valer AGORA. Deixar a sessão viva com o poder
    // antigo faria "tirei o acesso dele" ser mentira por até 12 horas.
    c.env.DB.prepare('UPDATE sessoes SET revogada = 1 WHERE usuario_id = ?').bind(id),
  ]);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'alterar', entidade: 'usuario', entidadeId: id,
    campo: 'permissoes', valorAntes: null,
    valorDepois: `papel=${corpo.papelId}; excecoes=${corpo.excecoes.map((e) => `${e.concedida ? '+' : '-'}${e.permissao}`).join(',')}`,
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });
  return c.json({ ok: true });
});

/**
 * Gera um convite. O código aparece UMA vez, para quem gerou.
 *
 * Resolve o "não quero ter trabalho de aprovar" sem apostar em quem chega
 * primeiro: o poder segue quem recebeu o link, não o relógio.
 */
app.post('/api/convites', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.convidar');
  const { papelId, usos, horas } = z
    .object({
      papelId: z.string().min(1),
      usos: z.number().int().min(1).max(50).default(1),
      horas: z.number().int().min(1).max(720).default(72),
    })
    .parse(await c.req.json());

  // Não se convida para um papel mais poderoso do que o seu.
  const papel = await c.env.DB
    .prepare(
      `SELECT p.id, p.nome, (SELECT COUNT(*) FROM papel_permissoes pp
          WHERE pp.papel_id = p.id AND pp.permissao NOT IN (
            SELECT permissao FROM papel_permissoes q
             JOIN usuario_papeis up ON up.papel_id = q.papel_id
            WHERE up.usuario_id = ?)) AS acima
         FROM papeis p WHERE p.id = ? AND p.tenant_id = ?`,
    )
    .bind(s.usuarioId, papelId, s.tenantId)
    .first<{ id: string; nome: string; acima: number }>();
  if (!papel) return c.json({ erro: 'papel não encontrado' }, 404);
  if (papel.acima > 0) {
    return c.json({ erro: 'este papel tem permissões que você não possui' }, 403);
  }

  // Sem 0/O e 1/I: o código vai ser lido e digitado por gente.
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const bruto = [...bytes].map((b) => A[b % A.length]).join('');
  const codigo = `${bruto.slice(0, 4)}-${bruto.slice(4, 8)}-${bruto.slice(8)}`;

  const id = crypto.randomUUID();
  await c.env.DB
    .prepare(
      `INSERT INTO convites (id, tenant_id, codigo_hash, papel_id, usos_max, usos,
         expira_em, criado_por, criado_em, revogado)
       VALUES (?,?,?,?,?,0,?,?,?,0)`,
    )
    .bind(id, s.tenantId, await hashConvite(codigo), papelId, usos,
      new Date(Date.now() + horas * 3600_000).toISOString(), s.usuarioId,
      new Date().toISOString())
    .run();

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'criar', entidade: 'convite', entidadeId: id,
    campo: 'papel', valorAntes: null, valorDepois: `${papel.nome} · ${usos} uso(s) · ${horas}h`,
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });

  return c.json({ codigo, papel: papel.nome, usos, horas }, 201);
});

app.get('/api/convites', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.convidar');
  const { results } = await c.env.DB
    .prepare(
      `SELECT c.id, c.usos, c.usos_max, c.expira_em, c.revogado, p.nome AS papel
         FROM convites c JOIN papeis p ON p.id = c.papel_id
        WHERE c.tenant_id = ? ORDER BY c.criado_em DESC LIMIT 30`,
    )
    .bind(s.tenantId)
    .all<any>();
  // O código não volta nunca: só o hash existe no banco. Convite perdido se gera
  // de novo, não se recupera.
  return c.json(results.map((r) => ({
    ...r,
    revogado: r.revogado === 1,
    vencido: new Date(r.expira_em) < new Date(),
  })));
});

app.delete('/api/convites/:id', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.convidar');
  await c.env.DB
    .prepare('UPDATE convites SET revogado = 1 WHERE id = ? AND tenant_id = ?')
    .bind(c.req.param('id'), s.tenantId)
    .run();
  return c.json({ ok: true });
});

app.post('/api/usuarios/:id/aprovar', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.aprovar');
  const id = c.req.param('id');
  const corpo = z
    .object({
      papelId: z.string().min(1),
      empresas: z.array(z.string()).default([]),
      excecoes: z.array(z.object({ permissao: z.string(), concedida: z.boolean() })).default([]),
    })
    .parse(await c.req.json());

  const permitidas = new Set(permissoesQuePodeConceder(s));
  const excedentes = corpo.excecoes
    .filter((e) => e.concedida && !permitidas.has(e.permissao as Permissao))
    .map((e) => e.permissao);
  if (excedentes.length) {
    return c.json({ erro: `você não pode conceder: ${excedentes.join(', ')}` }, 403);
  }
  // Aprovar dá um papel a alguém; conceder um papel que você não tem seria a
  // mesma escalada de privilégio pela porta de trás.
  const papel = await c.env.DB
    .prepare(
      `SELECT p.id, (SELECT COUNT(*) FROM papel_permissoes pp
          WHERE pp.papel_id = p.id AND pp.permissao NOT IN (
            SELECT permissao FROM papel_permissoes q
             JOIN usuario_papeis up ON up.papel_id = q.papel_id
            WHERE up.usuario_id = ?)) AS acima
         FROM papeis p WHERE p.id = ? AND p.tenant_id = ?`,
    )
    .bind(s.usuarioId, corpo.papelId, s.tenantId)
    .first<{ id: string; acima: number }>();
  if (!papel) return c.json({ erro: 'papel não encontrado' }, 404);
  if (papel.acima > 0) {
    return c.json({ erro: 'este papel tem permissões que você não possui' }, 403);
  }

  const u = await c.env.DB
    .prepare('SELECT id, email FROM usuarios WHERE id = ? AND tenant_id = ? AND pendente = 1')
    .bind(id, s.tenantId)
    .first<{ id: string; email: string }>();
  if (!u) return c.json({ erro: 'não há pedido pendente para este usuário' }, 404);

  const agora = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE usuarios SET pendente = 0, ativo = 1, aprovado_em = ?, aprovado_por = ?
          WHERE id = ?`,
      )
      .bind(agora, s.usuarioId, u.id),
    c.env.DB.prepare('DELETE FROM usuario_papeis WHERE usuario_id = ?').bind(u.id),
    c.env.DB.prepare('INSERT INTO usuario_papeis (usuario_id, papel_id) VALUES (?,?)')
      .bind(u.id, corpo.papelId),
    ...corpo.empresas.map((e) =>
      c.env.DB.prepare('INSERT INTO usuario_empresas (usuario_id, empresa_id) VALUES (?,?)').bind(u.id, e)),
    ...corpo.excecoes.map((e) =>
      c.env.DB
        .prepare(
          `INSERT INTO usuario_permissoes (usuario_id, permissao, concedida, definida_em, definida_por)
           VALUES (?,?,?,?,?)`,
        )
        .bind(u.id, e.permissao, e.concedida ? 1 : 0, agora, s.usuarioId)),
  ]);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'alterar', entidade: 'usuario', entidadeId: u.id,
    campo: 'aprovacao', valorAntes: 'pendente', valorDepois: `aprovado; papel=${corpo.papelId}`,
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });
  return c.json({ ok: true, email: u.email });
});

/** Recusar: apaga o pedido. Não deixa conta morta ocupando o e-mail. */
app.post('/api/usuarios/:id/recusar', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.aprovar');
  const id = c.req.param('id');
  const u = await c.env.DB
    .prepare('SELECT id, email FROM usuarios WHERE id = ? AND tenant_id = ? AND pendente = 1')
    .bind(id, s.tenantId)
    .first<{ id: string; email: string }>();
  if (!u) return c.json({ erro: 'não há pedido pendente para este usuário' }, 404);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'excluir', entidade: 'usuario', entidadeId: u.id,
    campo: 'aprovacao', valorAntes: `pendente:${u.email}`, valorDepois: 'recusado',
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });
  // A trilha registra ANTES de apagar: depois não haveria a quem se referir.
  await c.env.DB.prepare('DELETE FROM usuarios WHERE id = ? AND pendente = 1').bind(u.id).run();
  return c.json({ ok: true });
});

app.post('/api/usuarios/:id/ativo', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.desativar');
  const id = c.req.param('id');
  const { ativo } = z.object({ ativo: z.boolean() }).parse(await c.req.json());

  // Desativar a si mesmo é como trancar a chave dentro do carro.
  if (id === s.usuarioId) return c.json({ erro: 'você não pode desativar a si mesmo' }, 400);

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE usuarios SET ativo = ?, desativado_em = ? WHERE id = ? AND tenant_id = ?')
      .bind(ativo ? 1 : 0, ativo ? null : new Date().toISOString(), id, s.tenantId),
    c.env.DB.prepare('UPDATE sessoes SET revogada = 1 WHERE usuario_id = ?').bind(id),
  ]);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'alterar', entidade: 'usuario', entidadeId: id,
    campo: 'ativo', valorAntes: ativo ? '0' : '1', valorDepois: ativo ? '1' : '0',
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });
  return c.json({ ok: true });
});

app.post('/api/usuarios/:id/redefinir-senha', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.redefinir_senha');
  const alvo = c.req.param('id');
  const { senhaProvisoria, minhaSenha } = z
    .object({ senhaProvisoria: z.string().min(1), minhaSenha: z.string().min(1) })
    .parse(await c.req.json());
  if (!(await reautenticar(c.env.DB, s.usuarioId, minhaSenha))) {
    return c.json({ erro: 'confirme a SUA senha para redefinir a de outra pessoa' }, 400);
  }

  const forca = avaliarSenha(senhaProvisoria);
  if (!forca.ok) return c.json({ erro: forca.problemas.join('; ') }, 400);

  const u = await c.env.DB
    .prepare('SELECT id, email FROM usuarios WHERE id = ? AND tenant_id = ?')
    .bind(alvo, s.tenantId)
    .first<{ id: string; email: string }>();
  if (!u) return c.json({ erro: 'usuário não encontrado' }, 404);

  await c.env.DB.batch([
    c.env.DB
      .prepare(
        `UPDATE usuarios SET senha_hash = ?, deve_trocar_senha = 1,
           tentativas_falhas = 0, bloqueado_ate = NULL, senha_solicitada_em = NULL
         WHERE id = ?`,
      )
      .bind(await gerarHashSenha(senhaProvisoria), u.id),
    c.env.DB.prepare('UPDATE sessoes SET revogada = 1 WHERE usuario_id = ?').bind(u.id),
  ]);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'alterar', entidade: 'usuario', entidadeId: u.id,
    campo: 'senha', valorAntes: null, valorDepois: null,
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });

  return c.json({ ok: true, email: u.email, deveTrocarNoProximoLogin: true });
});

/** O administrador desliga o segundo fator de quem perdeu o celular E os códigos. */
app.post('/api/usuarios/:id/desativar-mfa', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'usuarios.desativar_mfa');
  const alvo = c.req.param('id');
  const { minhaSenha } = z.object({ minhaSenha: z.string().min(1) }).parse(await c.req.json());
  if (!(await reautenticar(c.env.DB, s.usuarioId, minhaSenha))) {
    return c.json({ erro: 'confirme a SUA senha para desligar o segundo fator de outra pessoa' }, 400);
  }
  const u = await c.env.DB
    .prepare('SELECT id, email FROM usuarios WHERE id = ? AND tenant_id = ?')
    .bind(alvo, s.tenantId).first<{ id: string; email: string }>();
  if (!u) return c.json({ erro: 'usuário não encontrado' }, 404);

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM usuario_mfa WHERE usuario_id = ?').bind(u.id),
    c.env.DB.prepare('DELETE FROM mfa_recuperacao WHERE usuario_id = ?').bind(u.id),
    c.env.DB.prepare('UPDATE sessoes SET revogada = 1 WHERE usuario_id = ?').bind(u.id),
  ]);

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'alterar', entidade: 'usuario', entidadeId: u.id,
    campo: 'mfa', valorAntes: 'ligado', valorDepois: 'desligado',
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });
  return c.json({ ok: true, email: u.email });
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

app.get('/api/empresas', async (c) => {
  exigir(c.get('sessao'), 'empresas.visualizar');
  return c.json(await c.get('repo').listarEmpresas());
});

/** Pré-visualização do que o CNAE sugere, antes de salvar o cadastro. */
app.post('/api/empresas/sugestao', async (c) => {
  // Serve ao cadastro e à edição: quem pode qualquer um dos dois pode ver a prévia.
  exigirAlguma(c.get('sessao'), ['empresas.criar', 'empresas.editar']);
  const { cnaePrincipal, cnaesSecundarios } = z
    .object({ cnaePrincipal: z.string(), cnaesSecundarios: z.array(z.string()).default([]) })
    .parse(await c.req.json());
  return c.json(analisarCnaes(cnaePrincipal, cnaesSecundarios));
});

app.post('/api/empresas', async (c) => {
  exigir(c.get('sessao'), 'empresas.criar');
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

  // Confere antes de tentar: a resposta do banco chegaria como exceção, e
  // exceção prevista é caso de negócio, não defeito.
  const cnpj = corpo.cnpj.replace(/\D/g, '');
  const repetido = await c.env.DB
    .prepare('SELECT razao_social FROM empresas WHERE tenant_id = ? AND cnpj = ?')
    .bind(c.get('sessao').tenantId, cnpj)
    .first<{ razao_social: string }>();
  if (repetido) {
    return c.json({
      erro: `este CNPJ já está cadastrado como "${repetido.razao_social}"`,
    }, 409);
  }

  const id = await c.get('repo').criarEmpresa(corpo);
  return c.json({ id }, 201);
});

app.patch('/api/empresas/:id', async (c) => {
  exigir(c.get('sessao'), 'empresas.editar');
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
  // Ler nota é ver CNPJ, valor e item de cliente de terceiro: precisa de
  // permissão explícita. O recorte por empresa não substitui isso.
  exigir(c.get('sessao'), 'notas.visualizar');
  // Ler nota é ver CNPJ, valor e item de cliente de terceiro: precisa de
  // permissão explícita. O recorte por empresa não substitui isso.
  exigir(c.get('sessao'), 'notas.visualizar');
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

// Apagar nota: some com os itens, o XML guardado no R2 e a nota. As REGRAS
// aprendidas ficam — elas sao conhecimento do escritorio sobre o fornecedor, nao
// pertencem a nota que por acaso as ensinou. Quem quiser tirar a regra tem
// `regras.apagar` para isso.
app.delete('/api/notas/:id', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'notas.apagar');
  const id = c.req.param('id');

  const nota = await c.env.DB
    .prepare('SELECT id, chave, numero, r2_original FROM notas WHERE tenant_id = ? AND id = ?')
    .bind(s.tenantId, id)
    .first<any>();
  if (!nota) return c.json({ erro: 'nota não encontrada' }, 404);

  // A auditoria vem ANTES: se o R2 falhar, o registro de que alguem mandou
  // apagar nao pode sumir junto.
  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'excluir', entidade: 'nota', entidadeId: id,
    campo: 'chave', valorAntes: nota.chave, valorDepois: null,
    origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM itens WHERE tenant_id = ? AND nota_id = ?').bind(s.tenantId, id),
    c.env.DB.prepare('DELETE FROM notas WHERE tenant_id = ? AND id = ?').bind(s.tenantId, id),
  ]);

  if (nota.r2_original) {
    // O arquivo some depois das linhas: XML orfao no R2 e desperdicio, linha
    // apontando para arquivo que nao existe e erro na tela.
    try {
      await c.env.XML_ORIGINAL.delete(nota.r2_original);
    } catch {
      // Nao desfaz a exclusao por causa do arquivo.
    }
  }

  return c.json({ ok: true });
});

// Apagar empresa: leva junto notas, itens, XMLs, regras e fornecedores dela.
// Destrutivo de verdade — por isso exige o CNPJ digitado, como confirmacao.
app.delete('/api/empresas/:id', async (c) => {
  const s = c.get('sessao');
  exigir(s, 'empresas.apagar');
  const id = c.req.param('id');

  const empresa = await c.env.DB
    .prepare('SELECT id, cnpj, razao_social FROM empresas WHERE tenant_id = ? AND id = ?')
    .bind(s.tenantId, id)
    .first<any>();
  if (!empresa) return c.json({ erro: 'empresa não encontrada' }, 404);

  const confirmacao = (c.req.query('confirmar') ?? '').replace(/\D/g, '');
  if (confirmacao !== empresa.cnpj) {
    return c.json(
      { erro: 'para apagar, confirme o CNPJ do cliente', cnpjEsperado: empresa.cnpj },
      400,
    );
  }

  const { results: notas } = await c.env.DB
    .prepare('SELECT id, r2_original FROM notas WHERE tenant_id = ? AND empresa_id = ?')
    .bind(s.tenantId, id)
    .all<any>();

  await new Auditoria(c.env.DB, c.env.AUDIT_SEED).registrar({
    tenantId: s.tenantId, usuarioId: s.usuarioId, usuarioEmail: s.email,
    acao: 'excluir', entidade: 'empresa', entidadeId: id,
    campo: 'razao_social', valorAntes: `${empresa.razao_social} (${notas.length} nota(s))`,
    valorDepois: null, origem: 'manual', ip: c.req.header('CF-Connecting-IP') ?? null,
    requestId: c.req.header('CF-Ray') ?? null,
  });

  await c.env.DB.batch([
    c.env.DB.prepare(
      'DELETE FROM itens WHERE tenant_id = ? AND nota_id IN (SELECT id FROM notas WHERE tenant_id = ? AND empresa_id = ?)',
    ).bind(s.tenantId, s.tenantId, id),
    c.env.DB.prepare('DELETE FROM notas WHERE tenant_id = ? AND empresa_id = ?').bind(s.tenantId, id),
    c.env.DB.prepare('DELETE FROM regras WHERE tenant_id = ? AND empresa_id = ?').bind(s.tenantId, id),
    c.env.DB.prepare('DELETE FROM fornecedores WHERE tenant_id = ? AND empresa_id = ?').bind(s.tenantId, id),
    c.env.DB.prepare('DELETE FROM lotes_importacao WHERE tenant_id = ? AND empresa_id = ?').bind(s.tenantId, id),
    c.env.DB.prepare('DELETE FROM usuario_empresas WHERE empresa_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM empresas WHERE tenant_id = ? AND id = ?').bind(s.tenantId, id),
  ]);

  for (const n of notas) {
    if (!n.r2_original) continue;
    try {
      await c.env.XML_ORIGINAL.delete(n.r2_original);
    } catch {
      // idem
    }
  }

  return c.json({ ok: true, notasApagadas: notas.length });
});

app.get('/api/notas/:id/xml-corrigido', async (c) => {
  exigir(c.get('sessao'), 'notas.exportar');
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
  exigir(c.get('sessao'), 'notas.exportar');
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

/** Publica de proposito - ver o middleware. */
app.get('/api/saude', (c) => c.json({ ok: true, ambiente: c.env.AMBIENTE }));

/**
 * Credenciais de teste, para a tela de login preencher sozinha no ambiente local.
 *
 * Existe porque durante os testes com o pessoal da ALFA a senha e digitada dezenas
 * de vezes por dia e errar a digitacao vira ruido no lugar de sinal.
 *
 * Responde 404 quando LOGIN_DEMO nao esta definido - que e o caso de qualquer
 * deploy, ja que .dev.vars nao sobe. Sem chave, sem rota: nao ha caminho em que
 * uma instalacao publica sirva senha para quem pedir.
 */
app.get('/api/local', (c) => {
  // Duas travas, não uma. A ausência de LOGIN_DEMO já bastaria — mas um
  // `wrangler secret put` feito por engano, ou uma linha copiada do dev para o
  // `vars`, e a produção passaria a servir credencial de admin a quem pedir.
  if (c.env.AMBIENTE === 'producao') return c.json({ erro: 'rota não encontrada' }, 404);
  const bruto = c.env.LOGIN_DEMO;
  if (!bruto) return c.json({ erro: 'rota não encontrada' }, 404);
  const corte = bruto.indexOf('|');
  if (corte < 1) return c.json({ erro: 'rota não encontrada' }, 404);
  return c.json({
    email: bruto.slice(0, corte),
    senha: bruto.slice(corte + 1),   // a senha da cria a cada `preparar-local`
  });
});

// Rota de API não encontrada devolve JSON, e não a tela — senão o cliente recebe
// HTML onde esperava erro e o problema aparece como "JSON inválido" três camadas adiante.
app.all('/api/*', (c) => c.json({ erro: 'rota não encontrada' }, 404));

/** Qualquer outro caminho é a aplicação: serve o arquivo, ou o index.html. */
app.all('*', async (c) => {
  const r = await c.env.ASSETS.fetch(c.req.raw);
  if (r.status !== 404) return r;
  const url = new URL(c.req.url);
  url.pathname = '/index.html';
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

export default app;
