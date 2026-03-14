import Parser from "web-tree-sitter";
import { createRequire } from "node:module";
import type { SupportedLanguage } from "../core/constants.js";

const require = createRequire(import.meta.url);

let parserReady = false;
const languageParsers = new Map<SupportedLanguage, Parser>();

function getWasmPath(grammarName: string): string {
  // Use Node.js module resolution — works correctly from dist/ with npm/pnpm/yarn
  return require.resolve(`tree-sitter-wasms/out/tree-sitter-${grammarName}.wasm`);
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
    go: "go",
    rust: "rust",
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
  /** File-level leading comment/docstring extracted from AST (Nivel 2 enrichment). */
  leadingComment: string;
}

export interface SyntaxTreeResult {
  tree: Parser.Tree;
  rootNode: Parser.SyntaxNode;
}

export async function parseSyntaxTree(content: string, language: SupportedLanguage): Promise<SyntaxTreeResult> {
  const parser = await getParser(language);
  const tree = parser.parse(content);
  if (!tree) throw new Error("Failed to parse file");
  return { tree, rootNode: tree.rootNode };
}

export async function parseFile(content: string, language: SupportedLanguage): Promise<ParseResult> {
  const { rootNode: root } = await parseSyntaxTree(content, language);

  let symbols: ExtractedSymbol[];
  let imports: ExtractedImport[];

  if (language === "typescript" || language === "javascript") {
    symbols = extractTSSymbols(root);
    imports = extractTSImports(root);
  } else if (language === "go") {
    symbols = extractGoSymbols(root);
    imports = extractGoImports(root);
  } else if (language === "rust") {
    symbols = extractRustSymbols(root);
    imports = extractRustImports(root);
  } else {
    symbols = extractPythonSymbols(root);
    imports = extractPythonImports(root);
  }

  const leadingComment = extractLeadingComment(root, language);

  return {
    symbols,
    imports,
    lineCount: content.split("\n").length,
    leadingComment,
  };
}

// --- TypeScript / JavaScript extraction ---

function extractTSSymbols(root: Parser.SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  function collectBindingIdentifiers(node: Parser.SyntaxNode | null | undefined): string[] {
    if (!node) return [];

    switch (node.type) {
      case "identifier":
      case "shorthand_property_identifier_pattern":
        return [node.text];
      case "object_pattern":
      case "array_pattern":
      case "assignment_pattern":
      case "pair_pattern":
      case "rest_pattern":
      case "object_assignment_pattern":
      case "array_assignment_pattern":
        return node.children.flatMap((child) => collectBindingIdentifiers(child));
      default:
        return node.children.flatMap((child) => collectBindingIdentifiers(child));
    }
  }

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
              for (const identifier of collectBindingIdentifiers(name)) {
                symbols.push({ name: identifier, kind: "variable", line: node.startPosition.row });
              }
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

// --- Go extraction ---

function extractGoSymbols(root: Parser.SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  for (const node of root.children) {
    switch (node.type) {
      case "function_declaration": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "function", line: node.startPosition.row });
        break;
      }
      case "method_declaration": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "method", line: node.startPosition.row });
        break;
      }
      case "type_declaration": {
        for (const spec of node.children) {
          if (spec.type === "type_spec") {
            const name = spec.childForFieldName("name");
            if (name) {
              const typeNode = spec.childForFieldName("type");
              const kind = typeNode?.type === "struct_type" || typeNode?.type === "interface_type" ? "class" : "type";
              symbols.push({ name: name.text, kind, line: spec.startPosition.row });
            }
          }
        }
        break;
      }
      case "var_declaration":
      case "const_declaration": {
        for (const spec of node.children) {
          if (spec.type === "var_spec" || spec.type === "const_spec") {
            const name = spec.childForFieldName("name");
            if (name) symbols.push({ name: name.text, kind: "variable", line: spec.startPosition.row });
          }
        }
        break;
      }
    }
  }

  return symbols;
}

function extractGoImports(root: Parser.SyntaxNode): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  for (const node of root.children) {
    if (node.type === "import_declaration") {
      for (const spec of node.children) {
        if (spec.type === "import_spec") {
          const path = spec.childForFieldName("path");
          if (path) imports.push({ source: stripQuotes(path.text), kind: "import" });
        } else if (spec.type === "import_spec_list") {
          for (const child of spec.children) {
            if (child.type === "import_spec") {
              const path = child.childForFieldName("path");
              if (path) imports.push({ source: stripQuotes(path.text), kind: "import" });
            }
          }
        }
      }
    }
  }

  return imports;
}

// --- Rust extraction ---

