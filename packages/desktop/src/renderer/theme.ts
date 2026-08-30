import type { Monaco } from "@monaco-editor/react";
import { readSetting } from "./settings";

export type AppTheme = "dark" | "light";
export type HighlightTheme = "default" | "ftpud";

export function currentTheme(): AppTheme {
  return readSetting("theme") === "light" ? "light" : "dark";
}

export function currentHighlightTheme(): HighlightTheme {
  return readSetting("highlightTheme") === "ftpud" ? "ftpud" : "default";
}

export function monacoTheme(appTheme = currentTheme(), highlightTheme = currentHighlightTheme()): "light" | "vs-dark" | "ftpud" {
  return highlightTheme === "ftpud" ? "ftpud" : appTheme === "light" ? "light" : "vs-dark";
}

export function configureMonacoThemes(monaco: Monaco): void {
  if (!monaco.languages.getLanguages().some((language) => language.id === "sap-cds")) {
    monaco.languages.register({ id: "sap-cds", extensions: [".cds"], aliases: ["SAP CDS", "CDS"] });
    monaco.languages.setLanguageConfiguration("sap-cds", {
      comments: { lineComment: "//", blockComment: ["/*", "*/"] },
      brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
      autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: "'", close: "'" }, { open: "\"", close: "\"" }]
    });
    monaco.languages.setMonarchTokensProvider("sap-cds", {
      defaultToken: "identifier",
      ignoreCase: true,
      keywords: ["namespace", "using", "from", "as", "entity", "aspect", "type", "service", "context", "action", "function", "event", "projection", "on", "select", "distinct", "key", "association", "composition", "to", "many", "one", "localized", "enum", "annotate", "extend", "with", "returns", "array", "of", "not", "null", "default", "virtual", "masked", "redirected", "excluding", "where", "group", "by", "having", "order", "asc", "desc", "limit", "offset", "mixin", "into", "case", "when", "then", "else", "end", "cast"],
      typeKeywords: ["String", "Integer", "Integer64", "Decimal", "DecimalFloat", "Double", "Date", "Time", "DateTime", "Timestamp", "Boolean", "UUID", "LargeString", "Binary", "LargeBinary", "Association", "Composition"],
      operators: ["=", ">", "<", "!", "~", "?", ":", "==", "<=", ">=", "!=", "&&", "||", "+", "-", "*", "/"],
      tokenizer: {
        root: [
          [/@[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/, "annotation"],
          [/[A-Za-z_$][\w$]*/, { cases: { "@typeKeywords": "type", "@keywords": "keyword", "@default": "identifier" } }],
          [/\$[A-Za-z_$][\w$]*/, "variable.predefined"],
          [/0[xX][0-9a-fA-F]+/, "number.hex"],
          [/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
          [/\/\*/, "comment", "@comment"],
          [/\/\/.*$/, "comment"],
          [/'/, "string", "@singleString"],
          [/"/, "string", "@doubleString"],
          [/[{}()\[\]]/, "@brackets"],
          [/[;,.]/, "delimiter"],
          [/[=><!~?:&|+\-*\/]+/, "operator"]
        ],
        comment: [[/[^/*]+/, "comment"], [/\*\//, "comment", "@pop"], [/[/*]/, "comment"]],
        singleString: [[/[^'\\]+/, "string"], [/\\./, "string.escape"], [/''/, "string.escape"], [/'/, "string", "@pop"]],
        doubleString: [[/[^"\\]+/, "string"], [/\\./, "string.escape"], [/""/, "string.escape"], [/"/, "string", "@pop"]]
      }
    });
  }
  monaco.editor.defineTheme("ftpud", {
    base: "vs",
    inherit: true,
    rules: [
      // Light.icls fallback palette. Ftpud2-specific rules below take precedence.
      { token: "", foreground: "000000", background: "FFFFFF" },
      { token: "identifier", foreground: "000000" },
      { token: "keyword", foreground: "0033B3" },
      { token: "number", foreground: "1750EB" },
      { token: "attribute", foreground: "174AD4" },
      { token: "entity", foreground: "174BE6" },
      { token: "tag", foreground: "000000" },
      { token: "regexp", foreground: "264EFF" },
      { token: "variable", foreground: "000000" },
      { token: "variable.predefined", foreground: "0033B3" },
      { token: "property", foreground: "871094" },
      { token: "function", foreground: "000000" },
      { token: "function.declaration", foreground: "00627A" },
      { token: "method", foreground: "000000" },
      { token: "method.static", foreground: "00627A", fontStyle: "italic" },
      { token: "constant", foreground: "871094", fontStyle: "italic" },
      { token: "variable.constant", foreground: "871094", fontStyle: "italic" },
      { token: "annotation", foreground: "9E880D" },
      { token: "metadata", foreground: "9E880D" },
      { token: "comment", foreground: "8C8C8C", fontStyle: "italic" },
      { token: "comment.doc", foreground: "8C8C8C", fontStyle: "italic" },
      { token: "string", foreground: "067D17" },
      { token: "string.escape", foreground: "0037A6" },
      { token: "string.escape.invalid", foreground: "067D17", background: "FFCCCC" },
      // Explicit Ftpud2.icls overrides, including their text backgrounds.
      { token: "comment", foreground: "8C8C8C", background: "9EDDB9", fontStyle: "italic" },
      { token: "comment.doc", foreground: "8C8C8C", background: "9EDDB9", fontStyle: "italic" },
      { token: "string", foreground: "008000", background: "DDFFE9", fontStyle: "bold" },
      { token: "string.escape", foreground: "008000", background: "DDFFE9", fontStyle: "bold" },
      { token: "string.quoted", foreground: "008000", background: "DDFFE9", fontStyle: "bold" },
      { token: "type", foreground: "000000", background: "B0CCFF" },
      { token: "type.identifier", foreground: "000000", background: "B0CCFF" },
      { token: "class", foreground: "000000", background: "B0CCFF" },
      { token: "class.declaration", foreground: "000000", background: "B0CCFF" },
      { token: "interface", foreground: "000000", background: "FFD8B5" },
      { token: "interface.declaration", foreground: "000000", background: "FFD8B5" },
      { token: "annotation", foreground: "808000", background: "E3FFD4" },
      { token: "annotation.name", foreground: "808000", background: "E3FFD4" },
      { token: "constant", foreground: "660E7A", background: "E3FFD4", fontStyle: "bold italic" },
      { token: "variable.constant", foreground: "660E7A", background: "E3FFD4", fontStyle: "bold italic" },
      { token: "field.static.readonly", foreground: "660E7A", background: "E3FFD4", fontStyle: "bold italic" },
      { token: "constructor.declaration", foreground: "000000", fontStyle: "bold" },
      { token: "method.declaration", foreground: "000000", fontStyle: "bold" },
      { token: "method.extension", fontStyle: "bold" },
      { token: "method.static", foreground: "000000", fontStyle: "italic" },
      { token: "invalid", background: "FF6269" }
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#000000",
      "editor.lineHighlightBackground": "#F5F8FE",
      "editorLineNumber.foreground": "#AEB3C2",
      "editorLineNumber.activeForeground": "#767A8A",
      "editor.selectionBackground": "#A6D2FF",
      "editor.inactiveSelectionBackground": "#D7E9FB",
      "editorIndentGuide.background1": "#EBECF0",
      "editorIndentGuide.activeBackground1": "#AEB3C2",
      "editorRuler.foreground": "#EBECF0",
      "editorWhitespace.foreground": "#D4D4D4",
      "editorGutter.background": "#FFFFFF",
      "editor.foldBackground": "#E9F5E6",
      "editorBracketMatch.background": "#C9ECEC",
      "editorBracketMatch.border": "#62B3B3",
      "editorOverviewRuler.addedForeground": "#7FC784",
      "editorOverviewRuler.modifiedForeground": "#88ADF7",
      "editorOverviewRuler.deletedForeground": "#767A8A",
      "diffEditor.insertedLineBackground": "#E8F5E9",
      "diffEditor.removedLineBackground": "#F1F2F4",
      "diffEditor.insertedTextBackground": "#CBE8CE",
      "diffEditor.removedTextBackground": "#D9DBE0",
      "editorError.background": "#FF1100",
      "editorError.foreground": "#FF0000",
      "editorOverviewRuler.errorForeground": "#CF5B56"
    }
  });
}
