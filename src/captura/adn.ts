/**
 * Teste do certificado na base nacional da NFS-e (ADN), 16/11/2026, pedido do Mateus.
 *
 * O intermediário (relay/relay.mjs) consulta https://adn.nfse.gov.br/contribuintes/DFe/{NSU}
 * com o certificado guardado nele. Aqui só se resume a resposta: código HTTP, quantos
 * documentos vieram, o CPF/CNPJ do prestador das primeiras notas e o maior NSU. O XML
 * não sai daqui e nada é gravado.
 */

export type ResumoAdn = {
  status: number;
  caminho: string;
  documentos: number;
  prestadores: { nsu: string; documento: string }[];
  maiorNsu: number | null;
  /** Começo da resposta quando não veio a lista (erro do ADN ou do intermediário). */
  resposta?: string;
};

const acharLista = (o: unknown): Record<string, unknown>[] | null => {
  if (Array.isArray(o) && o.some((x) => x && typeof x === 'object')) return o as Record<string, unknown>[];
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) {
      const l = acharLista(v);
      if (l) return l;
    }
  }
  return null;
};

const campo = (o: Record<string, unknown>, re: RegExp) => {
  const k = Object.keys(o).find((x) => re.test(x));
  return k === undefined ? undefined : o[k];
};

async function xmlDoDocumento(d: Record<string, unknown>): Promise<string> {
  const b = campo(d, /xml|arquivo/i);
  if (typeof b !== 'string') return '';
  try {
    const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

/** CPF com 11 números e os dois dígitos verificadores certos. */
export function cpfValido(cpf: string): boolean {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (ate: number) => {
    let soma = 0;
    for (let i = 0; i < ate; i++) soma += Number(cpf[i]) * (ate + 1 - i);
    return ((soma * 10) % 11) % 10;
  };
  return dv(9) === Number(cpf[9]) && dv(10) === Number(cpf[10]);
}

/** Como o CPF aparece na trilha e nas respostas: só o miolo, como nos documentos públicos. */
export const mascararCpf = (cpf: string) => `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;

/** CPF ou CNPJ do prestador: dentro de <prest> (DPS) ou <emit> (NFS-e). */
export function prestadorDoXml(xml: string): string {
  const bloco = xml.match(/<(prest|emit)\b[\s\S]*?<\/\1>/)?.[0] ?? '';
  return bloco.match(/<CNPJ>(\d+)<\/CNPJ>/)?.[1] ?? bloco.match(/<CPF>(\d+)<\/CPF>/)?.[1] ?? '(não achei no XML)';
}

export async function resumirRespostaAdn(status: number, caminho: string, texto: string): Promise<ResumoAdn> {
  let json: unknown = null;
  try { json = JSON.parse(texto); } catch { /* não é JSON */ }
  const docs = status === 200 ? acharLista(json) ?? [] : [];
  if (!docs.length) {
    return { status, caminho, documentos: 0, prestadores: [], maiorNsu: null, resposta: texto.replace(/\s+/g, ' ').slice(0, 300) };
  }
  const nsus = docs.map((d) => Number(campo(d, /nsu/i))).filter((n) => Number.isFinite(n));
  const prestadores = [];
  for (const d of docs.slice(0, 5)) {
    prestadores.push({ nsu: String(campo(d, /nsu/i) ?? '?'), documento: prestadorDoXml(await xmlDoDocumento(d)) });
  }
  return { status, caminho, documentos: docs.length, prestadores, maiorNsu: nsus.length ? Math.max(...nsus) : null };
}

/** O que se pede ao ADN: um certificado, a partir de que NSU e, opcionalmente, em nome de quem. */
export type PedidoAdn = { certId: string; nsu: string; cnpj?: string; cpf?: string; parametroCpf?: string; lote: boolean };

/**
 * A consulta ao ADN pelo intermediário (GET em /contribuintes/DFe/{NSU}; no 404, tenta o
 * caminho no singular). Usada pela rota do site e pela consulta da plataforma do cartório,
 * para as duas falarem com o intermediário do mesmo jeito. O `caminho` devolvido já vem
 * com o CPF mascarado: é o que pode ir para resposta e para a trilha.
 */
export async function chamarAdn(
  ponte: { url: string; token: string }, pedido: PedidoAdn,
): Promise<{ caminho: string; status: number; texto: string }> {
  const qs = new URLSearchParams();
  if (pedido.lote) qs.set('lote', 'true');
  if (pedido.cnpj) qs.set('cnpjConsulta', pedido.cnpj);
  if (pedido.cpf) qs.set(pedido.parametroCpf ?? 'cpfConsulta', pedido.cpf);
  const sufixo = `/DFe/${pedido.nsu}${qs.size ? `?${qs}` : ''}`;
  const chamar = async (caminho: string) => {
    const r = await fetch(`${ponte.url}/adn/${pedido.certId}${caminho}`, { headers: { authorization: `Bearer ${ponte.token}` } });
    return { caminho: pedido.cpf ? caminho.replace(pedido.cpf, mascararCpf(pedido.cpf)) : caminho, status: r.status, texto: await r.text() };
  };
  const r = await chamar(`/contribuintes${sufixo}`);
  return r.status === 404 ? chamar(`/contribuinte${sufixo}`) : r;
}
