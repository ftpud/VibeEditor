import type { Monaco } from "@monaco-editor/react";
import { readSetting } from "./settings";

export type AppTheme = "dark" | "light";
export type HighlightTheme = "default" | "ftpud";

export function currentTheme(): AppTheme {
  return readSetting("theme") === "light" ? "light" : "dark";
}

export function currentHighlightTheme(): HighlightTheme {
  const value = readSetting("highlightTheme");
  return value === "ftpud" || value === "ftpud-dark" ? "ftpud" : "default";
}

export function monacoTheme(appTheme = currentTheme(), highlightTheme = currentHighlightTheme()): "light" | "vs-dark" | "ftpud" | "ftpud-dark" {
  return highlightTheme === "ftpud" ? (appTheme === "dark" ? "ftpud-dark" : "ftpud") : appTheme === "light" ? "light" : "vs-dark";
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
      { token: "function", foreground: "000000", fontStyle: "bold" },
      { token: "function.declaration", foreground: "00627A", fontStyle: "bold" },
      { token: "method", foreground: "000000", fontStyle: "bold" },
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
      { token: "comment", foreground: "69756D", background: "DCEEE3", fontStyle: "italic" },
      { token: "comment.doc", foreground: "69756D", background: "DCEEE3", fontStyle: "italic" },
      { token: "string", foreground: "167029", background: "EAF6EE", fontStyle: "bold" },
      { token: "string.escape", foreground: "167029", background: "EAF6EE", fontStyle: "bold" },
      { token: "string.quoted", foreground: "167029", background: "EAF6EE", fontStyle: "bold" },
      { token: "type", foreground: "17243A", background: "DCE8FA" },
      { token: "type.identifier", foreground: "17243A", background: "DCE8FA" },
      { token: "class", foreground: "17243A", background: "DCE8FA" },
      { token: "class.declaration", foreground: "17243A", background: "DCE8FA" },
      { token: "interface", foreground: "3A2A1D", background: "F5E6D8" },
      { token: "interface.declaration", foreground: "3A2A1D", background: "F5E6D8" },
      { token: "annotation", foreground: "687000", background: "E8F2E3" },
      { token: "annotation.name", foreground: "687000", background: "E8F2E3" },
      { token: "constant", foreground: "6A2775", background: "E8F2E3", fontStyle: "bold italic" },
      { token: "variable.constant", foreground: "6A2775", background: "E8F2E3", fontStyle: "bold italic" },
      { token: "field.static.readonly", foreground: "6A2775", background: "E8F2E3", fontStyle: "bold italic" },
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
  monaco.editor.defineTheme("ftpud-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "", foreground: "D4D4D4", background: "1E1F22" },
      { token: "identifier", foreground: "D4D4D4" },
      { token: "keyword", foreground: "7AA2F7" },
      { token: "number", foreground: "8DB6FF" },
      { token: "attribute", foreground: "82AAFF" },
      { token: "entity", foreground: "82AAFF" },
      { token: "property", foreground: "D9A0E8" },
      { token: "variable.predefined", foreground: "7AA2F7" },
      { token: "function", foreground: "F0F0F0", fontStyle: "bold" },
      { token: "function.declaration", foreground: "80D8E8", fontStyle: "bold" },
      { token: "method", foreground: "F0F0F0", fontStyle: "bold" },
      { token: "method.declaration", foreground: "F0F0F0", fontStyle: "bold" },
      { token: "method.extension", fontStyle: "bold" },
      { token: "method.static", foreground: "80D8E8", fontStyle: "bold italic" },
      { token: "constructor.declaration", foreground: "F0F0F0", fontStyle: "bold" },
      { token: "comment", foreground: "99A39B", background: "293A32", fontStyle: "italic" },
      { token: "comment.doc", foreground: "99A39B", background: "293A32", fontStyle: "italic" },
      { token: "string", foreground: "9AC8A2", background: "293D30", fontStyle: "bold" },
      { token: "string.escape", foreground: "9AC8A2", background: "293D30", fontStyle: "bold" },
      { token: "string.quoted", foreground: "9AC8A2", background: "293D30", fontStyle: "bold" },
      { token: "type", foreground: "CBD8E8", background: "29384A" },
      { token: "type.identifier", foreground: "CBD8E8", background: "29384A" },
      { token: "class", foreground: "CBD8E8", background: "29384A" },
      { token: "class.declaration", foreground: "CBD8E8", background: "29384A" },
      { token: "interface", foreground: "DDCDBE", background: "49392D" },
      { token: "interface.declaration", foreground: "DDCDBE", background: "49392D" },
      { token: "annotation", foreground: "C2C07E", background: "304231" },
      { token: "annotation.name", foreground: "C2C07E", background: "304231" },
      { token: "constant", foreground: "CAA2D1", background: "304231", fontStyle: "bold italic" },
      { token: "variable.constant", foreground: "CAA2D1", background: "304231", fontStyle: "bold italic" },
      { token: "field.static.readonly", foreground: "CAA2D1", background: "304231", fontStyle: "bold italic" },
      { token: "invalid", background: "8B3037" }
    ],
    colors: {
      "editor.background": "#1E1F22",
      "editor.foreground": "#D4D4D4",
      "editor.lineHighlightBackground": "#26282D",
      "editorLineNumber.foreground": "#60636B",
      "editorLineNumber.activeForeground": "#A4A7AE",
      "editor.selectionBackground": "#365880",
      "editor.inactiveSelectionBackground": "#2B405B",
      "editorIndentGuide.background1": "#34363B",
      "editorIndentGuide.activeBackground1": "#5A5D65",
      "editorGutter.background": "#1E1F22",
      "editor.foldBackground": "#294333",
      "editorBracketMatch.background": "#31595B",
      "editorBracketMatch.border": "#65AEB0",
      "diffEditor.insertedLineBackground": "#203B2A88",
      "diffEditor.removedLineBackground": "#41272B88",
      "diffEditor.insertedTextBackground": "#315B3C99",
      "diffEditor.removedTextBackground": "#66343A99"
    }
  });
}
