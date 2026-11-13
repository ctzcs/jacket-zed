(procedure_declaration) @function.around
(procedure_declaration
  (block "{" (_)* @function.inside "}"))

(struct_declaration) @class.around
(struct_declaration
  (struct_or_union
    (struct_or_union_block "{" (_)* @class.inside "}")))
(enum_declaration) @class.around
(enum_declaration "{" (enum_field)* @class.inside "}")

(comment)+ @comment.around
(block_comment) @comment.around
