import { describe, it, expect } from 'vitest';
import { SessaoItc, ErroItc, camposDoItem, lerResultadoItc, aliquotaInterestadual, SIMULADOR_ITC } from '../src/relatorios/itc';

/** Página de resultado com a mesma marcação do simulador do ITCNET (09/11), valores inventados. */
const pagina = (v: { c8: string; c10: string; c13: string; c17: string; c20: string; difal: string; fcp: string; total: string }) => `
<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"></head><body>
<form name="form1" method="GET" action="aplicativo_calculo_2018.php" onSubmit="return verifica(form1);">
<table>
<tr><td>8 (=) Base de c&aacute;lculo do ICMS Pr&oacute;prio</td><td><input name="c8" type="text"  class="dinheiro" id="c8" value="R$ ${v.c8}" size="12" disabled></td></tr>
<tr><td>10 (=) Valor do ICMS Pr&oacute;prio</td><td><input name="c10" type="text"  class="dinheiro" id="c10" value="R$ ${v.c10}" size="12" disabled></td></tr>
<tr><td>13 (=) Valor do IPI</td><td><input name="c13" type="text"  class="dinheiro" id="c13" value="R$ ${v.c13}" size="12" disabled></td></tr>
<tr><td>14 (=) Base de c&aacute;lculo do DIFAL</td><td bgcolor="#E9E9E9"> <input name="c17" type="text"  class="dinheiro" id="c17" value="R$ ${v.c17}" size="12" disabled></td></tr>
<tr><td>17 (-) ICMS Pr&oacute;prio dedut&iacute;vel</td><td><input name="c20" type="text"  class="dinheiro" id="c20" value="R$ ${v.c20}" size="12" disabled> </td></tr>
<tr><td><font class="txt2p"><strong>(=) <u>Valor do DIFAL a ser recolhido</u></strong> <a href="#" class="tooltip"><em><b>(?)</b></em><span>
<div align="justify">= (Campo 16 - Campo 17)</div></span></a></font></td>
<td bgcolor="#CCCCCC"><font class="txt2p"><div align="center"><b><u>R$ ${v.difal}</u></b></div></font></td></tr>
<tr><td><strong>(=) <u>Valor do FCP a ser recolhido</u></strong></td><td><b><u>R$ ${v.fcp}</u></b></td></tr>
<tr><td><font class="txt2p"><strong>(=) <u>Valor Total do DIFAL</u> </strong><a href="#" class="tooltip"><em><b>(?)</b></em><span>
<div align="justify">= Campo 18 + Campo 20</div></span></a></font></td>
<td bgcolor="#CCCCCC"><font class="txt2p"><div align="center"><b><u>R$ ${v.total}</u></b></div></font></td></tr>
</table></form></body></html>`;

const RESULTADO = pagina({ c8: '91,14', c10: '10,94', c13: '0,00', c17: '96,63', c20: '10,94', difal: '5,49', fcp: '0,00', total: '5,49' });
const LOGIN = `<html><body><form id="kc-form-login" onsubmit="login.disabled = true; return true;"
  action="https://login.itcnet.com.br/realms/itc/login-actions/authenticate?session_code=sc1&amp;execution=ex1&amp;client_id=portalitc" method="post">
  <input tabindex="1" id="username" name="username" type="text"><input id="password" name="password" type="password">
  <input type="hidden" id="id-hidden-input" name="credentialId"><input name="login" type="submit" value="Entrar"></form></body></html>`;

