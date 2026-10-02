/**
 * PDF mínimo, feito à mão, para os testes da conferência com o Questor: texto em
 * Helvetica nas posições dadas, uma lista de pedaços por página. Nada de PDF real
 * de cliente no repositório.
 */
export type Pedaco = [x: number, y: number, texto: string];

export function pdfSintetico(paginas: Pedaco[][]): Uint8Array {
  const objetos: string[] = [];
  const add = (s: string) => { objetos.push(s); return objetos.length; };
  const catalogo = add('');
  const pages = add('');
  const fonte = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const kids: number[] = [];
  for (const pedacos of paginas) {
    const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const conteudo = pedacos.map(([x, y, t]) => `BT /F1 8 Tf 1 0 0 1 ${x} ${y} Tm (${esc(t)}) Tj ET`).join('\n');
    const stream = add(`<< /Length ${Buffer.from(conteudo, 'latin1').length} >>\nstream\n${conteudo}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pages} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fonte} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${pages} 0 R >>`;
  objetos[pages - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objetos.forEach((o, i) => {
    offsets.push(Buffer.from(pdf, 'latin1').length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.from(pdf, 'latin1').length;
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

/**
 * Um relatório "Totais ICMS por Produto" no jeito do Questor: cabeçalho, seção de
 * entradas, uma linha por produto (código, NCM, nome, e as seis colunas) e o total.
 * Os nomes vêm em pedaços, como o PDF do Questor faz ("BATA" + "TA").
 */
export function relatorioQuestorSintetico(o: {
  empresa: string; cnpj: string; de: string; ate: string;
  produtos: [codigo: string, ncm: string, nome: string, qtd: string, valor: string][];
  total?: string; porPagina?: number;
}): Uint8Array {
  const porPagina = o.porPagina ?? 40;
  const paginas: Pedaco[][] = [];
  const cabecalho = (n: number): Pedaco[] => [
    [22, 808, `0689 ${o.empresa} -Matriz`], [478, 808, `02/10/2026 15:15 Pág:${String(n).padStart(4, '0')}`],
    [22, 796, `CNPJ: ${o.cnpj}`], [458, 796, `Período: ${o.de} a ${o.ate}`],
    [258, 783, 'Totais ICMS por'], [320, 783, 'Produto'],
    [22, 757, 'Produto'], [266, 757, 'Quantidade'], [315, 757, 'Valor'], [333, 757, 'Contabil'], [377, 757, 'Base ICMS'],
  ];
  for (let i = 0; i < o.produtos.length || i === 0; i += porPagina) {
    const pg = cabecalho(paginas.length + 1);
    if (i === 0) pg.push([22, 732, '-'], [26, 732, 'Entradas']);
    let y = 707;
    for (const [cod, ncm, nome, qtd, valor] of o.produtos.slice(i, i + porPagina)) {
      const meio = Math.max(1, Math.floor(nome.length / 2));
      // Pedaços colados (sem espaço entre eles): o leitor tem que juntar numa palavra só.
      const xNome = 22 + (cod.length + ncm.length + 2) * 4.45;
      pg.push([22, y, `${cod} ${ncm}`], [xNome, y, nome.slice(0, meio)], [xNome + meio * 4.45, y, nome.slice(meio)],
        [290, y, qtd], [338, y, valor], [400, y, '0,00'], [440, y, '0,00'], [480, y, '0,00'], [520, y, '0,00']);
      y -= 12.7;
    }
    paginas.push(pg);
  }
  if (o.total !== undefined) {
    paginas.at(-1)!.push([22, 60, `Total de Entradas do Período de ${o.de} a ${o.ate}`], [250, 60, '0,00'], [330, 60, o.total],
      [400, 60, '0,00'], [440, 60, '0,00'], [480, 60, '0,00'], [520, 60, '0,00']);
  }
  return pdfSintetico(paginas);
}

/**
 * Os pedaços de texto do PDF como o navegador manda para o servidor (public/app.js,
 * conferência com o Questor): o mesmo pdf.js (o de public/pdfjs.mjs vem do unpdf).
 */
export async function paginasDoPdf(bytes: Uint8Array): Promise<{ str: string; x: number; y: number; largura: number }[][]> {
  const { getDocumentProxy } = await import('unpdf');
  const doc = await getDocumentProxy(bytes);
  const paginas = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    paginas.push((tc.items as any[]).filter((it) => typeof it.str === 'string')
      .map((it) => ({ str: it.str as string, x: it.transform[4] as number, y: it.transform[5] as number, largura: it.width as number })));
  }
  return paginas;
}
