/**
 * DIFAL pelo simulador do ITCNET (09/11/2026, pedido do Mateus: "pega o valor que foi
 * gerado no DIFAL do nosso, coloca nesse site e traz o resultado").
 *
 * A Taís calcula a guia no "Simulador de Cálculo" do ITCNET
 * (https://itcnet.com.br/st/aplicativo_calculo_2018.php), que é um formulário GET: os
 * campos c1 a c22 vão na própria URL e a página volta com o resultado. O ITC pede que o
 * cálculo seja feito "separadamente para cada mercadoria", então vai um pedido por item.
 *
 * Conta do simulador (lida nas dicas da própria página, 09/11):
 *   6  subtotal = produto + frete + seguro + despesas − desconto
 *   8  base do ICMS próprio = subtotal (+ IPI) − redução
 *   10 ICMS próprio = 8 × alíquota interestadual
 *   14 base do DIFAL = (8 − 10) ÷ (1 − alíquota interna)
 *   18 DIFAL = 14 × alíquota interna − 10;  20 FCP = 14 × FCP;  21 total = 18 + 20
 *
 * O acesso é com o login da Alfa no ITCNET, guardado como segredo no Cloudflare
 * (ITC_USUARIO e ITC_SENHA). O login é Keycloak (login.itcnet.com.br): segue os
 * redirecionamentos guardando os cookies, como um navegador.
 */

export class ErroItc extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ErroItc';
  }
}

export const SIMULADOR_ITC = 'https://itcnet.com.br/st/aplicativo_calculo_2018.php';

/** Um item da nota, com os valores do XML. */
export type ItemParaItc = {
  valorProduto: number; frete: number; seguro: number; outras: number; desconto: number;
  ipi: number; base: number; icms: number;
};

export type ResultadoItc = {
  baseIcms: number; icmsProprio: number; ipi: number; baseDifal: number; icmsDeducao: number;
  difal: number; fcp: number; total: number;
};

const centavos = (v: number) => Math.round(v * 100) / 100;
const moedaBr = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pctBr = (v: number, casas = 2) => String(Number(v.toFixed(casas))).replace('.', ',');
const numeroBr = (s: string | undefined | null) => Number(String(s ?? '').replace(/[^\d,-]/g, '').replace(',', '.')) || 0;

/** Alíquota interestadual do item: ICMS ÷ base, arredondada (4, 7 ou 12). */
export function aliquotaInterestadual(base: number, icms: number): number {
  return base > 0 ? Math.round((icms / base) * 100) : 0;
}

/**
 * Os campos do simulador para um item, do jeito que a tela do ITC manda (valores
 * "R$ 1.234,56", percentuais com vírgula, campo vazio quando é zero). O IPI vai como
 * percentual do subtotal, que é a base do IPI no simulador (campo 11).
 */
export function camposDoItem(it: ItemParaItc, aliquotaInterna: number): URLSearchParams {
  const subtotal = centavos(it.valorProduto + it.frete + it.seguro + it.outras - it.desconto);
  const dinheiro = (v: number) => (v ? moedaBr(centavos(v)) : '');
  const pIpi = it.ipi > 0 && subtotal > 0 ? pctBr((it.ipi / subtotal) * 100, 4) : '';
  return new URLSearchParams({
    c1: moedaBr(centavos(it.valorProduto)), c2: dinheiro(it.frete), c3: dinheiro(it.seguro), c4: dinheiro(it.outras),
    c5: dinheiro(it.desconto), c7: '', c9: String(aliquotaInterestadual(it.base, it.icms)), c12: pIpi,
    c18: pctBr(aliquotaInterna), c22: '', Enviar: 'Calcular',
  });
}

/** Lê o resultado na página que o simulador devolve. */
export function lerResultadoItc(html: string): ResultadoItc {
  const campo = (nome: string) => {
    const tag = html.match(new RegExp(`<input[^>]*name="${nome}"[^>]*>`, 'i'))?.[0];
    return numeroBr(tag?.match(/value="([^"]*)"/i)?.[1]);
  };
  const linha = (rotulo: string) => {
    const m = html.match(new RegExp(`${rotulo}[\\s\\S]*?<u>\\s*R\\$\\s*([\\d.,]+)\\s*</u>`, 'i'));
    return m ? numeroBr(m[1]) : null;
  };
  const difal = linha('Valor do DIFAL a ser recolhido');
  const total = linha('Valor Total do DIFAL');
  if (difal === null || total === null) {
    throw new ErroItc('A página do simulador do ITC veio sem o resultado. Pode ser que ela tenha mudado: avise o Mateus.');
  }
  return {
    baseIcms: campo('c8'), icmsProprio: campo('c10'), ipi: campo('c13'), baseDifal: campo('c17'),
    icmsDeducao: campo('c20'), difal, fcp: linha('Valor do FCP a ser recolhido') ?? 0, total,
  };
}

type Cookie = { nome: string; valor: string; dominio: string; soHost: boolean };

