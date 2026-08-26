import { describe, it, expect } from 'vitest';
import { gerarHashSenha, conferirSenha, avaliarSenha, precisaReidratar } from '../src/auth/senha';
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
    permissoes: new Set(perms as any), empresas,
  });

  it('o papel Operador não exporta nem administra', () => {
    const op = PAPEIS_SEMENTE.find((p) => p.nome === 'Operador')!;
    expect(op.permissoes).not.toContain('export.gerar');
    expect(op.permissoes).not.toContain('usuarios.gerenciar');
    expect(op.permissoes).toContain('notas.editar_cfop');
  });

  it('o papel Admin tem tudo e é papel de sistema', () => {
    const admin = PAPEIS_SEMENTE.find((p) => p.nome === 'Admin')!;
    expect(admin.permissoes).toEqual(TODAS_PERMISSOES);
    expect(admin.sistema).toBe(true);
  });

  it('exigir() barra quem não tem a permissão', () => {
    expect(() => exigir(sessao(['notas.visualizar']), 'export.gerar')).toThrow(SemPermissao);
    expect(() => exigir(sessao(['export.gerar']), 'export.gerar')).not.toThrow();
  });

  it('recorte por empresa vale mesmo com permissão de nota', () => {
    const s = sessao(['notas.visualizar'], new Set(['emp-1']));
    expect(podeVerEmpresa(s, 'emp-1')).toBe(true);
    expect(podeVerEmpresa(s, 'emp-2')).toBe(false);
  });

  it('sem recorte, só quem administra empresas vê todas', () => {
    expect(podeVerEmpresa(sessao(['notas.visualizar'], null), 'qualquer')).toBe(false);
    expect(podeVerEmpresa(sessao(['empresas.gerenciar'], null), 'qualquer')).toBe(true);
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
