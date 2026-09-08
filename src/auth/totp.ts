/**
 * TOTP — segundo fator de seis dígitos, RFC 6238.
 *
 * É o mesmo mecanismo do Google Authenticator, do Authy, do 1Password: um
 * segredo compartilhado uma única vez e, a partir dele, um código que muda a
 * cada 30 segundos. Não depende de SMS (interceptável por troca de chip), não
 * depende de e-mail e não custa nada por usuário.
 *
 * SHA-1 aqui não é descuido. O RFC 6238 define SHA-1 como padrão e é o que os
 * aplicativos leem de um QR sem configuração extra; a fraqueza conhecida do
 * SHA-1 é em colisão, e o HMAC não depende de resistência a colisão. Trocar por
 * SHA-256 deixaria o código incompatível com metade dos aplicativos.
 */

const PASSO_S = 30;
const DIGITOS = 6;
const ALFABETO32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) sem padding — o formato que os aplicativos esperam. */
export function paraBase32(bytes: Uint8Array): string {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const b of bytes) {
    valor = (valor << 8) | b;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO32[(valor << (5 - bits)) & 31];
  return saida;
}

export function deBase32(texto: string): Uint8Array {
  // Tolerante de propósito: quem digita à mão põe espaço, minúscula e o "="
  // do padding. Recusar isso só gera "código inválido" sem explicação.
  const limpo = texto.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];
  for (const c of limpo) {
    const i = ALFABETO32.indexOf(c);
    if (i < 0) throw new Error(`caractere inválido no segredo: "${c}"`);
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

/** Segredo novo: 20 bytes, o tamanho recomendado pelo RFC 4226. */
export function gerarSegredo(): string {
  return paraBase32(crypto.getRandomValues(new Uint8Array(20)));
}

async function hmacSha1(chave: Uint8Array, mensagem: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    'raw', chave as BufferSource, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, mensagem as BufferSource));
}

/** Código de um contador específico (HOTP, RFC 4226). */
export async function gerarHotp(
  segredoB32: string, contador: number, digitos = DIGITOS,
): Promise<string> {
  const bytes = new Uint8Array(8);
  // Big-endian de 64 bits. Usamos aritmética para não depender de BigInt.
  let resto = contador;
  for (let i = 7; i >= 0; i--) {
    bytes[i] = resto & 255;
    resto = Math.floor(resto / 256);
  }
  const mac = await hmacSha1(deBase32(segredoB32), bytes);
  // Truncamento dinâmico: os 4 bits finais escolhem de onde tirar os 4 bytes.
  const desloc = mac[mac.length - 1]! & 0x0f;
  const binario = ((mac[desloc]! & 0x7f) << 24)
    | ((mac[desloc + 1]! & 0xff) << 16)
    | ((mac[desloc + 2]! & 0xff) << 8)
    | (mac[desloc + 3]! & 0xff);
  return String(binario % 10 ** digitos).padStart(digitos, '0');
}

export function contadorDe(agoraMs = Date.now()): number {
  return Math.floor(agoraMs / 1000 / PASSO_S);
}

export async function gerarTotp(segredoB32: string, agoraMs = Date.now()): Promise<string> {
  return gerarHotp(segredoB32, contadorDe(agoraMs));
}

/**
 * Confere o código aceitando uma janela de tolerância.
 *
 * `janela = 1` aceita o código anterior e o seguinte — 90 segundos no total.
 * Relógio de celular atrasado alguns segundos é a causa nº 1 de "código
 * inválido" com o código certo na tela; recusar por isso é transformar
 * segurança em atrito sem ganho real.
 *
 * Devolve o contador que casou, ou null. O contador importa: quem chama precisa
 * guardá-lo para impedir que o MESMO código seja usado duas vezes (§replay).
 */
export async function conferirTotp(
  segredoB32: string, codigo: string, agoraMs = Date.now(), janela = 1,
): Promise<number | null> {
  const limpo = (codigo ?? '').replace(/\D/g, '');
  if (limpo.length !== DIGITOS) return null;
  const base = contadorDe(agoraMs);
  for (let d = -janela; d <= janela; d++) {
    const esperado = await gerarHotp(segredoB32, base + d);
    // Comparação em tempo constante, como na senha.
    if (esperado.length === limpo.length) {
      let dif = 0;
      for (let i = 0; i < esperado.length; i++) dif |= esperado.charCodeAt(i) ^ limpo.charCodeAt(i);
      if (dif === 0) return base + d;
    }
  }
  return null;
}

/** A URI que o aplicativo lê do QR (ou que se cola à mão). */
export function uriDeProvisionamento(segredoB32: string, email: string, emissor = 'Planee Fiscal'): string {
  const rotulo = encodeURIComponent(`${emissor}:${email}`);
  const p = new URLSearchParams({
    secret: segredoB32, issuer: emissor, algorithm: 'SHA1',
    digits: String(DIGITOS), period: String(PASSO_S),
  });
  return `otpauth://totp/${rotulo}?${p.toString()}`;
}

/** Segredo em blocos de 4, para quem vai digitar à mão sem errar. */
export function segredoLegivel(segredoB32: string): string {
  return (segredoB32.match(/.{1,4}/g) ?? []).join(' ');
}
