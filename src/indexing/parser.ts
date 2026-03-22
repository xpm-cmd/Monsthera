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

export interface ExtractedReference {
  sourceSymbol: string | null;  // enclosing function/class, null = module-level
  targetName: string;           // called function/class/type name
  kind: "call" | "member_call" | "type_ref";
  line: number;
}

export interface ParseResult {
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  references: ExtractedReference[];
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
  let references: ExtractedReference[];

  if (language === "typescript" || language === "javascript") {
    symbols = extractTSSymbols(root);
    imports = extractTSImports(root);
    references = extractTSReferences(root);
  } else if (language === "go") {
    symbols = extractGoSymbols(root);
    imports = extractGoImports(root);
    references = extractGoReferences(root);
  } else if (language === "rust") {
    symbols = extractRustSymbols(root);
    imports = extractRustImports(root);
    references = extractRustReferences(root);
  } else {
    symbols = extractPythonSymbols(root);
    imports = extractPythonImports(root);
    references = extractPythonReferences(root);
  }

  const leadingComment = extractLeadingComment(root, language);

  return {
    symbols,
    imports,
    references,
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

// --- TypeScript / JavaScript reference extraction ---

/**
 * Extract symbol-level references from a TS/JS AST.
 * Identifies call expressions, member call expressions, and type references.
 * Tracks the enclosing function/class/method as the source symbol.
 */
export function extractTSReferences(root: Parser.SyntaxNode): ExtractedReference[] {
  const refs: ExtractedReference[] = [];

  /**
   * Find the first type_identifier in a subtree (for type annotations,
   * extends/implements clauses).
   */
  function findTypeIdentifier(node: Parser.SyntaxNode): string | null {
    if (node.type === "type_identifier" || node.type === "identifier") {
      return node.text;
    }
    for (const child of node.children) {
      const found = findTypeIdentifier(child);
      if (found) return found;
    }
    return null;
  }

  function walk(node: Parser.SyntaxNode, enclosingSymbol: string | null): void {
    // Update enclosing symbol context for function/method/class declarations
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        const name = node.childForFieldName("name");
        const newEnclosing = name?.text ?? enclosingSymbol;
        for (const child of node.children) walk(child, newEnclosing);
        return;
      }
      case "method_definition": {
        const name = node.childForFieldName("name");
        const newEnclosing = name?.text ?? enclosingSymbol;
        for (const child of node.children) walk(child, newEnclosing);
        return;
      }
      case "class_declaration": {
        const name = node.childForFieldName("name");
        const newEnclosing = name?.text ?? enclosingSymbol;

        // Check for extends/implements clauses
        for (const child of node.children) {
          if (child.type === "extends_clause") {
            const typeName = findTypeIdentifier(child);
            if (typeName) {
              refs.push({ sourceSymbol: newEnclosing, targetName: typeName, kind: "type_ref", line: child.startPosition.row });
            }
          } else if (child.type === "implements_clause") {
            // Implements can have multiple types
            for (const implChild of child.children) {
              const typeName = findTypeIdentifier(implChild);
              if (typeName && typeName !== "implements") {
                refs.push({ sourceSymbol: newEnclosing, targetName: typeName, kind: "type_ref", line: implChild.startPosition.row });
              }
            }
          }
        }

        for (const child of node.children) walk(child, newEnclosing);
        return;
      }
      case "arrow_function": {
        // Arrow functions: enclosing symbol is already set by variable declarator walk
        for (const child of node.children) walk(child, enclosingSymbol);
        return;
      }
    }

    // Extract references
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        if (fn.type === "member_expression") {
          // obj.method() -> member_call
          const prop = fn.childForFieldName("property");
          if (prop) {
            refs.push({
              sourceSymbol: enclosingSymbol,
              targetName: prop.text,
              kind: "member_call",
              line: node.startPosition.row,
            });
          }
        } else if (fn.type === "identifier") {
          // directCall() -> call
          refs.push({
            sourceSymbol: enclosingSymbol,
            targetName: fn.text,
            kind: "call",
            line: node.startPosition.row,
          });
        }
      }
    }

    // Type annotations: param: Type, variable: Type, return type
    if (node.type === "type_annotation") {
      const typeName = findTypeIdentifier(node);
      if (typeName) {
        refs.push({
          sourceSymbol: enclosingSymbol,
          targetName: typeName,
          kind: "type_ref",
          line: node.startPosition.row,
        });
      }
    }

    // Recurse into children (unless already handled above)
    for (const child of node.children) {
      walk(child, enclosingSymbol);
    }
  }

  walk(root, null);
  return refs;
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

