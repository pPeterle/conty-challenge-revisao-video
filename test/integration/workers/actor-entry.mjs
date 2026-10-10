// Entrada da thread em JS puro. No Node 22.13, `--import tsx` no execArgv do Worker não vale
// para o arquivo de entrada da thread, então o .ts é carregado aqui pelo tsImport do tsx.
import { tsImport } from "tsx/esm/api";

await tsImport("./actor.ts", import.meta.url);
