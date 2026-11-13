use tree_sitter_language::LanguageFn;

extern "C" {
    fn tree_sitter_jai() -> *const ();
}

// 测试辅助绑定：与 extension.toml 中的语法提交一致。
pub const LANGUAGE: LanguageFn = unsafe { LanguageFn::from_raw(tree_sitter_jai) };