// --- Python reference extraction ---

/**
 * Extract symbol-level references from a Python AST.
 * Identifies function calls, method calls, type annotations, and class inheritance.
 */
function extractPythonReferences(root: Parser.SyntaxNode): ExtractedReference[] {
  const refs: ExtractedReference[] = [];

  function walk(node: Parser.SyntaxNode, enclosingSymbol: string | null): void {
    // Update enclosing symbol context
    if (node.type === "function_definition") {
      const name = node.childForFieldName("name");
      const newEnclosing = name?.text ?? enclosingSymbol;

      // Check return type annotation: def foo() -> ReturnType
      const returnType = node.childForFieldName("return_type");
      if (returnType) {
        const typeName = findPythonTypeIdentifier(returnType);
        if (typeName) {
          refs.push({ sourceSymbol: newEnclosing, targetName: typeName, kind: "type_ref", line: returnType.startPosition.row });
        }
      }

      for (const child of node.children) walk(child, newEnclosing);
      return;
    }

    if (node.type === "class_definition") {
      const name = node.childForFieldName("name");
      const newEnclosing = name?.text ?? enclosingSymbol;

      // Extract superclasses as type_ref: class Foo(Base, Mixin)
      const superclasses = node.childForFieldName("superclasses");
      if (superclasses) {
        for (const child of superclasses.children) {
          if (child.type === "identifier") {
            refs.push({ sourceSymbol: newEnclosing, targetName: child.text, kind: "type_ref", line: child.startPosition.row });
          }
        }
      }

      for (const child of node.children) walk(child, newEnclosing);
      return;
    }

    // Extract function/method calls
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (fn) {
        if (fn.type === "identifier") {
          refs.push({ sourceSymbol: enclosingSymbol, targetName: fn.text, kind: "call", line: node.startPosition.row });
        } else if (fn.type === "attribute") {
          const attr = fn.childForFieldName("attribute");
          if (attr) {
            refs.push({ sourceSymbol: enclosingSymbol, targetName: attr.text, kind: "member_call", line: node.startPosition.row });
          }
        }
      }
    }

    // Extract type annotations: param: Type, var: Type
    if (node.type === "type") {
      const typeName = findPythonTypeIdentifier(node);
      if (typeName) {
        refs.push({ sourceSymbol: enclosingSymbol, targetName: typeName, kind: "type_ref", line: node.startPosition.row });
      }
    }

    for (const child of node.children) {
      walk(child, enclosingSymbol);
    }
  }

  walk(root, null);
  return refs;
}

/**
 * Find the first identifier in a Python type annotation subtree.
 */
function findPythonTypeIdentifier(node: Parser.SyntaxNode): string | null {
  if (node.type === "identifier") return node.text;
  for (const child of node.children) {
    const found = findPythonTypeIdentifier(child);
    if (found) return found;
  }
  return null;
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

// --- Go reference extraction ---

/**
 * Extract symbol-level references from a Go AST.
 * Identifies function calls, selector (method) calls, and type identifier references.
 */
function extractGoReferences(root: Parser.SyntaxNode): ExtractedReference[] {
  const refs: ExtractedReference[] = [];

  function walk(node: Parser.SyntaxNode, enclosingSymbol: string | null): void {
    // Update enclosing symbol context
    if (node.type === "function_declaration") {
      const name = node.childForFieldName("name");
      const newEnclosing = name?.text ?? enclosingSymbol;
      for (const child of node.children) walk(child, newEnclosing);
      return;
    }

    if (node.type === "method_declaration") {
      const name = node.childForFieldName("name");
      const newEnclosing = name?.text ?? enclosingSymbol;
      for (const child of node.children) walk(child, newEnclosing);
      return;
    }

    // Extract function/method calls
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        if (fn.type === "identifier") {
          refs.push({ sourceSymbol: enclosingSymbol, targetName: fn.text, kind: "call", line: node.startPosition.row });
        } else if (fn.type === "selector_expression") {
          const field = fn.childForFieldName("field");
          if (field) {
            refs.push({ sourceSymbol: enclosingSymbol, targetName: field.text, kind: "member_call", line: node.startPosition.row });
          }
        }
      }
    }

    // Extract type_identifier references (skip definitions in type_spec)
    if (node.type === "type_identifier") {
      const parentType = node.parent?.type;
      if (parentType !== "type_spec") {
        refs.push({ sourceSymbol: enclosingSymbol, targetName: node.text, kind: "type_ref", line: node.startPosition.row });
      }
    }

    for (const child of node.children) {
      walk(child, enclosingSymbol);
    }
  }

  walk(root, null);
  return refs;
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