const temSenha = (html: string) => /<input[^>]*type="password"/i.test(html);
const decodificar = (s: string) => s.replace(/&amp;/g, '&').replace(/&#x3D;|&#61;/g, '=').replace(/&quot;/g, '"');

/**
 * Uma sessão no ITCNET: guarda os cookies entre os pedidos (por domínio, como o
 * navegador) e entra de novo sozinha se o ITC pedir login no meio.
 */
export class SessaoItc {
  private cookies: Cookie[] = [];
  private buscar: typeof fetch;

  constructor(private usuario: string, private senha: string, buscar?: typeof fetch) {
    // O fetch da Cloudflare não pode ser chamado como método de outro objeto ("Illegal invocation").
    this.buscar = buscar ?? ((u, i) => fetch(u, i));
  }

  private guardarCookies(url: URL, r: Response) {
    const h = r.headers as Headers & { getSetCookie?: () => string[] };
    const lista = h.getSetCookie?.() ?? (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')!] : []);
    for (const linha of lista) {
      const [par, ...attrs] = linha.split(';');
      const i = par!.indexOf('=');
      if (i <= 0) continue;
      const nome = par!.slice(0, i).trim(), valor = par!.slice(i + 1).trim();
      const dom = attrs.map((a) => a.trim()).find((a) => /^domain=/i.test(a))?.slice(7).replace(/^\./, '').toLowerCase();
      const apagar = !valor || attrs.some((a) => /^\s*max-age=0\b/i.test(a)) || attrs.some((a) => /^\s*expires=.*19[7-9]\d/i.test(a));
      const c: Cookie = { nome, valor, dominio: dom ?? url.hostname, soHost: !dom };
      this.cookies = this.cookies.filter((x) => !(x.nome === c.nome && x.dominio === c.dominio));
      if (!apagar) this.cookies.push(c);
    }
  }

  private cabecalhoCookies(url: URL) {
    const h = url.hostname;
    return this.cookies
      .filter((c) => (c.soHost ? c.dominio === h : h === c.dominio || h.endsWith(`.${c.dominio}`)))
      .map((c) => `${c.nome}=${c.valor}`).join('; ');
  }

  /** Um pedido seguindo os redirecionamentos, como o navegador. */
  private async ir(endereco: string, init: { method?: string; body?: string } = {}): Promise<{ url: string; html: string }> {
    let url = new URL(endereco);
    let metodo = init.method ?? 'GET';
    let corpo = init.body;
    for (let i = 0; i < 12; i++) {
      const cab: Record<string, string> = { 'user-agent': 'Mozilla/5.0 (Alfa Fiscal)', accept: 'text/html' };
      const ck = this.cabecalhoCookies(url);
      if (ck) cab.cookie = ck;
      if (corpo !== undefined) cab['content-type'] = 'application/x-www-form-urlencoded';
      const r = await this.buscar(url.toString(), { method: metodo, headers: cab, body: corpo, redirect: 'manual' });
      this.guardarCookies(url, r);
      const destino = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && destino) {
        url = new URL(destino, url);
        metodo = 'GET';
        corpo = undefined;
        continue;
      }
      if (r.status >= 500) throw new ErroItc(`O ITC está fora do ar agora (erro ${r.status}). Tente de novo em alguns minutos.`);
      return { url: url.toString(), html: await r.text() };
    }
    throw new ErroItc('O ITC ficou redirecionando sem parar. Tente de novo em alguns minutos.');
  }

  /** Preenche o formulário de login do ITC (Keycloak) na página que pediu login. */
  private async entrar(pagina: { url: string; html: string }) {
    const forms = [...pagina.html.matchAll(/<form\b[^>]*>/gi)].map((m) => m[0]);
    const form = forms.find((f) => /login-actions/i.test(f)) ?? forms[0];
    const acao = form?.match(/action="([^"]*)"/i)?.[1];
    if (!acao) throw new ErroItc('Não achei a tela de login do ITC.');
    const depois = await this.ir(new URL(decodificar(acao), pagina.url).toString(), {
      method: 'POST',
      body: new URLSearchParams({ username: this.usuario, password: this.senha, credentialId: '' }).toString(),
    });
    if (/name="(otp|totp)"/i.test(depois.html)) {
      throw new ErroItc('O ITC pediu um código de segundo fator no login. O robô não consegue: avise o Mateus.');
    }
    if (temSenha(depois.html)) throw new ErroItc('O ITC não aceitou o usuário ou a senha cadastrados para o robô.');
  }

  /** Um cálculo no simulador. Se o ITC pedir login, entra e repete uma vez. */
  async simular(campos: URLSearchParams): Promise<ResultadoItc> {
    const endereco = `${SIMULADOR_ITC}?${campos.toString()}`;
    let p = await this.ir(endereco);
    if (temSenha(p.html)) {
      await this.entrar(p);
      p = await this.ir(endereco);
      if (temSenha(p.html)) throw new ErroItc('Entrei no ITC, mas ele continuou pedindo login.');
    }
    return lerResultadoItc(p.html);
  }
}
