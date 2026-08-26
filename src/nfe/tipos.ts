export type ItemNFe = {
  nItem: number;
  cProd: string | null;
  cEAN: string | null;
  xProd: string;
  NCM: string | null;
  CEST: string | null;
  CFOP: string;
  uCom: string | null;
  qCom: number | null;
  vUnCom: number | null;
  vProd: number | null;
  /** CST ou CSOSN do ICMS, conforme o regime do emitente. Nunca alteramos: so conferimos. */
  cstIcms: string | null;
  temIbsCbs: boolean;
};

export type NotaFiscal = {
  chave: string;
  numero: string | null;
  serie: string | null;
  modelo: string | null;
  dhEmi: string | null;
  /** AAAA-MM derivado de dhEmi */
  competencia: string | null;
  emit: { cnpj: string; nome: string | null; uf: string | null };
  dest: { cnpj: string | null; nome: string | null; uf: string | null };
  vNF: number | null;
  protocolo: string | null;
  itens: ItemNFe[];
};

export class ErroParserNFe extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = 'ErroParserNFe';
  }
}
