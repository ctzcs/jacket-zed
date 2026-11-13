(identifier) @variable

[
  "if" "ifx" "then" "else" "for" "while" "case" "break" "continue"
  "return" "defer" "using" "remove" "cast" "type_of" "inline" "no_inline"
  "struct" "union" "enum" "enum_flags" "operator" "push_context" "interface"
] @keyword

(types) @type
(struct_declaration (identifier) @type)
(enum_declaration (identifier) @type)
(parameter (identifier) @variable.parameter)
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
