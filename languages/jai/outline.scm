; Navigation fallback when LSP document_symbols is off (no paired hierarchy).
((comment) @name
  (#match? @name "^//[ \\t]*@region[ \\t]+[^ \\t\\r\\n]")) @item

(procedure_declaration (identifier) @name) @item
(struct_declaration (identifier) @name) @item
(enum_declaration (identifier) @name) @item
