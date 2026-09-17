/**
 * ZIP minimo, sem compressao (metodo "store") e sem dependencia.
 *
 * Existe para a exportacao em lote dos XML corrigidos: a contadora trata dezenas de
 * notas por competencia e baixar uma a uma nao e entrega, e castigo. XML de NF-e e
 * pequeno; nao comprimir custa pouco e evita trazer uma biblioteca para o Worker
 * (uma dependencia a menos e uma coisa a menos para quebrar no deploy).
 *
 * Formato: PKZIP 2.0, nomes em UTF-8 (bit 11). Abre no Windows, no macOS e no 7-Zip.
 */

const TABELA_CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABELA_CRC[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function montarZip(arquivos: { nome: string; conteudo: string | Uint8Array }[], quando = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const hora = ((quando.getHours() & 31) << 11) | ((quando.getMinutes() & 63) << 5) | ((quando.getSeconds() >> 1) & 31);
  const data = (((quando.getFullYear() - 1980) & 127) << 9) | (((quando.getMonth() + 1) & 15) << 5) | (quando.getDate() & 31);

  const partes: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const a of arquivos) {
    const nome = enc.encode(a.nome);
    const corpo = typeof a.conteudo === 'string' ? enc.encode(a.conteudo) : a.conteudo;
    const crc = crc32(corpo);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // nomes em UTF-8
    local.setUint16(8, 0, true); // store
    local.setUint16(10, hora, true);
    local.setUint16(12, data, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, corpo.length, true);
    local.setUint32(22, corpo.length, true);
    local.setUint16(26, nome.length, true);
    local.setUint16(28, 0, true);
    partes.push(new Uint8Array(local.buffer), nome, corpo);

    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, hora, true);
    c.setUint16(14, data, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, corpo.length, true);
    c.setUint32(24, corpo.length, true);
    c.setUint16(28, nome.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), nome);

    offset += 30 + nome.length + corpo.length;
  }

  const tamCentral = central.reduce((s, p) => s + p.length, 0);
  const fim = new DataView(new ArrayBuffer(22));
  fim.setUint32(0, 0x06054b50, true);
  fim.setUint16(8, arquivos.length, true);
  fim.setUint16(10, arquivos.length, true);
  fim.setUint32(12, tamCentral, true);
  fim.setUint32(16, offset, true);

  const tudo = [...partes, ...central, new Uint8Array(fim.buffer)];
  const out = new Uint8Array(tudo.reduce((s, p) => s + p.length, 0));
  let pos = 0;
  for (const p of tudo) { out.set(p, pos); pos += p.length; }
  return out;
}