function extractRustSymbols(root: Parser.SyntaxNode): ExtractedSymbol[] {
  const symbols: ExtractedSymbol[] = [];

  function walk(node: Parser.SyntaxNode, depth: number): void {
    switch (node.type) {
      case "function_item": {
        const name = node.childForFieldName("name");
        if (name) {
          symbols.push({ name: name.text, kind: depth <= 1 ? "function" : "method", line: node.startPosition.row });
        }
        return;
      }
      case "struct_item": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "class", line: node.startPosition.row });
        return;
      }
      case "enum_item": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "type", line: node.startPosition.row });
        return;
      }
      case "trait_item": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "type", line: node.startPosition.row });
        return;
      }
      case "type_item": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "type", line: node.startPosition.row });
        return;
      }
      case "impl_item": {
        const body = node.childForFieldName("body");
        if (body) {
          for (const child of body.children) {
            walk(child, depth + 1);
          }
        }
        return;
      }
      case "const_item":
      case "static_item": {
        const name = node.childForFieldName("name");
        if (name) symbols.push({ name: name.text, kind: "variable", line: node.startPosition.row });
        return;
      }
      case "let_declaration": {
        if (depth <= 1) {
          const pattern = node.childForFieldName("pattern");
          if (pattern && pattern.type === "identifier") {
            symbols.push({ name: pattern.text, kind: "variable", line: node.startPosition.row });
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

function extractRustImports(root: Parser.SyntaxNode): ExtractedImport[] {
  const imports: ExtractedImport[] = [];

  for (const node of root.children) {
    if (node.type === "use_declaration") {
      const arg = node.childForFieldName("argument");
      if (arg) {
        // Extract the base path (e.g., "std::collections" from "use std::collections::HashMap")
        imports.push({ source: arg.text, kind: "import" });
      }
    } else if (node.type === "extern_crate_declaration") {
      const name = node.childForFieldName("name");
      if (name) imports.push({ source: name.text, kind: "import" });
    }
  }

  return imports;
}

// --- Leading comment extraction (Nivel 2 enrichment) ---

/**
 * Extract the file-level leading comment from the AST root.
 * Collects comment nodes that appear before the first non-comment
 * code node, which typically serve as file-level documentation.
 */
function extractLeadingComment(root: Parser.SyntaxNode, language: SupportedLanguage): string {
  if (language === "python") {
    return extractPythonLeadingComment(root);
  }

  // TS/JS, Go, Rust: collect consecutive comment nodes at start
  const commentParts: string[] = [];
  for (const child of root.children) {
    if (child.type === "comment" || child.type === "line_comment" || child.type === "block_comment") {
      commentParts.push(cleanComment(child.text, language));
    } else {
      // First non-comment node — stop collecting
      break;
    }
  }
  return commentParts.join(" ").trim();
}

/**
 * Python module docstrings: the first statement in a module that is
 * a bare string expression (expression_statement → string).
 */
function extractPythonLeadingComment(root: Parser.SyntaxNode): string {
  for (const child of root.children) {
    // Skip any leading comments (# ...) — collect those too
    if (child.type === "comment") continue;

    // Module docstring: expression_statement whose first child is a string
    if (child.type === "expression_statement") {
      const firstChild = child.children[0];
      if (firstChild && firstChild.type === "string") {
        return cleanPythonDocstring(firstChild.text);
      }
    }
    // First non-comment, non-docstring node — stop
    break;
  }
  return "";
}

/**
 * Strip comment delimiters and normalize whitespace.
 * Handles line comments (// /// //! #) and block comments.
 */
function cleanComment(text: string, language: SupportedLanguage): string {
  let cleaned = text;

  // Block comments: /* ... */ or /** ... */
  if (cleaned.startsWith("/*")) {
    cleaned = cleaned
      .replace(/^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .replace(/^\s*\*\s?/gm, " "); // strip leading * on each line
  }
  // Line comments: // or /// or //!
  else if (cleaned.startsWith("//")) {
    cleaned = cleaned.replace(/^\/\/[!/]?\s?/, "");
  }
  // Python/shell comments: #
  else if (cleaned.startsWith("#")) {
    cleaned = cleaned.replace(/^#\s?/, "");
  }

  return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Strip triple-quote delimiters from a Python docstring.
 */
function cleanPythonDocstring(text: string): string {
  let cleaned = text;
  // Strip triple quotes (""" or ''')
  if (cleaned.startsWith('"""') || cleaned.startsWith("'''")) {
    cleaned = cleaned.slice(3);
    if (cleaned.endsWith('"""') || cleaned.endsWith("'''")) {
      cleaned = cleaned.slice(0, -3);
    }
  }
  return cleaned.replace(/\s+/g, " ").trim();
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
