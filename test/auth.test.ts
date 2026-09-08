import { describe, it, expect } from 'vitest';
import { gerarHashSenha, conferirSenha, precisaReidratar, avaliarSenha, MAX_ITERACOES_RUNTIME, HashIncompativel, HASH_INEXISTENTE } from '../src/auth/senha';
import { calcularHash, type EventoAuditoria } from '../src/db/auditoria';
import { PAPEIS_SEMENTE, TODAS_PERMISSOES, exigir, podeVerEmpresa, SemPermissao, type Sessao } from '../src/auth/permissoes';

describe('hash de senha', () => {
  it('aceita a senha correta e recusa a errada', async () => {
    const hash = await gerarHashSenha('umafrasedesenhalonga2026');
    expect(await conferirSenha('umafrasedesenhalonga2026', hash)).toBe(true);
    expect(await conferirSenha('umafrasedesenhalonga2027', hash)).toBe(false);
  });

  it('duas senhas iguais geram hashes diferentes (salt por usuário)', async () => {
    const a = await gerarHashSenha('mesmasenhaparaosdois');
    const b = await gerarHashSenha('mesmasenhaparaosdois');
    expect(a).not.toBe(b);
    expect(await conferirSenha('mesmasenhaparaosdois', a)).toBe(true);
    expect(await conferirSenha('mesmasenhaparaosdois', b)).toBe(true);
  });

  it('não quebra com hash corrompido', async () => {
    expect(await conferirSenha('x', 'lixo')).toBe(false);
    expect(await conferirSenha('x', 'pbkdf2$1$$')).toBe(false);
    expect(await conferirSenha('x', '')).toBe(false);
  });

  it('marca hash antigo para reidratação', async () => {
    expect(precisaReidratar('pbkdf2$1000$abc$def')).toBe(true);
    expect(precisaReidratar(await gerarHashSenha('umafrasedesenhalonga2026'))).toBe(false);
  });
});

describe('política de senha', () => {
  it('recusa senha curta', () => {
    expect(avaliarSenha('curta1').ok).toBe(false);
  });

  it('recusa senha que contém o e-mail', () => {
    const r = avaliarSenha('mateus123456789', 'mateus@alfacontabil.net');
    expect(r.ok).toBe(false);
    expect(r.problemas.join(' ')).toContain('e-mail');
  });

  it('recusa palavras óbvias do contexto', () => {
    expect(avaliarSenha('planee2026seguro').ok).toBe(false);
    expect(avaliarSenha('minhasenhaalfa123').ok).toBe(false);
  });

  it('aceita frase longa', () => {
    expect(avaliarSenha('cavalo bateria grampo correto 7').ok).toBe(true);
  });
});

describe('permissões', () => {
  const sessao = (perms: string[], empresas: Set<string> | null = null): Sessao => ({
    usuarioId: 'u1', tenantId: 'alfa', email: 'a@b.c', nome: 'Teste',
    permissoes: new Set(perms as any), empresas, deveTrocarSenha: false,
  });

  it('o papel Operador não exporta nem administra', () => {
    const op = PAPEIS_SEMENTE.find((p) => p.nome === 'Operador')!;
    expect(op.permissoes).not.toContain('notas.exportar');
    expect(op.permissoes).not.toContain('usuarios.criar');
    expect(op.permissoes).toContain('notas.editar_cfop');
  });

  it('o papel Admin tem tudo e é papel de sistema', () => {
    const admin = PAPEIS_SEMENTE.find((p) => p.nome === 'Admin')!;
    expect(admin.permissoes).toEqual(TODAS_PERMISSOES);
    expect(admin.sistema).toBe(true);
  });

  it('exigir() barra quem não tem a permissão', () => {
    expect(() => exigir(sessao(['notas.visualizar']), 'notas.exportar')).toThrow(SemPermissao);
    expect(() => exigir(sessao(['notas.exportar']), 'notas.exportar')).not.toThrow();
  });

  it('recorte por empresa vale mesmo com permissão de nota', () => {
    const s = sessao(['notas.visualizar'], new Set(['emp-1']));
    expect(podeVerEmpresa(s, 'emp-1')).toBe(true);
    expect(podeVerEmpresa(s, 'emp-2')).toBe(false);
  });

  it('sem recorte, só quem administra empresas vê todas', () => {
    expect(podeVerEmpresa(sessao(['notas.visualizar'], null), 'qualquer')).toBe(false);
    expect(podeVerEmpresa(sessao(['empresas.todas'], null), 'qualquer')).toBe(true);
  });
});

