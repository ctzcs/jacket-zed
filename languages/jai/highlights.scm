(identifier) @variable

[
  "if" "ifx" "then" "else" "for" "while" "case" "break" "continue"
  "return" "defer" "using" "remove" "cast" "type_of" "inline" "no_inline"
  "struct" "union" "enum" "enum_flags" "operator" "push_context" "interface"
] @keyword

; Capture the identifier itself: a broad parent capture can be hidden by
; the generic @variable capture on its children.
(types (identifier) @type)
(identifier_type (identifier) @type)
(member_type "." (identifier) @type)
(member_type_in_procedure_returns "." (identifier) @type)
(parameterized_struct_type type: (identifier) @type)
(struct_declaration (identifier) @type)
(enum_declaration (identifier) @type)
(parameter name: (identifier) @variable.parameter)
(struct_or_union_block
  (variable_declaration (identifier) @property ":"))
(struct_or_union_block
  (const_declaration (identifier) @constant ":"))
(procedure_declaration (identifier) @function)
(call_expression function: (identifier) @function)
(member_expression "." (identifier) @property)
(enum_field (identifier) @constant)

(integer) @number
(float) @number
(boolean) @boolean
(null) @constant.builtin
(uninitialized) @constant.builtin
(string) @string
(heredoc_body) @string
(string_contents (escape_sequence) @string.escape)
(note) @attribute
(compiler_directive) @preproc
[(import) (load)] @preproc
[(comment) (block_comment)] @comment

["{" "}" "(" ")" "[" "]"] @punctuation.bracket
[";" "," "." "->"] @punctuation.delimiter
[":" "=" "+" "-" "*" "/" "%" "==" "!=" "<" ">" "<=" ">=" "!" "&&" "||" "&" "|" "~" ".."] @operator
