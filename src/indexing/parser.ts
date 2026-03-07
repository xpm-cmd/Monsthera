import Parser from "web-tree-sitter";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupportedLanguage } from "../core/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let parserReady = false;
const languageParsers = new Map<SupportedLanguage, Parser>();

function getWasmPath(grammarName: string): string {
  // Resolve from node_modules/tree-sitter-wasms/out/
  return join(__dirname, "../../node_modules/tree-sitter-wasms/out", `tree-sitter-${grammarName}.wasm`);
}

async function initParser(): Promise<void> {
  if (parserReady) return;
  await Parser.init();
  parserReady = true;
}

async function getParser(language: SupportedLanguage): Promise<Parser> {
  const cached = languageParsers.get(language);
  if (cached) return cached;

  await initParser();

  const parser = new Parser();
  const grammarMap: Record<SupportedLanguage, string> = {
    typescript: "typescript",
    javascript: "javascript",
    python: "python",
  };

  const wasmPath = getWasmPath(grammarMap[language]);
  const lang = await Parser.Language.load(wasmPath);
  parser.setLanguage(lang);
  languageParsers.set(language, parser);
  return parser;
}

export interface ExtractedSymbol {
  name: string;
  kind: "function" | "class" | "method" | "type" | "variable" | "import" | "export";
  line: number;
}

export interface ExtractedImport {
  source: string;
  kind: "import" | "require" | "from";
}

export interface ParseResult {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  lineCount: number;
}

export async function parseFile(content: string, language: SupportedLanguage): Promise<ParseResult> {
  const parser = await getParser(language);
  const tree = parser.parse(content);
  if (!tree) throw new Error("Failed to parse file");
  const root = tree.rootNode;

  let symbols: ExtractedSymbol[];
  let imports: ExtractedImport[];

  if (language === "typescript" || language === "javascript") {
    symbols = extractTSSymbols(root);
    imports = extractTSImports(root);
  } else {
    symbols = extractPythonSymbols(root);
    imports = extractPythonImports(root);
  }

  return {
    symbols,
    imports,
    lineCount: content.split("\n").length,
  };
}

// --- TypeScript / JavaScript extraction ---

function extractTSSymbols(root: Parser.SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  function walk(node: Parser.SyntaxNode, depth: number): void {
    switch (node.type) {
      case "function_declaration": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "function", line: node.startPosition.row });
        break;
      }
      case "class_declaration": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "class", line: node.startPosition.row });
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.children) {
            if (child.type === "method_definition") {
              const methodName = child.childForFieldName("name");
              if (methodName)
                symbols.push({ name: methodName.text, kind: "method", line: child.startPosition.row });
            }
          }
        }
        return;
      }
      case "type_alias_declaration":
      case "interface_declaration":
      case "enum_declaration": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "type", line: node.startPosition.row });
        break;
      }
      case "lexical_declaration":
      case "variable_declaration": {
        if (depth <= 1) {
          for (const declarator of node.children) {
            if (declarator.type === "variable_declarator") {
              const name = declarator.childForFieldName("name");
              if (name) symbols.push({ name: name.text, kind: "variable", line: node.startPosition.row });
            }
          }
        }
        break;
      }
      case "export_statement": {
        for (const child of node.children) {
          walk(child, depth);
        }
        return;
      }
    }

    if (depth < 2) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  walk(root, 0);
  return symbols;
}

function extractTSImports(root: Parser.SyntaxNode): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  for (const child of root.children) {
    if (child.type === "import_statement") {
      const source = child.childForFieldName("source");
      if (source) {
        imports.push({ source: stripQuotes(source.text), kind: "import" });
      }
    }
    if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
      const text = child.text;
      const match = text.match(/require\(['"]([^'"]+)['"]\)/);
      if (match) {
        imports.push({ source: match[1]!, kind: "require" });
      }
    }
  }

  return imports;
}

// --- Python extraction ---

function extractPythonSymbols(root: Parser.SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  function walk(node: Parser.SyntaxNode, depth: number): void {
    switch (node.type) {
      case "function_definition": {
        const name = node.childForFieldName("name");
        if (name) {
          symbols.push({
            name: name.text,
            kind: depth <= 1 ? "function" : "method",
            line: node.startPosition.row,
          });
        }
        return;
      }
      case "class_definition": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "class", line: node.startPosition.row });
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.children) {
            walk(child, depth + 1);
          }
        }
        return;
      }
      case "expression_statement": {
        for (const child of node.children) {
          walk(child, depth);
        }
        return;
      }
      case "assignment": {
        if (depth <= 1) {
          const left = node.children[0];
          if (left && left.type === "identifier") {
            symbols.push({ name: left.text, kind: "variable", line: node.startPosition.row });
          }
        }
        break;
      }
    }

    if (depth < 2) {
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    }
  }

  walk(root, 0);
  return symbols;
}

function extractPythonImports(root: Parser.SyntaxNode): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  for (const child of root.children) {
    if (child.type === "import_statement") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        imports.push({ source: nameNode.text, kind: "import" });
      }
    } else if (child.type === "import_from_statement") {
      const moduleNode = child.childForFieldName("module_name");
      if (moduleNode) {
        imports.push({ source: moduleNode.text, kind: "from" });
      }
    }
  }

  return imports;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export async function isParserAvailable(language: SupportedLanguage): Promise<boolean> {
  try {
    await getParser(language);
    return true;
  } catch {
    return false;
  }
}