describe('cadeia de hash da auditoria', () => {
  const evento = (campo: string, depois: string): EventoAuditoria => ({
    tenantId: 'alfa', usuarioId: 'u1', usuarioEmail: 'a@b.c',
    acao: 'alterar', entidade: 'item', entidadeId: 'i1',
    campo, valorAntes: '5102', valorDepois: depois, origem: 'manual',
  });

  it('o mesmo evento com o mesmo anterior dá o mesmo hash', async () => {
    const q = '2026-08-24T12:00:00.000Z';
    const a = await calcularHash(evento('cfop', '1102'), q, 'seed');
    const b = await calcularHash(evento('cfop', '1102'), q, 'seed');
    expect(a).toBe(b);
  });

  it('mudar qualquer campo muda o hash', async () => {
    const q = '2026-08-24T12:00:00.000Z';
    const base = await calcularHash(evento('cfop', '1102'), q, 'seed');
    expect(await calcularHash(evento('cfop', '1556'), q, 'seed')).not.toBe(base);
    expect(await calcularHash(evento('descricao', '1102'), q, 'seed')).not.toBe(base);
    expect(await calcularHash(evento('cfop', '1102'), '2026-08-24T12:00:01.000Z', 'seed')).not.toBe(base);
  });

  it('mudar o elo anterior muda o hash — é isso que encadeia', async () => {
    const q = '2026-08-24T12:00:00.000Z';
    const a = await calcularHash(evento('cfop', '1102'), q, 'seedA');
    const b = await calcularHash(evento('cfop', '1102'), q, 'seedB');
    expect(a).not.toBe(b);
  });

  it('a origem entra no hash — não dá para reescrever "regra" como "manual"', async () => {
    const q = '2026-08-24T12:00:00.000Z';
    const manual = await calcularHash({ ...evento('cfop', '1102'), origem: 'manual' }, q, 'seed');
    const porRegra = await calcularHash({ ...evento('cfop', '1102'), origem: 'regra:r1' }, q, 'seed');
    expect(manual).not.toBe(porRegra);
  });
});

describe('o teto de iterações do runtime — bug que só apareceu em produção', () => {
  /* A Cloudflare limita PBKDF2 a 100.000 iterações no deriveBits, para um tenant
     não comer CPU do vizinho. Estávamos em 600.000 (recomendação da OWASP). Em
     produção o deriveBits estourava, o catch do conferirSenha engolia a exceção
     devolvendo false, e a tela dizia "e-mail ou senha inválidos".

     Nada disso aparecia aqui: o workerd do `wrangler dev` aceitou 600.000 sem
     reclamar. 186 testes passando, login local funcionando, produção recusando.

     Estes testes existem para que a diferença nunca mais fique muda. */

  it('o hash novo nasce dentro do teto', async () => {
    const h = await gerarHashSenha('uma frase de senha longa');
    expect(Number(h.split('$')[1])).toBeLessThanOrEqual(MAX_ITERACOES_RUNTIME);
  });

  it('hash acima do teto ESTOURA em vez de dizer "senha errada"', async () => {
    const acima = `pbkdf2$600000$${btoa('salt-de-16-bytes')}$${btoa('digest'.padEnd(32, 'x'))}`;
    await expect(conferirSenha('qualquer senha', acima)).rejects.toThrow(HashIncompativel);
  });

  it('a mensagem do erro diz o que fazer, não só o que houve', async () => {
    const acima = `pbkdf2$600000$${btoa('salt-de-16-bytes')}$${btoa('digest'.padEnd(32, 'x'))}`;
    const erro = await conferirSenha('x', acima).then(() => null, (e: Error) => e);
    expect(erro).toBeInstanceOf(HashIncompativel);
    expect(erro!.message).toContain('600000');
    expect(erro!.message).toContain('100000');
    expect(erro!.message).toContain('redefinir a senha');
  });

  it('senha errada continua sendo false, não exceção — a distinção é o ponto', async () => {
    const h = await gerarHashSenha('a senha certa e longa');
    await expect(conferirSenha('a senha errada aqui', h)).resolves.toBe(false);
  });

  it('hash malformado continua false: entrada suja não é defeito de ambiente', async () => {
    for (const ruim of ['', 'nada', 'pbkdf2$x$y', 'argon2$1$a$b', 'pbkdf2$999$a$b']) {
      await expect(conferirSenha('x', ruim)).resolves.toBe(false);
    }
  });

  it('hash fora do teto é marcado para ser refeito', () => {
    expect(precisaReidratar(`pbkdf2$600000$a$b`)).toBe(true);
  });

  it('e o hash no formato de hoje não precisa', async () => {
    expect(precisaReidratar(await gerarHashSenha('uma frase de senha longa'))).toBe(false);
  });
});

describe('o hash de mentira do e-mail inexistente', () => {
  /* O login gasta o mesmo tempo para e-mail que existe e que não existe, para
     não entregar a lista de usuários do escritório. Esse hash de mentira estava
     escrito à mão no handler, com 600.000 fixo — e quando o teto do runtime
     baixou para 100.000 ele passou a estourar exatamente ali. */

  it('usa as iterações de hoje, não um número escrito à mão', () => {
    expect(Number(HASH_INEXISTENTE.split('$')[1])).toBe(MAX_ITERACOES_RUNTIME);
  });

  it('é conferível sem estourar, e devolve false', async () => {
    await expect(conferirSenha('qualquer coisa', HASH_INEXISTENTE)).resolves.toBe(false);
  });
});