describe('DIFAL no simulador do ITCNET (09/11)', () => {
  it('monta os campos do simulador para um item, do jeito que a tela do ITC manda', () => {
    // Item 1 da nota 33620 (The Sailor LTDA, out/2026): produto 279,60, desconto 8,39, IPI 35,26, ICMS 12%.
    const p = camposDoItem({ valorProduto: 279.6, frete: 0, seguro: 0, outras: 0, desconto: 8.39, ipi: 35.26, base: 271.21, icms: 32.55 }, 17);
    expect(Object.fromEntries(p)).toEqual({
      c1: 'R$ 279,60', c2: '', c3: '', c4: '', c5: 'R$ 8,39', c7: '', c9: '12', c12: '13,001', c18: '17', c22: '', Enviar: 'Calcular',
    });
    // Sem IPI nem desconto, alíquota interna com casas.
    const q = camposDoItem({ valorProduto: 1234.5, frete: 10, seguro: 0, outras: 0, desconto: 0, ipi: 0, base: 1244.5, icms: 49.78 }, 17.5);
    expect([q.get('c1'), q.get('c2'), q.get('c5'), q.get('c9'), q.get('c12'), q.get('c18')]).toEqual(['R$ 1.234,50', 'R$ 10,00', '', '4', '', '17,5']);
    expect(aliquotaInterestadual(0, 0)).toBe(0);
  });

  it('lê o resultado da página do simulador', () => {
    expect(lerResultadoItc(RESULTADO)).toEqual({ baseIcms: 91.14, icmsProprio: 10.94, ipi: 0, baseDifal: 96.63, icmsDeducao: 10.94, difal: 5.49, fcp: 0, total: 5.49 });
    expect(lerResultadoItc(pagina({ c8: '3.700,60', c10: '444,07', c13: '202,14', c17: '3.923,53', c20: '444,07', difal: '222,93', fcp: '0,00', total: '222,93' })))
      .toMatchObject({ baseIcms: 3700.6, ipi: 202.14, baseDifal: 3923.53, total: 222.93 });
    expect(() => lerResultadoItc('<html>outra coisa</html>')).toThrow(ErroItc);
  });

  /** Um ITC de mentira: o simulador manda para o login (Keycloak) até a sessão existir. */
  function itcFalso(opcoes: { senhaCerta?: string } = {}) {
    const pedidos: { metodo: string; url: string; cookie: string; corpo?: string }[] = [];
    let logado = false;
    const f = (async (u: string, init: any = {}) => {
      const url = new URL(u);
      const cookie = init.headers?.cookie ?? '';
      pedidos.push({ metodo: init.method ?? 'GET', url: u, cookie, corpo: init.body });
      const vai = (para: string, ck?: string) => {
        const h = new Headers({ location: para });
        if (ck) h.append('set-cookie', ck);
        return new Response(null, { status: 302, headers: h });
      };
      if (url.host === 'itcnet.com.br' && url.pathname === '/st/aplicativo_calculo_2018.php') {
        if (logado && cookie.includes('PHPSESSID=logado')) return new Response(RESULTADO, { status: 200 });
        return vai('/auth/keycloak/login.php', 'PHPSESSID=anonimo; path=/');
      }
      if (url.host === 'itcnet.com.br' && url.pathname === '/auth/keycloak/login.php') {
        return vai('https://login.itcnet.com.br/realms/itc/protocol/openid-connect/auth?client_id=portalitc&state=s1');
      }
      if (url.host === 'login.itcnet.com.br' && url.pathname.endsWith('/openid-connect/auth')) {
        return new Response(LOGIN, { status: 200, headers: { 'set-cookie': 'AUTH_SESSION_ID=k1; Path=/realms/itc/; Secure; HttpOnly' } });
      }
      if (url.host === 'login.itcnet.com.br' && url.pathname.endsWith('/login-actions/authenticate')) {
        const corpo = new URLSearchParams(init.body);
        if (corpo.get('password') !== (opcoes.senhaCerta ?? 's3nha')) return new Response(LOGIN, { status: 200 });
        return vai('https://itcnet.com.br/auth/keycloak/callback.php?code=c1&state=s1', 'KEYCLOAK_IDENTITY=id1; Path=/realms/itc/');
      }
      if (url.host === 'itcnet.com.br' && url.pathname === '/auth/keycloak/callback.php') {
        logado = true;
        return vai('/index.php', 'PHPSESSID=logado; path=/');
      }
      if (url.host === 'itcnet.com.br' && url.pathname === '/index.php') return new Response('<html>início</html>', { status: 200 });
      return new Response('não achei', { status: 404 });
    }) as unknown as typeof fetch;
    return { f, pedidos };
  }

  it('entra no ITC pelo Keycloak (seguindo os redirecionamentos com os cookies) e traz o cálculo', async () => {
    const { f, pedidos } = itcFalso();
    const s = new SessaoItc('alfa', 's3nha', f);
    const campos = camposDoItem({ valorProduto: 91.14, frete: 0, seguro: 0, outras: 0, desconto: 0, ipi: 0, base: 91.14, icms: 10.94 }, 17);
    expect(await s.simular(campos)).toMatchObject({ difal: 5.49, total: 5.49, baseDifal: 96.63 });

    const post = pedidos.find((p) => p.metodo === 'POST')!;
    expect(post.url).toBe('https://login.itcnet.com.br/realms/itc/login-actions/authenticate?session_code=sc1&execution=ex1&client_id=portalitc');
    expect(new URLSearchParams(post.corpo)).toEqual(new URLSearchParams({ username: 'alfa', password: 's3nha', credentialId: '' }));
    expect(post.cookie).toBe('AUTH_SESSION_ID=k1');
    // O cookie do ITC vai para o ITC; o do Keycloak fica no Keycloak.
    const ultimo = pedidos.at(-1)!;
    expect(ultimo.url.startsWith(`${SIMULADOR_ITC}?c1=R%24+91%2C14`)).toBe(true);
    expect(ultimo.cookie).toBe('PHPSESSID=logado');

    // Segundo item na mesma sessão: não entra de novo.
    const antes = pedidos.length;
    await s.simular(campos);
    expect(pedidos.length - antes).toBe(1);
  });

  it('senha recusada vira um aviso claro, sem repetir', async () => {
    const { f, pedidos } = itcFalso({ senhaCerta: 'outra' });
    const s = new SessaoItc('alfa', 's3nha', f);
    await expect(s.simular(new URLSearchParams({ c1: 'R$ 1,00' }))).rejects.toThrow(/não aceitou o usuário ou a senha/);
    expect(pedidos.filter((p) => p.metodo === 'POST')).toHaveLength(1);
  });
});