// --- Rust reference extraction ---

/**
 * Extract symbol-level references from a Rust AST.
 * Identifies function calls, method calls, scoped calls (Vec::new),
 * and type identifier references including impl/trait targets.
 */
function extractRustReferences(root: Parser.SyntaxNode): ExtractedReference[] {
  const refs: ExtractedReference[] = [];
  const definitionNodeTypes = new Set(["struct_item", "enum_item", "trait_item", "type_item"]);

  function walk(node: Parser.SyntaxNode, enclosingSymbol: string | null): void {
    // Update enclosing symbol context
    if (node.type === "function_item") {
      const name = node.childForFieldName("name");
      const newEnclosing = name?.text ?? enclosingSymbol;
      for (const child of node.children) walk(child, newEnclosing);
      return;
    }

    if (node.type === "impl_item") {
      // Extract impl target type: impl Server { ... }
      const typeNode = node.childForFieldName("type");
      if (typeNode?.type === "type_identifier") {
        refs.push({ sourceSymbol: enclosingSymbol, targetName: typeNode.text, kind: "type_ref", line: typeNode.startPosition.row });
      }

      // Extract trait in impl Trait for Type
      const traitNode = node.childForFieldName("trait");
      if (traitNode) {
        const traitName = findRustTypeIdentifier(traitNode);
        if (traitName) {
          refs.push({ sourceSymbol: enclosingSymbol, targetName: traitName, kind: "type_ref", line: traitNode.startPosition.row });
        }
      }

      // Walk body with same enclosing (functions inside will set their own)
      for (const child of node.children) walk(child, enclosingSymbol);
      return;
    }

    // Extract function calls: foo(), Vec::new(), obj.method()
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      if (fn) {
        if (fn.type === "identifier") {
          refs.push({ sourceSymbol: enclosingSymbol, targetName: fn.text, kind: "call", line: node.startPosition.row });
        } else if (fn.type === "field_expression") {
          const field = fn.childForFieldName("field");
          if (field) {
            refs.push({ sourceSymbol: enclosingSymbol, targetName: field.text, kind: "member_call", line: node.startPosition.row });
          }
        } else if (fn.type === "scoped_identifier") {
          // Vec::new() — extract last identifier segment
          const lastIdent = findLastIdentifier(fn);
          if (lastIdent) {
            refs.push({ sourceSymbol: enclosingSymbol, targetName: lastIdent, kind: "call", line: node.startPosition.row });
          }
        }
      }
    }

    // Rust-specific method call syntax: receiver.method(args)
    if (node.type === "method_call_expression") {
      const method = node.childForFieldName("method");
      if (method) {
        refs.push({ sourceSymbol: enclosingSymbol, targetName: method.text, kind: "member_call", line: node.startPosition.row });
      }
    }

    // Extract type_identifier references (skip definition sites)
    if (node.type === "type_identifier") {
      const parentType = node.parent?.type;
      if (!definitionNodeTypes.has(parentType ?? "")) {
        refs.push({ sourceSymbol: enclosingSymbol, targetName: node.text, kind: "type_ref", line: node.startPosition.row });
      }
    }

    for (const child of node.children) {
      walk(child, enclosingSymbol);
    }
  }

  walk(root, null);
  return refs;
}

/**
 * Find the first type_identifier in a Rust subtree (for trait bounds, etc.).
 */
function findRustTypeIdentifier(node: Parser.SyntaxNode): string | null {
  if (node.type === "type_identifier" || node.type === "identifier") return node.text;
  for (const child of node.children) {
    const found = findRustTypeIdentifier(child);
    if (found) return found;
  }
  return null;
}

/**
 * Find the last identifier child in a scoped_identifier (e.g., Vec::new → "new").
 */
function findLastIdentifier(node: Parser.SyntaxNode): string | null {
  let last: string | null = null;
  for (const child of node.children) {
    if (child.type === "identifier") last = child.text;
  }
  return last;
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
